// Fixed script: uses FileReader, auto-detect delimiter, robust parsing, marker + sync X, fixed Y
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

  let parsed = null; // {fields:[], data:[]}
  let plotMeta = []; // {div, col, xVals, yVals}
  let markerX = null;

  function setStatus(msg, ok = true){
    status.textContent = msg;
    status.style.color = ok ? '#064e3b' : '#b91c1c';
  }

  // simple CSV parser: header line + split rows by delimiter, handles quoted fields
  function parseCSVText(text, delimiter) {
    const lines = text.split(/\r\n|\n|\r/).filter(l=>l.trim().length>0);
    if(lines.length===0) return null;
    const header = splitLine(lines[0], delimiter);
    const data = [];
    for(let i=1;i<lines.length;i++){
      const vals = splitLine(lines[i], delimiter);
      if(vals.length === 0) continue;
      const obj = {};
      for(let j=0;j<header.length;j++){
        obj[header[j]] = vals[j] !== undefined ? vals[j] : null;
      }
      data.push(obj);
    }
    return { fields: header, data: data };
  }

  // robust line splitter (handles quoted commas/semicolons)
  function splitLine(line, delimiter){
    const res = [];
    let cur = '';
    let inQuotes = false;
    for(let i=0;i<line.length;i++){
      const ch = line[i];
      if(ch === '"' || ch === '“' || ch === '”'){
        inQuotes = !inQuotes;
        continue;
      }
      if(!inQuotes && ch === delimiter){
        res.push(cur);
        cur='';
      } else {
        cur += ch;
      }
    }
    res.push(cur);
    // trim BOM and whitespace on headers/values
    return res.map(s=>s.replace(/^\uFEFF|\u200B/g,'').trim());
  }

  function detectDelimiter(text){
    // check first 5 non-empty lines
    const lines = text.split(/\r\n|\n|\r/).filter(l=>l.trim().length>0).slice(0,5);
    const commaCounts = lines.map(l=> (l.match(/,/g)||[]).length );
    const semiCounts = lines.map(l=> (l.match(/;/g)||[]).length );
    const commaAvg = commaCounts.reduce((a,b)=>a+b,0);
    const semiAvg = semiCounts.reduce((a,b)=>a+b,0);
    return semiAvg > commaAvg ? ';' : ',';
  }

  fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if(!f) { setStatus('Файл не выбран', false); return; }
    setStatus('Чтение файла...');
    const rdr = new FileReader();
    rdr.onload = function(ev){
      let text = ev.target.result;
      // try to detect delimiter
      const delim = detectDelimiter(text);
      try {
        const result = parseCSVText(text, delim);
        if(!result || !result.fields || result.fields.length===0){
          setStatus('Не удалось распарсить CSV', false);
          return;
        }
        parsed = result;
        setStatus(`Файл загружен — найдено ${parsed.data.length} строк`);
        buildColumnList(parsed.fields);
        plotBtn.disabled = false;
        selectAllBtn.disabled = false;
        deselectAllBtn.disabled = false;
      } catch(err){
        setStatus('Ошибка парсинга: '+err.message, false);
      }
    };
    rdr.onerror = function(){ setStatus('Ошибка чтения файла', false); };
    rdr.readAsText(f, 'utf-8');
  });

  function buildColumnList(cols){
    columnsContainer.innerHTML='';
    const xKey = xSelect.value;
    cols.forEach((c, idx) => {
      if(c === xKey) return;
      const item = document.createElement('div');
      item.className = 'column-item';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.dataset.col = c;
      chk.id = 'col_' + idx;
      // default heuristics
      if(/afr|a\/f|air-fuel|ma[ff]|maf|rpm|engine speed/i.test(c)) chk.checked = true;
      const lbl = document.createElement('label');
      lbl.htmlFor = chk.id;
      lbl.textContent = c;
      item.appendChild(chk); item.appendChild(lbl);
      columnsContainer.appendChild(item);
    });
  }

  function drawMarker(xVal){
    markerX = xVal;
    plotMeta.forEach(m => {
      Plotly.relayout(m.div, { shapes: [{ type:'line', x0:xVal, x1:xVal, y0:0, y1:1, xref:'x', yref:'paper', line:{color:'crimson', width:1.5} }] }).catch(()=>{});
    });
  }

  function updateMarkerBox(index){
    if(!parsed || !parsed.data[index]) return;
    const row = parsed.data[index];
    let html = `<div class="marker-title">Позиция: ${index}</div><div class="marker-list">`;
    plotMeta.forEach(m=>{
      const v = row[m.col];
      html += `<div class="marker-row"><span class="marker-key">${m.col}</span><span class="marker-val">${v !== undefined ? v : '-'}</span></div>`;
    });
    html += '</div>';
    markerBox.innerHTML = html;
    markerBox.style.display = 'block';
  }

  function syncXRange(range){
    plotMeta.forEach(m => {
      Plotly.relayout(m.div, {'xaxis.range': range}).catch(()=>{});
    });
  }

  function findNearestIndexForPlot(m, xVal){
    // try numeric compare
    const xNums = m.xValsNumeric;
    if(xNums && xNums.some(v=>v!==null)){
      // if xVal numeric, choose nearest
      const n = parseFloat(String(xVal).replace(',','.'));
      if(!isNaN(n)){
        let best=0, bestd=Infinity;
        for(let i=0;i<xNums.length;i++){
          const v = xNums[i];
          if(v===null) continue;
          const d = Math.abs(v-n);
          if(d<bestd){bestd=d;best=i;}
        }
        return best;
      }
    }
    // fallback: find exact match by string
    const idx = m.xVals.findIndex(v=>v===xVal);
    return idx!==-1?idx:0;
  }

  function buildPlots(){
    if(!parsed) { setStatus('Нет данных', false); return; }
    const xKey = xSelect.value;
    const checked = [...columnsContainer.querySelectorAll('input[type=checkbox]:checked')].map(i=>i.dataset.col);
    if(checked.length===0){ setStatus('Выберите параметры', false); return; }
    plotsContainer.innerHTML=''; plotMeta=[];
    // prepare x array and numeric version
    const xVals = parsed.data.map(r=> r[xKey] !== undefined ? r[xKey] : null );
    const xValsNumeric = xVals.map(v=>{ const n=parseFloat(String(v).replace(',','.')); return isNaN(n)?null:n; });
    checked.forEach((col, idx)=>{
      const y = parsed.data.map(r=>{
        const v = r[col];
        if(typeof v === 'string') {
          const s = v.replace(',','.');
          const n = parseFloat(s);
          return isNaN(n)?null:n;
        }
        return v;
      });
      const div = document.createElement('div');
      div.className = 'plot'; div.id = 'plot_'+idx; plotsContainer.appendChild(div);
      const trace = { x: xVals, y: y, mode:'lines', name:col };
      const layout = { title:col, dragmode:'pan', yaxis:{fixedrange:true}, xaxis:{title:xKey}, margin:{t:40,b:40,l:50,r:10} };
      Plotly.newPlot(div, [trace], layout, {displaylogo:false,responsive:true}).then(()=>{
        // attach handlers for hover/click to move marker
        div.on('plotly_hover', ev => {
          const p = ev.points[0];
          // find nearest index for each plot using the first plot's pointNumber
          const index = p.pointNumber;
          drawMarker(p.x);
          updateMarkerBox(index);
        });
        div.on('plotly_click', ev => {
          const p = ev.points[0];
          const index = p.pointNumber;
          drawMarker(p.x);
          updateMarkerBox(index);
        });
        div.on('plotly_relayout', ev => {
          if(ev['xaxis.range[0]'] !== undefined && ev['xaxis.range[1]'] !== undefined){
            syncXRange([ev['xaxis.range[0]'], ev['xaxis.range[1]']]);
          } else if(ev['xaxis.autorange'] !== undefined){
            syncXRange(null);
          }
          if(markerX !== null) drawMarker(markerX);
        });
      }).catch(()=>{});
      plotMeta.push({div:div, col:col, xVals:xVals, xValsNumeric:xValsNumeric, yVals:y});
    });
    resetZoomBtn.disabled = false;
    setStatus(`Построено ${plotMeta.length} графиков — ${parsed.data.length} точек`);
  }

  fileInput.addEventListener('change', e=>{
    const f = e.target.files[0];
    if(!f){ setStatus('Файл не выбран', false); return; }
    setStatus('Чтение файла...');
    const fr = new FileReader();
    fr.onload = function(evt){
      const text = evt.target.result;
      try{
        const delim = detectDelimiter(text);
        const res = parseCSVText(text, delim);
        if(!res || !res.fields || res.fields.length===0) { setStatus('Не удалось распарсить CSV', false); return; }
        parsed = res;
        // prepare numeric conversions for x columns for each row
        setStatus(`Файл загружен — ${parsed.data.length} строк`);
        buildColumnList(parsed.fields);
        plotBtn.disabled = false;
        selectAllBtn.disabled = false;
        deselectAllBtn.disabled = false;
      }catch(err){
        setStatus('Ошибка парсинга: '+err.message, false);
      }
    };
    fr.onerror = function(){ setStatus('Ошибка чтения файла', false); };
    fr.readAsText(f, 'utf-8');
  });

  plotBtn.addEventListener('click', buildPlots);
  resetZoomBtn.addEventListener('click', ()=>{
    plotMeta.forEach(m=>{ Plotly.relayout(m.div, {'xaxis.autorange':true}).catch(()=>{}); });
    markerX = null; markerBox.style.display = 'none'; setStatus('Зум сброшен');
  });
  selectAllBtn.addEventListener('click', ()=>{ columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=true); });
  deselectAllBtn.addEventListener('click', ()=>{ columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=false); });

  // helper: detect delimiter quickly
  function detectDelimiter(text){
    const lines = text.split(/\r\n|\n|\r/).filter(l=>l.trim().length>0).slice(0,5);
    let comma=0, semi=0;
    lines.forEach(l=>{ comma += (l.match(/,/g)||[]).length; semi += (l.match(/;/g)||[]).length; });
    return semi>comma?';':',';
  }

  // expose for debug if needed
  window._sv = { detectDelimiter, parseCSVText };
});
