// script.js — optimized: header normalization, injector aliases, fast marker, sync X, fixed Y
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const xSelect = document.getElementById('xSelect');
  const columnsContainer = document.getElementById('columnsContainer');
  const plotBtn = document.getElementById('plotBtn');
  const resetZoomBtn = document.getElementById('resetZoomBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const deselectAllBtn = document.getElementById('deselectAllBtn');
  const plotsContainer = document.getElementById('plotsContainer');
  const markerBox = document.getElementById('markerData');
  const status = document.getElementById('status');

  let parsed = null;
  let plotMeta = []; // {div, col, xVals, xNums, yVals}
  let markerX = null;
  let lastUpdate = 0;

  function setStatus(msg, ok=true){ status.textContent = msg; status.style.color = ok ? '#064e3b' : '#b91c1c'; }

  // normalize header: remove BOM, trim, lowercase, remove non-alphanum for matching
  function normalizeHeader(h){ return String(h || '').replace(/^\uFEFF/,'').trim().toLowerCase().replace(/[\s\-\_():,%]+/g,' '); }
  function compactKey(h){ return normalizeHeader(h).replace(/[^a-z0-9]/g,''); }

  // known alias groups - map compact key -> display name
  const aliasGroups = [
    {names: ['injectordutycycle','injectorduty','injdutyclock','injduty','injectordutycyclepercent','idcpercent','idc'], display:'Injector Duty Cycle (%)'},
    {names: ['engine speed rpm','enginespeedrpm','rpm','enginespeed'], display:'Engine Speed (rpm)'},
    {names: ['a/fsensor1(afr)','afsensor1 afr','afr','airfuel','air-fuelratio'], display:'A/F Sensor #1 (AFR)'},
    {names: ['massairflow','maf','massairflowg/s','mass airflow (g/s)'], display:'Mass Airflow (g/s)'},
  ];

  function mapHeaderToDisplay(raw){
    const c = compactKey(raw);
    for(const g of aliasGroups){
      for(const n of g.names){
        if(c.includes(n) || n.includes(c) || c===n) return g.display;
      }
    }
    // fallback: return trimmed raw header
    return raw;
  }

  // CSV parsing helpers
  function detectDelimiter(text){
    const lines = text.split(/\r\n|\n|\r/).filter(l=>l.trim().length>0).slice(0,6);
    let comma=0, semi=0;
    lines.forEach(l=>{ comma += (l.match(/,/g)||[]).length; semi += (l.match(/;/g)||[]).length; });
    return semi>comma?';':',';
  }

  function splitLine(line, delim){
    const res=[]; let cur=''; let inQ=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch === '"'){ inQ = !inQ; continue; }
      if(!inQ && ch === delim){ res.push(cur); cur=''; } else { cur += ch; }
    }
    res.push(cur);
    return res.map(s=>s.replace(/^\uFEFF|\u200B/g,'').trim());
  }

  function parseCSVText(text){
    const delim = detectDelimiter(text);
    const lines = text.split(/\r\n|\n|\r/).filter(l=>l.trim().length>0);
    if(lines.length<2) return null;
    const header = splitLine(lines[0], delim);
    const data = [];
    for(let i=1;i<lines.length;i++){
      const vals = splitLine(lines[i], delim);
      if(vals.length === 0) continue;
      const obj={};
      for(let j=0;j<header.length;j++){ obj[ header[j] ] = vals[j] !== undefined ? vals[j] : null; }
      data.push(obj);
    }
    return {fields: header, data: data};
  }

  fileInput.addEventListener('change', e=>{
    const f = e.target.files[0];
    if(!f){ setStatus('Файл не выбран', false); return; }
    setStatus('Чтение файла...');
    const fr = new FileReader();
    fr.onload = function(ev){
      try{
        const text = ev.target.result;
        const res = parseCSVText(text);
        if(!res || !res.fields || res.fields.length===0){ setStatus('Ошибка: не удалось распарсить CSV', false); return; }
        // attach normalized headers and mapping
        res._normalized = res.fields.map(h=>({raw:h, norm:normalizeHeader(h), compact:compactKey(h), display:mapHeaderToDisplay(h)}));
        parsed = res;
        setStatus(`Файл загружен — ${parsed.data.length} строк, ${parsed.fields.length} колонок`);
        buildColumnList(parsed.fields);
        plotBtn.disabled = false; selectAllBtn.disabled=false; deselectAllBtn.disabled=false;
      }catch(err){ setStatus('Ошибка парсинга: '+err.message, false); }
    };
    fr.onerror = ()=> setStatus('Ошибка чтения файла', false);
    fr.readAsText(f, 'utf-8');
  });

  function buildColumnList(cols){
    columnsContainer.innerHTML='';
    const xKey = xSelect.value;
    // build by normalized headers so display names preferred
    parsed._normalized.forEach((hObj, idx)=>{
      const raw = hObj.raw;
      if(raw === xKey) return;
      const item = document.createElement('div'); item.className='column-item';
      const chk = document.createElement('input'); chk.type='checkbox'; chk.dataset.col = raw; chk.id = 'col_'+idx;
      // default check for common params including injector duty variations
      const comp = hObj.compact;
      if(/afr|maf|rpm|injector|inj|idc|duty/.test(comp)) chk.checked = true;
      const lbl = document.createElement('label'); lbl.htmlFor = chk.id; lbl.textContent = hObj.display || raw;
      item.appendChild(chk); item.appendChild(lbl); columnsContainer.appendChild(item);
    });
  }

  // debounce helper for marker updates
  function debounce(fn, wait){
    let t = null;
    return function(...args){ if(t) clearTimeout(t); t = setTimeout(()=>{ fn.apply(this,args); t=null; }, wait); };
  }

  function drawMarkerOnDiv(div, xVal){
    return Plotly.relayout(div, { shapes: [{ type:'line', x0:xVal, x1:xVal, y0:0, y1:1, xref:'x', yref:'paper', line:{color:'crimson', width:1.5} }] }).catch(()=>{});
  }

  // fast update: draw marker on the div where event occurred, and schedule lightweight update for others
  const lightSync = debounce((xVal)=>{
    plotMeta.forEach(m=>{ try{ drawMarkerOnDiv(m.div, xVal); } catch(e){} });
  }, 60);

  function updateMarkerBoxFast(index){
    if(!parsed || !parsed.data[index]) return;
    const row = parsed.data[index];
    // update only text nodes inside markerBox for speed
    let html = `<div class="marker-title">Позиция: ${index}</div><div class="marker-list">`;
    plotMeta.forEach(m=>{
      const v = row[m.col];
      html += `<div class="marker-row"><span class="marker-key">${m.display||m.col}</span><span class="marker-val">${v!==undefined?v:'-'}</span></div>`;
    });
    html += '</div>';
    markerBox.innerHTML = html; markerBox.style.display = 'block';
  }

  function syncXRange(range){
    plotMeta.forEach(m=>{ Plotly.relayout(m.div, {'xaxis.range': range}).catch(()=>{}); });
  }

  function buildPlots(){
    if(!parsed) { setStatus('Нет данных', false); return; }
    const xKey = xSelect.value;
    const checked = [...columnsContainer.querySelectorAll('input[type=checkbox]:checked')].map(i=>i.dataset.col);
    if(checked.length===0){ setStatus('Выберите параметры', false); return; }
    plotsContainer.innerHTML=''; plotMeta=[];
    // prepare x values and numeric conversions
    const xVals = parsed.data.map(r => r[xKey] !== undefined ? r[xKey] : null);
    const xNums = xVals.map(v=>{ const n=parseFloat(String(v).replace(',','.')); return isNaN(n)?null:n; });
    checked.forEach((col, idx)=>{
      const y = parsed.data.map(r=>{ const v = r[col]; if(typeof v === 'string'){ const s=v.replace(',','.'); const n=parseFloat(s); return isNaN(n)?null:n; } return v; });
      const div = document.createElement('div'); div.className='plot'; div.id='plot_'+idx; plotsContainer.appendChild(div);
      const trace = { x:xVals, y:y, mode:'lines', name: (parsed._normalized.find(h=>h.raw===col)||{display:col}).display || col };
      const layout = { title:trace.name, dragmode:'pan', yaxis:{fixedrange:true}, xaxis:{title:xKey}, margin:{t:40,b:40,l:50,r:10} };
      Plotly.newPlot(div, [trace], layout, {displaylogo:false,responsive:true}).then(()=>{
        div.on('plotly_hover', ev=>{
          const p = ev.points[0];
          if(!p) return;
          // draw marker on target div immediately
          drawMarkerOnDiv(div, p.x);
          // fast update marker box with this index
          updateMarkerBoxFast(p.pointNumber);
          // schedule light sync to draw on other plots (debounced)
          lightSync(p.x);
        });
        div.on('plotly_click', ev=>{
          const p = ev.points[0];
          if(!p) return;
          drawMarkerOnDiv(div, p.x); updateMarkerBoxFast(p.pointNumber); lightSync(p.x);
        });
        div.on('plotly_relayout', ev=>{
          if(ev['xaxis.range[0]'] !== undefined && ev['xaxis.range[1]'] !== undefined) syncXRange([ev['xaxis.range[0]'], ev['xaxis.range[1]']]);
          else if(ev['xaxis.autorange'] !== undefined) syncXRange(null);
          if(markerX !== null) lightSync(markerX);
        });
      }).catch(()=>{});
      // store meta using raw col name and display
      const display = (parsed._normalized.find(h=>h.raw===col)||{display:col}).display || col;
      plotMeta.push({div:div, col:col, display:display, xVals:xVals, xNums:xNums, yVals:y});
    });
    resetZoomBtn.disabled=false;
    setStatus(`Построено ${plotMeta.length} графиков — ${parsed.data.length} точек`);
  }

  fileInput.addEventListener('change', e=>{
    // allow reselecting same file name by clearing input
    e.target.value = '';
    const f = e.target.files[0];
    if(!f){ setStatus('Файл не выбран', false); return; }
    setStatus('Чтение файла...');
    const fr = new FileReader();
    fr.onload = function(ev){
      try{
        const res = parseCSVText(ev.target.result);
        if(!res || !res.fields || res.fields.length===0) { setStatus('Ошибка парсинга', false); return; }
        res._normalized = res.fields.map(h=>({raw:h, norm:normalizeHeader(h), compact:compactKey(h), display:mapHeaderToDisplay(h)}));
        parsed = res;
        setStatus(`Файл загружен — ${parsed.data.length} строк`);
        buildColumnList(parsed.fields);
        plotBtn.disabled=false; selectAllBtn.disabled=false; deselectAllBtn.disabled=false;
      }catch(err){ setStatus('Ошибка: '+err.message, false); }
    };
    fr.onerror = ()=> setStatus('Ошибка чтения файла', false);
    fr.readAsText(f, 'utf-8');
  });

  plotBtn.addEventListener('click', buildPlots);
  resetZoomBtn.addEventListener('click', ()=>{
    plotMeta.forEach(m=>{ Plotly.relayout(m.div, {'xaxis.autorange':true}).catch(()=>{}); });
    markerBox.style.display='none'; markerX = null; setStatus('Зум сброшен');
  });
  selectAllBtn.addEventListener('click', ()=>{ columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=true); });
  deselectAllBtn.addEventListener('click', ()=>{ columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=false); });

  // expose helpers for debug
  window._sv = { mapHeaderToDisplay: window.mapHeaderToDisplay, detectDelimiter: detectDelimiter };
});