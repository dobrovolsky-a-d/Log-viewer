// Subaru Log Viewer — PRO (версия стабильная, ось X = время как вчера)

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  const columnsContainer = document.getElementById("columnsContainer");
  const resetZoomBtn = document.getElementById("resetZoomBtn");
  const selectAllBtn = document.getElementById("selectAllBtn");
  const deselectAllBtn = document.getElementById("deselectAllBtn");
  const plotsContainer = document.getElementById("plotsContainer");
  const markerBox = document.getElementById("markerData");
  const status = document.getElementById("status");
  const hSlider = document.getElementById("hSlider");

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
    const res = []; let cur = "", inQ = false;
    for (let ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && ch === d) { res.push(cur); cur = ""; } else cur += ch;
    }
    res.push(cur);
    return res.map(v => v.replace(/^\uFEFF|\u200B/g, "").trim());
  };

  // простой парсер CSV
  const parseCSV = (txt) => {
    const d = detectDelimiter(txt);
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("Файл пуст");
    const head = splitLine(lines[0], d);
    const data = lines.slice(1).map(l => {
      const vals = splitLine(l, d);
      const obj = {};
      head.forEach((h, i) => obj[h] = vals[i] ?? null);
      return obj;
    });

    // найти столбец времени
    const timeKey = head.find(h => /time|timestamp|utc/i.test(h)) || head[0];

    // добавить __sec — округлённые секунды
    data.forEach((r, i) => {
      const raw = parseFloat((r[timeKey] || "").replace(",", "."));
      r.__sec = isFinite(raw) ? Math.round(raw) : i;
    });

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

  const clamp = (a, b, min, max) => {
    let s = a, e = b;
    const w = e - s;
    if (w <= 0) return [min, max];
    if (s < min) { s = min; e = s + w; }
    if (e > max) { e = max; s = e - w; }
    return [s, e];
  };

  const updateMarkerBox = (i) => {
    const row = parsed?.data[i];
    if (!row) return;
    let html = `<div class="marker-title">Время: ${row.__sec} с</div><div class="marker-list">`;
    plotMeta.forEach(m => html += `<div class="marker-row"><span class="marker-key">${m.col}</span><span class="marker-val">${row[m.col] ?? "-"}</span></div>`);
    markerBox.innerHTML = html + "</div>";
    markerBox.style.display = "block";
  };

  const drawMarkersAll = (x) => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      plotMeta.forEach(m => Plotly.relayout(m.div, {
        shapes: [{ type: "line", x0: x, x1: x, y0: 0, y1: 1, xref: "x", yref: "paper", line: { color: "#ef4444", width: 1.5 } }]
      }));
    }, 30);
  };

  const applyRange = (r) => plotMeta.forEach(m => Plotly.relayout(m.div, { "xaxis.range": r }));

  hSlider.addEventListener("input", () => {
    if (!plotMeta.length) return;
    const m = plotMeta[0];
    const { xMin, xMax } = m;
    const pct = +hSlider.value / 100;
    const w = (m.range ? m.range[1] - m.range[0] : (xMax - xMin) / 5);
    const center = xMin + pct * (xMax - xMin);
    const [s, e] = clamp(center - w / 2, center + w / 2, xMin, xMax);
    applyRange([s, e]);
    plotMeta.forEach(p => p.range = [s, e]);
  });

  const buildPlots = () => {
    if (!parsed) return;
    const xKey = "__sec";
    const selected = [...columnsContainer.querySelectorAll("input:checked")].map(x => x.dataset.col);
    if (!selected.length) { plotsContainer.innerHTML = ""; plotMeta = []; return; }

    plotsContainer.innerHTML = "";
    plotMeta = [];
    const x = parsed.data.map(r => r[xKey]);
    const xMin = Math.min(...x), xMax = Math.max(...x);

    const builds = selected.map(col => {
      const y = parsed.data.map(r => {
        const n = parseFloat((r[col] ?? "").replace(",", "."));
        return isNaN(n) ? null : n;
      });
      const div = document.createElement("div");
      div.className = "plot";
      plotsContainer.append(div);
      const trace = { x, y, mode: "lines", name: col, line: { width: 2.5 } };
      const layout = {
        title: col,
        xaxis: { title: "секунды", tickformat: "d" },
        yaxis: { fixedrange: true },
        margin: { t: 38, l: 50, r: 10, b: 40 }
      };
      return Plotly.newPlot(div, [trace], layout, CONFIG).then(() => {
        const meta = { div, col, xMin, xMax, range: [xMin, xMin + (xMax - xMin) / 5] };
        plotMeta.push(meta);
        div.querySelector(".main-svg").style.touchAction = "none";
        div.on("plotly_click", ev => {
          const p = ev.points?.[0]; if (!p) return;
          markerX = p.x; updateMarkerBox(p.pointNumber); drawMarkersAll(markerX);
        });
        div.on("plotly_relayout", ev => {
          if (ev["xaxis.range[0]"] !== undefined && ev["xaxis.range[1]"] !== undefined) {
            let r0 = ev["xaxis.range[0]"], r1 = ev["xaxis.range[1]"];
            const [s, e] = clamp(r0, r1, meta.xMin, meta.xMax);
            if (e - s < 0.001) return;
            applyRange([s, e]);
            plotMeta.forEach(p => p.range = [s, e]);
          } else if (ev["xaxis.autorange"] !== undefined) {
            applyRange([meta.xMin, meta.xMax]);
            plotMeta.forEach(p => p.range = [meta.xMin, meta.xMax]);
          }
        });
      });
    });

    Promise.all(builds).then(() => {
      resetZoomBtn.disabled = false;
      setStatus(`Построено ${plotMeta.length} графиков — ${parsed.data.length} точек`);
    });
  };

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
      } catch (err) { setStatus("Ошибка: " + err.message, false); }
    };
    fr.onerror = () => setStatus("Ошибка чтения", false);
    fr.readAsText(f, "utf-8");
  });

  resetZoomBtn.addEventListener("click", () => {
    if (!plotMeta.length) return;
    const { xMin, xMax } = plotMeta[0];
    const r = [xMin, xMin + (xMax - xMin) / 5];
    applyRange(r);
    plotMeta.forEach(p => p.range = r);
    markerBox.style.display = "none";
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
