// Subaru Log Viewer — PRO 1.0
// Slider, seconds-on-x, two-finger pinch-zoom (stable), clamp to edges, sticky marker, fast updates.

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const columnsContainer = document.getElementById('columnsContainer');
  const resetZoomBtn = document.getElementById('resetZoomBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const deselectAllBtn = document.getElementById('deselectAllBtn');
  const plotsContainer = document.getElementById('plotsContainer');
  const markerBox = document.getElementById('markerData');
  const status = document.getElementById('status');
  const hSlider = document.getElementById('hSlider');

  let parsed = null;         // {fields:[], data:[], time0: number}
  let plotMeta = [];         // {div, col, xValsSec, yVals}
  let markerX = null;
  let syncTimer = null;

  // config: no modebar, no one-finger zoom
  const PLOT_CONFIG = {displayModeBar:false,responsive:true,scrollZoom:false};

  function setStatus(msg, ok=true){
    status.textContent = msg;
    status.style.color = ok ? '#064e3b' : '#b91c1c';
  }

  function detectDelimiter(text){
    const lines = text.split(/\r\n|\n|\r/).filter(l=>l.trim()).slice(0,5);
    let comma=0, semi=0;
    lines.forEach(l=>{ comma += (l.match(/,/g)||[]).length; semi += (l.match(/;/g)||[]).length; });
    return semi>comma?';':',';
  }

  function splitLine(line, delim){
    const res=[]; let cur=''; let inQ=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch === '"'){ inQ = !inQ; continue; }
      if(!inQ && ch===delim){ res.push(cur); cur=''; } else cur+=ch;
    }
    res.push(cur);
    return res.map(s=>s.replace(/^\uFEFF|\u200B/g,'').trim());
  }

  // Time parsing: try numeric (seconds or ms) else Date.parse. Return seconds (float).
  function parseTimeToSec(value, baseMs){
    if(value===null || value===undefined) return null;
    const s = String(value).trim();
    // numeric?
    const n = Number(s);
    if(!Number.isNaN(n)){
      // assume if large (ms) -> convert
      if(Math.abs(n) > 1e9) return (n - baseMs)/1000; // ms timestamp
      return n; // already seconds
    }
    const d = Date.parse(s);
    if(!Number.isNaN(d)) return (d - baseMs)/1000;
    return null;
  }

  function parseCSVText(text){
    const delim = detectDelimiter(text);
    const lines = text.split(/\r\n|\n|\r/);
    // trim empty lines
    const good = lines.filter(l=>l.trim());
    if(good.length < 2) throw new Error('CSV слишком короткий');
    const header = splitLine(good[0], delim);
    const data = [];
    for(let i=1;i<good.length;i++){
      const vals = splitLine(good[i], delim);
      const obj = {};
      for(let j=0;j<header.length;j++) obj[header[j]] = vals[j] ?? null;
      data.push(obj);
    }
    // find time column index
    const timeCol = header.find(h => /time|timestamp|date|utc/i.test(h)) || header[0];
    // compute base (ms) using first accessible time
    let baseMs = Date.now();
    const firstRaw = data.find(r => r[timeCol] !== null && r[timeCol] !== undefined);
    if(firstRaw){
      const tv = firstRaw[timeCol];
      const n = Number(String(tv).trim());
      if(!Number.isNaN(n) && Math.abs(n) > 1e9) baseMs = n; else {
        const pd = Date.parse(String(tv));
        if(!Number.isNaN(pd)) baseMs = pd; else baseMs = Date.now();
      }
    }
    // compute sec offsets and keep original time string
    data.forEach((row, i)=>{
      const raw = row[timeCol];
      const sec = parseTimeToSec(raw, baseMs);
      row.__sec = (sec===null)? i : sec; // fallback to index if parse fail
      row.__timestr = String(raw);
    });

    return { fields: header, data: data, timeColumn: timeCol, baseMs };
  }

  function buildColumnList(cols){
    columnsContainer.innerHTML = '';
    cols.forEach((c, idx)=>{
      if(/time|timestamp|date|utc/i.test(c)) return;
      const item = document.createElement('div'); item.className='column-item';
      const chk = document.createElement('input'); chk.type='checkbox'; chk.dataset.col = c; chk.id = 'col_'+idx;
      if(/afr|rpm|maf|inj|duty|boost|press/i.test(c)) chk.checked = true;
      const lbl = document.createElement('label'); lbl.htmlFor = chk.id; lbl.textContent = c;
      item.append(chk, lbl);
      columnsContainer.appendChild(item);
      chk.addEventListener('change', ()=> buildPlots());
    });
  }

  // clamp x range to [min,max]
  function clampRange(start, end, min, max){
    let s = start, e = end;
    const width = e - s;
    if(width <= 0) return [min, max];
    if(s < min){ s = min; e = s + width; }
    if(e > max){ e = max; s = e - width; }
    if(s < min) s = min;
    return [s,e];
  }

  function applyRangeToAll(range){
    plotMeta.forEach(m => {
      Plotly.relayout(m.div, {'xaxis.range': range}).catch(()=>{});
    });
    // update slider position: center percent
    const min = plotMeta[0].xMin, max = plotMeta[0].xMax;
    const center = (range[0] + range[1]) / 2;
    const pct = 100 * (center - min) / (max - min);
    hSlider.value = Math.max(0, Math.min(100, pct));
  }

  // draw vertical red line only on target div immediately, later sync all
  function drawMarkerFast(targetDiv, xVal){
    Plotly.relayout(targetDiv, {
      shapes: [{ type:'line', x0:xVal, x1:xVal, y0:0, y1:1, xref:'x', yref:'paper', line:{color:'#ef4444', width:1.5} }]
    }).catch(()=>{});
  }

  function drawMarkersAllDebounced(xVal){
    clearTimeout(syncTimer);
    syncTimer = setTimeout(()=>{
      const range = null; // keep current xaxis.range
      plotMeta.forEach(m => {
        Plotly.relayout(m.div, {
          shapes: [{ type:'line', x0:xVal, x1:xVal, y0:0, y1:1, xref:'x', yref:'paper', line:{color:'#ef4444', width:1.5} }]
        }).catch(()=>{});
      });
    }, 40);
  }

  // slider controlling center position
  hSlider.addEventListener('input', ()=>{
    if(!plotMeta.length) return;
    const min = plotMeta[0].xMin, max = plotMeta[0].xMax;
    const pct = Number(hSlider.value)/100;
    const currRange = plotMeta[0].lastRange || [min, Math.min(max, min + (max-min)/6)];
    const width = currRange[1] - currRange[0];
    let center = min + pct*(max-min);
    let newRange = [center - width/2, center + width/2];
    newRange = clampRange(newRange[0], newRange[1], min, max);
    applyRangeToAll(newRange);
  });

  // pinch zoom implementation (two-finger)
  function attachPinchHandlers(div, meta){
    let lastDist = null;
    let anchorCenter = null;

    function getDist(touches){
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx,dy);
    }
    function getCenterX(touches){
      return (touches[0].clientX + touches[1].clientX)/2;
    }

    div.addEventListener('touchstart', (ev)=>{
      if(ev.touches.length === 2){
        lastDist = getDist(ev.touches);
        anchorCenter = getCenterX(ev.touches);
      } else lastDist = null;
    }, {passive:true});

    div.addEventListener('touchmove', (ev)=>{
      if(ev.touches.length !== 2 || lastDist === null) return;
      const d = getDist(ev.touches);
      const scale = d / lastDist;
      lastDist = d;

      // current x axis range
      const xaxis = div._fullLayout && div._fullLayout.xaxis;
      if(!xaxis) return;
      const curr0 = xaxis.range ? xaxis.range[0] : xaxis._rl0 || xaxis.range;
      const curr1 = xaxis.range ? xaxis.range[1] : xaxis._rl1 || xaxis.range;
      const centerPixel = anchorCenter;
      // convert pixel to xVal: use _fullLayout.xaxis.l2p and p2l inverses
      const xr = xaxis._rl || [xaxis.range[0], xaxis.range[1]];
      const xMin = meta.xMin, xMax = meta.xMax;
      // compute new width scaled
      const currWidth = curr1 - curr0;
      let newWidth = currWidth / scale;
      // keep center at current center (approx)
      const center = (curr0 + curr1)/2;
      let s = center - newWidth/2, e = center + newWidth/2;
      [s,e] = clampRange(s,e,xMin,xMax);
      applyRangeToAll([s,e]);
      // prevent default to avoid browser pinch zoom
      ev.preventDefault();
    }, {passive:false});
  }

  // build plots or rebuild when columns change
  function buildPlots(){
    if(!parsed) return;
    const xKey = '__sec';
    const checked = [...columnsContainer.querySelectorAll('input[type=checkbox]:checked')].map(i=>i.dataset.col);
    if(checked.length === 0) { plotsContainer.innerHTML=''; plotMeta = []; return; }

    plotsContainer.innerHTML = '';
    plotMeta = [];

    // prepare x array (seconds)
    const xArr = parsed.data.map(r => r.__sec);
    const xMin = Math.min(...xArr), xMax = Math.max(...xArr);

    checked.forEach((col, idx)=>{
      const yArr = parsed.data.map(r => {
        const v = r[col];
        const n = parseFloat(String(v ?? '').replace(',','.'));
        return isNaN(n) ? null : n;
      });

      const div = document.createElement('div');
      div.className = 'plot';
      plotsContainer.appendChild(div);

      const trace = { x: xArr, y: yArr, mode:'lines', name:col, line:{width:2.8} };
      const layout = {
        title: col,
        margin:{t:38,l:50,b:44,r:10},
        xaxis:{title:'s', tickformat:'.3f', automargin:true},
        yaxis:{fixedrange:true}
      };

      Plotly.newPlot(div, [trace], layout, PLOT_CONFIG).then(() => {
        // store meta
        const meta = { div, col, xMin, xMax, lastRange:[xMin, Math.min(xMax, xMin + (xMax-xMin)/6)] };
        plotMeta.push(meta);

        // attach handlers
        const handle = ev => {
          const p = ev.points && ev.points[0];
          if(!p) return;
          markerX = p.x;
          const rowIndex = p.pointNumber;
          updateMarkerBox(rowIndex);
          drawMarkerFast(ev.event.currentTarget || div, markerX);
          drawMarkersAllDebounced(markerX); // sync to others (no numbers)
        };

        div.on('plotly_click', handle);
        div.on('plotly_hover', handle);
        div.on('plotly_relayout', ev => {
          // sync x range across all plots when user pans/zooms using plotly gestures
          if(ev['xaxis.range[0]'] !== undefined && ev['xaxis.range[1]'] !== undefined){
            const r = [ev['xaxis.range[0]'], ev['xaxis.range[1]']];
            // clamp
            const [s,e] = clampRange(r[0], r[1], xMin, xMax);
            applyRangeToAll([s,e]);
            plotMeta.forEach(m=> m.lastRange = [s,e]);
          } else if(ev['xaxis.autorange'] !== undefined){
            applyRangeToAll([xMin, xMax]);
            plotMeta.forEach(m=> m.lastRange = [xMin,xMax]);
          }
        });

        // attach pinch handlers (custom)
        attachPinchHandlers(div, meta);

        // initialize with small window centered at start
        if(idx === 0){
          const initW = Math.min(xMax - xMin, (xMax - xMin) / 6);
          const range = [xMin, xMin + initW];
          applyRangeToAll(range);
          plotMeta.forEach(m => m.lastRange = range);
        }
      }).catch(()=>{});
    });

    resetZoomBtn.disabled = false;
    setStatus(`Построено ${plotMeta.length} графиков — ${parsed.data.length} точек`);
  }

  // top panel with values
  function updateMarkerBox(index){
    if(!parsed || !parsed.data[index]) return;
    const row = parsed.data[index];
    const t = Number(row.__sec).toFixed(3);
    let html = `<div class="marker-title">Время: ${t}s</div><div class="marker-list">`;
    plotMeta.forEach(m => {
      const v = parsed.data[index][m.col];
      html += `<div class="marker-row"><span class="marker-key">${m.col}</span><span class="marker-val">${v ?? '-'}</span></div>`;
    });
    html += '</div>';
    markerBox.innerHTML = html;
    markerBox.style.display = 'block';
  }

  // init file input
  fileInput.addEventListener('change', e=>{
    const f = e.target.files[0];
    if(!f) return;
    setStatus('Чтение файла...');
    const fr = new FileReader();
    fr.onload = evt => {
      try{
        parsed = parseCSVText(evt.target.result);
        setStatus(`Файл загружен — ${parsed.data.length} строк`);
        buildColumnList(parsed.fields);
        selectAllBtn.disabled = deselectAllBtn.disabled = false;
        buildPlots();
      }catch(err){
        setStatus('Ошибка парсинга: '+ (err.message||err), false);
      }
    };
    fr.onerror = ()=> setStatus('Ошибка чтения файла', false);
    fr.readAsText(f, 'utf-8');
  });

  resetZoomBtn.addEventListener('click', ()=>{
    if(!plotMeta.length) return;
    const xMin = plotMeta[0].xMin, xMax = plotMeta[0].xMax;
    applyRangeToAll([xMin, Math.min(xMax, xMin + (xMax-xMin)/6)]);
    markerBox.style.display = 'none';
  });

  selectAllBtn.addEventListener('click', ()=> { columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=true); buildPlots(); });
  deselectAllBtn.addEventListener('click', ()=> { columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=false); buildPlots(); });

});
