// Subaru Log Viewer — PRO Smooth 3.0
// Двухпальцевый зум, цифры на всех графиках, плавное обновление без зависаний.

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  const columnsContainer = document.getElementById("columnsContainer");
  const resetZoomBtn = document.getElementById("resetZoomBtn");
  const selectAllBtn = document.getElementById("selectAllBtn");
  const deselectAllBtn = document.getElementById("deselectAllBtn");
  const plotsContainer = document.getElementById("plotsContainer");
  const markerBox = document.getElementById("markerData");
  const status = document.getElementById("status");

  let parsed = null;
  let plotMeta = [];
  let markerX = null;
  let syncTimer = null;

  // отключаем зум одним пальцем, оставляем двухпальцевый pinch-zoom
  const config = { displayModeBar: false, responsive: true, scrollZoom: false };

  function setStatus(msg, ok = true) {
    status.textContent = msg;
    status.style.color = ok ? "#064e3b" : "#b91c1c";
  }

  function detectDelimiter(text) {
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim()).slice(0, 5);
    let comma = 0, semi = 0;
    lines.forEach(l => {
      comma += (l.match(/,/g) || []).length;
      semi += (l.match(/;/g) || []).length;
    });
    return semi > comma ? ";" : ",";
  }

  function splitLine(line, delimiter) {
    const res = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (!inQuotes && ch === delimiter) { res.push(cur); cur = ""; }
      else cur += ch;
    }
    res.push(cur);
    return res.map(s => s.replace(/^\uFEFF|\u200B/g, "").trim());
  }

  function parseCSVText(text) {
    const delim = detectDelimiter(text);
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim());
    if (lines.length < 2) return null;
    const header = splitLine(lines[0], delim);
    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = splitLine(lines[i], delim);
      const obj = {};
      for (let j = 0; j < header.length; j++) obj[header[j]] = vals[j] ?? null;
      data.push(obj);
    }
    return { fields: header, data };
  }

  function buildColumnList(cols) {
    columnsContainer.innerHTML = "";
    cols.forEach((c, idx) => {
      if (c.toLowerCase().includes("time")) return;
      const item = document.createElement("div");
      item.className = "column-item";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.dataset.col = c;
      chk.id = "col_" + idx;
      if (/afr|rpm|maf|inj|duty|boost|press/i.test(c)) chk.checked = true;
      const lbl = document.createElement("label");
      lbl.htmlFor = chk.id;
      lbl.textContent = c;
      item.append(chk, lbl);
      columnsContainer.appendChild(item);
      chk.addEventListener("change", () => buildPlots());
    });
  }

  function updateMarkerBox(index) {
    if (!parsed || !parsed.data[index]) return;
    const row = parsed.data[index];
    let html = `<div class="marker-title">Время: ${row["Time"] || index}</div><div class="marker-list">`;
    plotMeta.forEach(m => {
      const v = row[m.col];
      html += `<div class="marker-row"><span class="marker-key">${m.col}</span><span class="marker-val">${v ?? "-"}</span></div>`;
    });
    html += "</div>";
    markerBox.innerHTML = html;
    markerBox.style.display = "block";
  }

  function drawMarkersAll(xVal, rowIndex) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      plotMeta.forEach(m => {
        const y = parseFloat(parsed.data[rowIndex]?.[m.col]?.replace(",", "."));
        const ann = isFinite(y)
          ? [{
              x: xVal,
              y: y,
              xref: "x",
              yref: "y",
              text: y.toFixed(2),
              showarrow: false,
              font: { color: "crimson", size: 10 },
              xanchor: "left",
              yanchor: "bottom"
            }]
          : [];
        Plotly.relayout(m.div, {
          shapes: [{
            type: "line",
            x0: xVal, x1: xVal,
            y0: 0, y1: 1,
            xref: "x", yref: "paper",
            line: { color: "crimson", width: 1.5 }
          }],
          annotations: ann
        }).catch(() => {});
      });
    }, 30); // лёгкий debounce для плавности
  }

  function syncXRange(range) {
    plotMeta.forEach(m =>
      Plotly.relayout(m.div, { "xaxis.range": range }).catch(() => {})
    );
  }

  function buildPlots() {
    if (!parsed) return;
    const xKey = "Time";
    const checked = [...columnsContainer.querySelectorAll("input:checked")].map(i => i.dataset.col);
    if (checked.length === 0) return;
    plotsContainer.innerHTML = "";
    plotMeta = [];

    const xVals = parsed.data.map(r => r[xKey]);
    checked.forEach((col, idx) => {
      const y = parsed.data.map(r => {
        const v = r[col];
        const n = parseFloat(String(v).replace(",", "."));
        return isNaN(n) ? null : n;
      });

      const div = document.createElement("div");
      div.className = "plot";
      plotsContainer.appendChild(div);

      const trace = {
        x: xVals,
        y: y,
        mode: "lines",
        name: col,
        line: { width: 2.5 }
      };
      const layout = {
        title: col,
        dragmode: "pan",
        yaxis: { fixedrange: true },
        xaxis: { title: "Time" },
        margin: { t: 40, b: 40, l: 50, r: 10 }
      };

      Plotly.newPlot(div, [trace], layout, config).then(() => {
        const handleEvent = ev => {
          const p = ev.points[0];
          if (!p) return;
          markerX = p.x;
          const rowIndex = p.pointNumber;
          updateMarkerBox(rowIndex);
          drawMarkersAll(markerX, rowIndex);
        };
        div.on("plotly_click", handleEvent);
        div.on("plotly_hover", handleEvent);
        div.on("plotly_relayout", ev => {
          if (ev["xaxis.range[0]"] && ev["xaxis.range[1]"])
            syncXRange([ev["xaxis.range[0]"], ev["xaxis.range[1]"]]);
          else if (ev["xaxis.autorange"]) syncXRange(null);
          if (markerX != null) drawMarkersAll(markerX, 0);
        });
      });
      plotMeta.push({ div, col });
    });

    resetZoomBtn.disabled = false;
    setStatus(`Построено ${plotMeta.length} графиков — ${parsed.data.length} точек`);
  }

  fileInput.addEventListener("change", e => {
    const f = e.target.files[0];
    if (!f) return;
    setStatus("Чтение файла...");
    const fr = new FileReader();
    fr.onload = ev => {
      try {
        parsed = parseCSVText(ev.target.result);
        setStatus(`Файл загружен — ${parsed.data.length} строк`);
        buildColumnList(parsed.fields);
        selectAllBtn.disabled = deselectAllBtn.disabled = false;
        buildPlots();
      } catch (err) {
        setStatus("Ошибка парсинга: " + err.message, false);
      }
    };
    fr.onerror = () => setStatus("Ошибка чтения файла", false);
    fr.readAsText(f, "utf-8");
  });

  resetZoomBtn.addEventListener("click", () => {
    plotMeta.forEach(m => Plotly.relayout(m.div, { "xaxis.autorange": true }));
    markerX = null;
    markerBox.style.display = "none";
  });

  selectAllBtn.addEventListener("click", () => {
    columnsContainer.querySelectorAll("input").forEach(cb => (cb.checked = true));
    buildPlots();
  });

  deselectAllBtn.addEventListener("click", () => {
    columnsContainer.querySelectorAll("input").forEach(cb => (cb.checked = false));
    buildPlots();
  });
});
