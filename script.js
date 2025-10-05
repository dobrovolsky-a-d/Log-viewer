// script.js - client-side logic for Log Viewer (Russian UI)
document.addEventListener('DOMContentLoaded', ()=>{
  const fileInput = document.getElementById('fileInput');
  const columnsContainer = document.getElementById('columnsContainer');
  const plotBtn = document.getElementById('plotBtn');
  const savePngBtn = document.getElementById('savePngBtn');
  const xSelect = document.getElementById('xSelect');
  let parsed = null;
  let headers = [];
  let dataRows = [];

  function guessDefaults(h){
    // heuristics to choose default X and Y selections
    const lower = h.map(x=>x.toLowerCase());
    let afrKey = h.find(col => /afr|a\/f sensor/i.test(col)) || h.find(col => /air-fuel|a\/f/i.test(col));
    let rpmKey = h.find(col => /engine speed \(rpm\)|rpm/i.test(col)) || h.find(col => /rpm/i.test(col));
    let mafKey = h.find(col => /mass airflow|maf|g\/s/i.test(col));
    return {afrKey, rpmKey, mafKey};
  }

  fileInput.addEventListener('change', (ev)=>{
    const f = ev.target.files[0];
    if(!f) return;
    Papa.parse(f, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      worker: true,
      complete: function(results){
        parsed = results;
        headers = results.meta.fields || [];
        dataRows = results.data || [];
        buildColumnList(headers);
        plotBtn.disabled = false;
        savePngBtn.disabled = true;
        // try to set X axis if RPM found
        const g = guessDefaults(headers);
        if(g.rpmKey){
          xSelect.value = g.rpmKey;
          // add RPM to options if custom header exists
          ensureXOption(g.rpmKey);
        } else {
          // keep default Time
          ensureXOption('Time');
        }
      },
      error: function(err){
        alert('Ошибка чтения CSV: '+err.message);
      }
    });
  });

  function ensureXOption(val){
    // add to xSelect if not present
    if([...xSelect.options].some(o=>o.value===val)) return;
    const opt = document.createElement('option');
    opt.value = val;
    opt.text = val;
    xSelect.appendChild(opt);
  }

  function buildColumnList(cols){
    columnsContainer.innerHTML = '';
    cols.forEach(c => {
      const item = document.createElement('div');
      item.className = 'column-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.col = c;
      checkbox.id = 'col_' + cols.indexOf(c);
      // default check commonly used params
      if(/afr|a\/f/i.test(c) || /engine speed \(rpm\)|rpm/i.test(c) || /mass airflow|maf/i.test(c)){
        checkbox.checked = true;
      }
      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.textContent = c;
      item.appendChild(checkbox);
      item.appendChild(label);

      // small "y-axis" selector for multi-axis optional -> for now not exposed, reserve for future
      columnsContainer.appendChild(item);
    });
  }

  function buildPlot(){
    if(!parsed) { alert('Сначала загрузите CSV'); return; }
    const xKey = xSelect.value;
    // assemble traces for all checked columns except X
    const checked = [...columnsContainer.querySelectorAll('input[type=checkbox]:checked')].map(i=>i.dataset.col);
    if(checked.length===0){ alert('Выберите хотя бы один параметр'); return; }

    // Prepare X values
    let xVals = [];
    if(xKey === 'Time' && parsed.meta && parsed.data){
      // try to use Time column if exists
      if(parsed.meta.fields.includes('Time')){
        xVals = parsed.data.map(r => r['Time']);
      } else {
        // fallback to row index/time position
        xVals = parsed.data.map((_,i)=>i);
      }
    } else {
      xVals = parsed.data.map(r => r[xKey]);
    }

    const traces = [];
    checked.forEach(col => {
      // skip if equals X
      if(col === xKey) return;
      const y = parsed.data.map(r => {
        const v = r[col];
        // try to coerce numeric-like values that are strings with commas
        if(typeof v === 'string'){
          const s = v.replace(',', '.');
          const n = parseFloat(s);
          return isNaN(n) ? null : n;
        }
        return v;
      });
      traces.push({
        x: xVals,
        y: y,
        name: col,
        mode: 'lines+markers',
        marker: {size:4},
        hovertemplate: '<b>%{text}</b><br>X: %{x}<br>Y: %{y}<extra></extra>',
        text: Array(y.length).fill(col)
      });
    });

    const layout = {
      title: 'График: ' + checked.join(', '),
      xaxis: {title: xKey, automargin:true},
      yaxis: {title: 'Значение', automargin:true},
      legend: {orientation:'h'},
      margin: {t:50, b:60, l:60, r:20}
    };

    Plotly.newPlot('plot', traces, layout, {responsive:true});
    savePngBtn.disabled = false;
  }

  plotBtn.addEventListener('click', buildPlot);

  savePngBtn.addEventListener('click', ()=>{
    Plotly.toImage('plot', {format:'png', height:720, width:1280}).then(function(dataUrl){
      // create temporary link to download
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'log_plot.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });

  // allow clicking on column label to toggle selection
  columnsContainer.addEventListener('click', (e)=>{
    const target = e.target;
    if(target.tagName === 'LABEL'){
      const id = target.htmlFor;
      const inp = document.getElementById(id);
      if(inp) inp.checked = !inp.checked;
    }
  });

});
