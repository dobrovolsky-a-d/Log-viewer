
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
  let parsed = null;
  let plotMeta = [];
  let markerX = null;

  function buildColumnList(cols){
    columnsContainer.innerHTML = '';
    const xKey = xSelect.value;
    cols.forEach((c, idx) => {
      if(c === xKey) return;
      const div = document.createElement('div');
      div.className = 'column-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.col = c;
      cb.id = 'col_' + idx;
      if(/afr|rpm|maf/i.test(c)) cb.checked = true;
      const lbl = document.createElement('label');
      lbl.htmlFor = cb.id; lbl.textContent = c;
      div.appendChild(cb); div.appendChild(lbl);
      columnsContainer.appendChild(div);
    });
  }

  function drawMarker(xVal){
    markerX = xVal;
    plotMeta.forEach(meta => {
      Plotly.relayout(meta.div, {
        shapes: [{
          type: 'line',
          x0: xVal, x1: xVal,
          y0: 0, y1: 1,
          xref: 'x', yref: 'paper',
          line: {color:'crimson', width:1.5}
        }]
      }).catch(()=>{});
    });
  }

  function updateMarkerValues(index){
    const row = parsed.data[index];
    if(!row) return;
    let html = `<div class='marker-title'>Позиция: ${index}</div><div class='marker-list'>`;
    plotMeta.forEach(meta => {
      // attempt to format value
      const v = row[meta.col];
      html += `<div class='marker-row'><span class='marker-key'>${meta.col}</span><span class='marker-val'>${v !== undefined ? v : '-'}</span></div>`;
    });
    html += '</div>';
    markerBox.innerHTML = html;
    markerBox.style.display = 'block';
  }

  function syncXRange(xRange){
    plotMeta.forEach(meta => {
      Plotly.relayout(meta.div, {'xaxis.range': xRange}).catch(()=>{});
    });
  }

  function buildPlots(){
    const xKey = xSelect.value;
    const selected = [...columnsContainer.querySelectorAll('input:checked')].map(c=>c.dataset.col);
    if(selected.length===0){alert('Выбери параметры');return;}
    plotsContainer.innerHTML=''; plotMeta=[];
    const xVals = parsed.data.map(r=>r[xKey]);
    selected.forEach((col,i)=>{
      const yVals = parsed.data.map(r=>{
        const v = r[col];
        if(typeof v === 'string'){
          const s = v.replace(',', '.');
          const n = parseFloat(s);
          return isNaN(n) ? null : n;
        }
        return v;
      });
      const div = document.createElement('div');
      div.className='plot'; div.id = 'plot_'+i; plotsContainer.appendChild(div);
      const trace = {x:xVals,y:yVals,mode:'lines',name:col};
      const layout = {
        title:col,
        dragmode:'pan',
        yaxis:{fixedrange:true},
        xaxis:{title:xKey},
        margin:{t:40,l:50,r:10,b:40}
      };
      Plotly.newPlot(div,[trace],layout,{displaylogo:false,responsive:true}).then(() => {
        // attach events for hover/click for marker
        div.on('plotly_hover', ev => {
          const p = ev.points[0];
          drawMarker(p.x);
          updateMarkerValues(p.pointNumber);
        });
        div.on('plotly_click', ev => {
          const p = ev.points[0];
          drawMarker(p.x);
          updateMarkerValues(p.pointNumber);
        });
        div.on('plotly_relayout', ev => {
          // if user zoomed/panned, sync range to others
          if(ev['xaxis.range[0]'] !== undefined && ev['xaxis.range[1]'] !== undefined){
            syncXRange([ev['xaxis.range[0]'], ev['xaxis.range[1]']]);
          } else if(ev['xaxis.autorange'] !== undefined){
            syncXRange(null);
          }
          // redraw marker at same x if exists
          if(markerX !== null) drawMarker(markerX);
        });
      });
      plotMeta.push({div:div, col:col, x:xVals});
    });
    resetZoomBtn.disabled=false;
  }

  fileInput.addEventListener('change', e=>{
    const f = e.target.files[0];
    if(!f) return;
    Papa.parse(f,{
      header:true,
      dynamicTyping:true,
      skipEmptyLines:true,
      complete: res => {
        parsed = res;
        buildColumnList(res.meta.fields);
        plotBtn.disabled = false;
        selectAllBtn.disabled = false;
        deselectAllBtn.disabled = false;
      }
    });
  });

  plotBtn.addEventListener('click', buildPlots);
  resetZoomBtn.addEventListener('click', ()=>{
    plotMeta.forEach(m => Plotly.relayout(m.div, {'xaxis.autorange':true}).catch(()=>{}));
    markerX = null;
    markerBox.style.display = 'none';
  });
  selectAllBtn.addEventListener('click', ()=>{ columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=true); });
  deselectAllBtn.addEventListener('click', ()=>{ columnsContainer.querySelectorAll('input').forEach(cb=>cb.checked=false); });
});
