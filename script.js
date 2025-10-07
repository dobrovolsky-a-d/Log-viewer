// Subaru Log Viewer — PRO 1.2.1
// фиксы: не исчезает при скролле, жёсткое ограничение диапазона X

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
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && ch === d) { res.push(cur); cur = ""; } else cur += ch;
    }
    res.push(cur);
    return res.map(v => v.replace(/^\uFEFF|\u200B/g, "").trim());
  };

  function parseCSV(txt) {
    const d = detectDelimiter(txt);
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("Файл пуст");
    const head = splitLine(lines[0], d);
    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = splitLine(lines[i], d);
      const obj = {};
      for (let j = 0; j < head.length; j++) obj[head[j]] = vals[j] ?? null;
      data.push(obj);
    }
    const timeKey = head.find(h => /time|timestamp|utc|date/i.test(h)) || head[0];
    data.forEach(r => { r.__timeRaw = String(r[timeKey] ?? ""); });
    return { fields: head, data, timeKey };
  }

  function buildXFromTimeColumn(rows) {
    const raw = rows.map(r => r.__timeRaw);
    const nums = raw.map(s => {
      if (s == null) return NaN;
      const t = String(s).trim().replace(",", ".");
      const n = Number(t);
      return Number.isFinite(n) ? n : NaN;
    });
    const numericCount = nums.filter(v => Number.isFinite(v)).length;
    if (numericCount / raw.length > 0.85) {
      return { type: "numeric", xVals: nums, info: `numeric`, sample: raw.slice(0, 5) };
    }
    const dateObjs = raw.map(s => {
      if (!s) return null;
      const p = Date.parse(s);
      if (!Number.isNaN(p)) return new Date(p);
      const m = String(s).match(/^\s*(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
      if (m) {
        const now = new Date();
        const h = +m[1], mm = +m[2], ss = +m[3], ms = +(m[4] || 0);
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mm, ss, ms);
      }
      return null;
    });
    const dateCount = dateObjs.filter(v => v instanceof Date && !isNaN(v)).length;
    if (dateCount / raw.length > 0.75) {
      return { type: "date", xVals: dateObjs.map(d => d ? d.toISOString() : null), info: `date`, sample: raw.slice(0, 5) };
    }
    return { type: "string", xVals: raw, info: `string`, sample: raw.slice(0, 5) };
  }

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
    let html = `<div class="marker-title">Time: ${row.__timeRaw}</div><div class="marker-list">`;
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

  const buildColumnList = (cols) => {
    columnsContainer.innerHTML = "";
    cols.forEach((c, i) => {
      if (/time|timestamp|date/i.test(c)) return;
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

  const buildPlots = () => {
    if (!parsed) return;
    const timeInfo = buildXFromTimeColumn(parsed.data);
    const selected = [...columnsContainer.querySelectorAll("input:checked")].map(x => x.dataset.col);
    if (!selected.length) { plotsContainer.innerHTML = ""; plotMeta = []; return; }

    plotsContainer.innerHTML = "";
    plotMeta = [];
    const x = timeInfo.xVals;
    let xMin = 0, xMax = parsed.data.length;
    if (timeInfo.type === "numeric") {
      const vals = x.filter(v => Number.isFinite(v));
      xMin = Math.min(...vals); xMax = Math.max(...vals);
    } else if (timeInfo.type === "date") {
      const vals = x.map(v => Date.parse(v)).filter(v => Number.isFinite(v));
      xMin = Math.min(...vals); xMax = Math.max(...vals);
    }

    setStatus(`Ось X: ${timeInfo.type} (${timeInfo.sample.join(", ")})`);

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
        xaxis: { title: "time", type: timeInfo.type === "date" ? "date" : "linear" },
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
            if (timeInfo.type === "date") {
              r0 = Date.parse(r0);
              r1 = Date.parse(r1);
            }
            // 🚧 ограничиваем диапазон
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
