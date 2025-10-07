// Subaru Log Viewer — PRO Lite 1.0
// Основано на Smooth 3.1: стабильность + синхронное движение всех графиков по оси X

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

  const CONFIG = { displayModeBar: false, responsive: true, scrollZoom: false };

  const setStatus = (msg, ok = true) => {
    status.textContent = msg;
    status.style.color = ok ? "#064e3b" : "#b91c1c";
  };

  const detectDelimiter = (txt) => {
    const lines = txt.split(/\r?\n/).filter(l => l.trim()).slice(0, 5);
    let c = 0, s = 0;
    lines.forEach(l => { c += (l.match(/,/g) || []).length; s += (l.match(/;/g) || []).length; });
    return s > c ? ";" : ",";
  };

  const splitLine = (line, d) => {
    const res = [];
    let cur = "", inQ = false;
    for (let ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && ch === d) { res.push(cur); cur = ""; } else cur += ch;
    }
    res.push(cur);
    return res.map(v => v.replace(/^\uFEFF|\u200B/g, "").trim());
  };

  // Простой CSV парсер
  const parseCSV = (txt) => {
    const d = detectDelimiter(txt);
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("Файл пуст или повреждён");

    const head = splitLine(lines[0], d);
    const data = lines.slice(1).map(l => {
      const vals = splitLine(l, d);
      const obj = {};
      head.forEach((h, i) => obj[h] = vals[i] ?? "");
      return obj;
    });

    // Найдём Time-столбец
    const timeKey = head.find(h => /time|timestamp|utc/i.test(h)) || head[0];
    data.forEach(r => (r.__time = r[timeKey] || ""));

    return { fields: head, data };
  };

  const buildColumnList = (cols) => {
    columnsContainer.innerHTML = "";
    cols.forEach((c, i) => {
      if (/time|timestamp|utc/i.test(c)) return;
      const el = document.createElement("div");
      el.className = "column-item";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.id = "col_" + i;
      chk.dataset.col = c;
      if (/afr|rpm|maf|inj|duty|boost|press/i.test(c)) chk.checked = true;
      const lb = document.createElement("label");
      lb.htmlFor = chk.id;
      lb.textContent = c;
      el.append(chk, lb);
      columnsContainer.append(el);
      chk.addEventListener("change", buildPlots);
    });
  };

  const updateMarkerBox = (i) => {
    const row = parsed?.data[i];
    if (!row) return;
    let html = `<div class="marker-title">Время: ${row.__time}</div><div class="marker-list">`;
    plotMeta.forEach(m => html += `<div class="marker-row"><span class="marker-key">${m.col}</span><span class="marker-val">${row[m.col] ?? "-"}</span></div>`);
    markerBox.innerHTML = html + "</div>";
    markerBox.style.display = "block";
  };

  const drawMarkersAll = (x) => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      plotMeta.forEach(m => Plotly.relayout(m.div, {
        shapes: [{
          type: "line", x0: x, x1: x, y0: 0, y1: 1,
          xref: "x", yref: "paper", line: { color: "#ef4444", width: 1.5 }
        }]
      }));
    }, 25);
  };

  const buildPlots = () => {
    if (!parsed) return;
    const xKey = "__time";
    const selected = [...columnsContainer.querySelectorAll("input:checked")].map(x => x.dataset.col);
    if (!selected.length) { plotsContainer.innerHTML = ""; plotMeta = []; return; }

    plotsContainer.innerHTML = "";
    plotMeta = [];
    const x = parsed.data.map(r => r[xKey]);

    const builds = selected.map(col => {
      const y = parsed.data.map(r => {
        const n = parseFloat((r[col] ?? "").replace(",", "."));
        return isNaN(n) ? null : n;
      });

      const div = document.createElement("div");
      div.className = "plot";
      plotsContainer.append(div);

      const trace = { x, y, mode: "lines", name: col, line: { width: 2.2 } };
      const layout = {
        title: col,
        xaxis: { title: "Время", type: "category" },
        yaxis: { fixedrange: true },
        margin: { t: 38, l: 50, r: 10, b: 40 }
      };

      return Plotly.newPlot(div, [trace], layout, CONFIG).then(() => {
        const meta = { div, col };
        plotMeta.push(meta);

        div.querySelector(".main-svg").style.touchAction = "none";

        // Ставим обработчик кликов (красная линия)
        div.on("plotly_click", ev => {
          const p = ev.points?.[0];
          if (!p) return;
          markerX = p.x;
          updateMarkerBox(p.pointNumber);
          drawMarkersAll(markerX);
        });

        // 🔄 Новый обработчик — синхронное движение всех графиков
        div.on("plotly_relayout", ev => {
          if (ev["xaxis.range[0]"] !== undefined && ev["xaxis.range[1]"] !== undefined) {
            const s = ev["xaxis.range[0]"];
            const e = ev["xaxis.range[1]"];
            plotMeta.forEach(p => {
              if (p.div !== div) {
                Plotly.relayout(p.div, { "xaxis.range": [s, e] });
              }
            });
          }
        });
      });
    });

    Promise.all(builds).then(() => {
      setStatus(`Построено ${plotMeta.length} графиков — ${parsed.data.length} точек`);
      resetZoomBtn.disabled = false;
    });
  };

  // === File Upload ===
  fileInput.addEventListener("change", e => {
    const f = e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    setStatus("Чтение файла...");
    fr.onload = ev => {
      try {
        parsed = parseCSV(ev.target.result);
        setStatus(`Файл загружен — ${parsed.data.length} строк`);
        buildColumnList(parsed.fields);
        selectAllBtn.disabled = deselectAllBtn.disabled = false;
        buildPlots();
      } catch (err) {
        setStatus("Ошибка: " + err.message, false);
      }
    };
    fr.readAsText(f, "utf-8");
  });

  // === Buttons ===
  resetZoomBtn.addEventListener("click", () => {
    if (!plotMeta.length) return;
    markerBox.style.display = "none";
    plotMeta.forEach(m => Plotly.relayout(m.div, { "xaxis.autorange": true }));
  });

  selectAllBtn.addEventListener("click", () => {
    columnsContainer.querySelectorAll("input").forEach(c => c.checked = true);
    buildPlots();
  });
  deselectAllBtn.addEventListener("click", () => {
    columnsContainer.querySelectorAll("input").forEach(c => c.checked = false);
    buildPlots();
  });
});
