// Subaru Log Viewer — script.js (use time column raw values for X)
// Replace only this file. After upload open page with ?v=999 to avoid cache.

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

  function setStatus(msg, ok = true) {
    status.textContent = msg;
    status.style.color = ok ? "#064e3b" : "#b91c1c";
  }

  function detectDelimiter(txt) {
    const lines = txt.split(/\r?\n/).filter(l => l.trim()).slice(0, 5);
    let c = 0, s = 0;
    lines.forEach(l => { c += (l.match(/,/g) || []).length; s += (l.match(/;/g) || []).length; });
    return s > c ? ";" : ",";
  }

  function splitLine(line, d) {
    const res = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && ch === d) { res.push(cur); cur = ""; } else cur += ch;
    }
    res.push(cur);
    return res.map(v => v.replace(/^\uFEFF|\u200B/g, "").trim());
  }

  // CSV -> { fields, data }, keep raw time string in row.__timeRaw
  function parseCSV(txt) {
    const d = detectDelimiter(txt);
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("Файл слишком короткий или пуст");
    const head = splitLine(lines[0], d);
    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = splitLine(lines[i], d);
      const obj = {};
      for (let j = 0; j < head.length; j++) obj[head[j]] = vals[j] ?? null;
      data.push(obj);
    }
    // detect time column name
    const timeKey = head.find(h => /time|timestamp|utc|date/i.test(h)) || head[0];
    // store raw time string for each row
    data.forEach(r => { r.__timeRaw = String(r[timeKey] ?? ""); });
    return { fields: head, data, timeKey };
  }

  // Try to convert raw time strings into numbers.
  // Returns object { type: "numeric"|"date"|"string", xVals, info }
  function buildXFromTimeColumn(rows) {
    const raw = rows.map(r => r.__timeRaw);
    // try numeric parse
    const nums = raw.map(s => {
      if (s == null) return NaN;
      const t = String(s).trim().replace(",", ".");
      const n = Number(t);
      return Number.isFinite(n) ? n : NaN;
    });
    const numericCount = nums.filter(v => Number.isFinite(v)).length;
    // if most values numeric => use numeric axis
    if (numericCount / raw.length > 0.85) {
      // use numeric values as-is
      return { type: "numeric", xVals: nums, info: `numeric (${numericCount}/${raw.length})`, sample: raw.slice(0,6) };
    }

    // try time hh:mm:ss(.ms) -> convert to Date objects of today
    const dateObjs = raw.map(s => {
      if (!s) return null;
      // try full Date.parse first (ISO)
      const p = Date.parse(s);
      if (!Number.isNaN(p)) return new Date(p);
      // try hh:mm:ss.mmm
      const m = String(s).match(/^\s*(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
      if (m) {
        const now = new Date();
        const h = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]), ms = Number(m[4] || 0);
        const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mm, ss, ms);
        return dt;
      }
      return null;
    });
    const dateCount = dateObjs.filter(v => v instanceof Date && !isNaN(v)).length;
    if (dateCount / raw.length > 0.75) {
      return { type: "date", xVals: dateObjs.map(d => (d ? d.toISOString() : null)), info: `date-like (${dateCount}/${raw.length})`, sample: raw.slice(0,6) };
    }

    // fallback: use raw strings (categorical)
    return { type: "string", xVals: raw, info: `string fallback`, sample: raw.slice(0,6) };
  }

  function buildColumnList(cols) {
    columnsContainer.innerHTML = "";
    cols.forEach((c, i) => {
      if (/time|timestamp|date|utc/i.test(c)) return; // skip time in selection
      const el = document.createElement("div"); el.className = "column-item";
      const chk = document.createElement("input"); chk.type = "checkbox"; chk.id = "col_" + i; chk.dataset.col = c;
      if (/afr|rpm|maf|inj|duty|boost|press/i.test(c)) chk.checked = true;
      const lb = document.createElement("label"); lb.htmlFor = chk.id; lb.textContent = c;
      el.append(chk, lb); columnsContainer.append(el);
      chk.addEventListener("change", buildPlots);
    });
  }

  function clamp(a, b, min, max) {
    let s = a, e = b;
    const w = e - s;
    if (w <= 0) return [min, max];
    if (s < min) { s = min; e = s + w; }
    if (e > max) { e = max; s = e - w; }
    return [s, e];
  }

  function updateMarkerBox(index) {
    if (!parsed || !parsed.data[index]) return;
    const row = parsed.data[index];
    let html = `<div class="marker-title">Time: ${row.__timeRaw}</div><div class="marker-list">`;
    plotMeta.forEach(m => {
      const v = parsed.data[index][m.col];
      html += `<div class="marker-row"><span class="marker-key">${m.col}</span><span class="marker-val">${v ?? '-'}</span></div>`;
    });
    html += "</div>";
    markerBox.innerHTML = html;
    markerBox.style.display = "block";
  }

  function drawMarkersAllDebounced(xVal) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      plotMeta.forEach(m => {
        try {
          Plotly.relayout(m.div, { shapes: [{ type: "line", x0: xVal, x1: xVal, y0: 0, y1: 1, xref: "x", yref: "paper", line: { color: "#ef4444", width: 1.2 } }] });
        } catch (e) { /* ignore */ }
      });
    }, 40);
  }

  function applyRangeToAll(range) {
    plotMeta.forEach(m => {
      try { Plotly.relayout(m.div, { "xaxis.range": range }); } catch (e) {}
    });
  }

  hSlider.addEventListener("input", () => {
    if (!plotMeta.length) return;
    const m0 = plotMeta[0];
    const xMin = m0.xMin, xMax = m0.xMax;
    const pct = Number(hSlider.value) / 100;
    const width = (m0.range ? m0.range[1] - m0.range[0] : (xMax - xMin) / 6);
    const center = xMin + pct * (xMax - xMin);
    const [s, e] = clamp(center - width / 2, center + width / 2, xMin, xMax);
    applyRangeToAll([s, e]);
    plotMeta.forEach(p => p.range = [s, e]);
  });

  // Build plots using x computed from time column raw values
  function buildPlots() {
    if (!parsed) return;
    const timeInfo = buildXFromTimeColumn(parsed.data); // {type, xVals, info, sample}
    const selected = [...columnsContainer.querySelectorAll("input:checked")].map(x => x.dataset.col);
    if (!selected.length) { plotsContainer.innerHTML = ""; plotMeta = []; setStatus(`Построено 0 графиков — ${parsed.data.length} точек`); return; }

    plotsContainer.innerHTML = "";
    plotMeta = [];

    const xValsRaw = timeInfo.xVals;
    // compute numeric X bounds if numeric or date
    let xMin = 0, xMax = 0;
    if (timeInfo.type === "numeric") {
      const nums = xValsRaw.map(v => Number.isFinite(v) ? v : NaN);
      xMin = Math.min(...nums.filter(v => Number.isFinite(v)));
      xMax = Math.max(...nums.filter(v => Number.isFinite(v)));
    } else if (timeInfo.type === "date") {
      const nums = xValsRaw.map(v => v ? Date.parse(v) : NaN);
      xMin = Math.min(...nums.filter(v => Number.isFinite(v)));
      xMax = Math.max(...nums.filter(v => Number.isFinite(v)));
    } else {
      // for string categorical, use index as axis (0..n-1)
      xMin = 0; xMax = parsed.data.length - 1;
    }

    // sample status to help debug
    setStatus(`Использую столбец времени как ось X — тип: ${timeInfo.type}. Примеры: ${timeInfo.sample.join(", ")}`, true);

    const builds = selected.map(col => {
      // build y
      const y = parsed.data.map(r => {
        const n = parseFloat((r[col] ?? "").toString().replace(",", "."));
        return Number.isFinite(n) ? n : null;
      });

      // build x for this trace: depending on type, supply numbers/dates/strings
      let traceX;
      if (timeInfo.type === "numeric") traceX = xValsRaw; // numbers
      else if (timeInfo.type === "date") traceX = xValsRaw; // ISO strings
      else {
        // use indices for plotting, but label ticks with raw values
        traceX = parsed.data.map((_, idx) => idx);
      }

      const div = document.createElement("div");
      div.className = "plot";
      plotsContainer.appendChild(div);

      const trace = { x: traceX, y: y, mode: "lines", name: col, line: { width: 2.6 } };

      // layout: pick xaxis type
      const layout = {
        title: col,
        margin: { t: 36, b: 44, l: 50, r: 10 },
        yaxis: { fixedrange: true }
      };

      if (timeInfo.type === "numeric") {
        layout.xaxis = { title: "time (raw)", type: "linear" };
      } else if (timeInfo.type === "date") {
        layout.xaxis = { title: "time (date)", type: "date", tickformat: "%H:%M:%S" };
      } else {
        layout.xaxis = { title: "index", type: "linear", tickmode: "array", tickvals: [0, Math.floor(parsed.data.length/2), parsed.data.length-1], ticktext: [parsed.data[0].__timeRaw, parsed.data[Math.floor(parsed.data.length/2)].__timeRaw, parsed.data[parsed.data.length-1].__timeRaw] };
      }

      return Plotly.newPlot(div, [trace], layout, CONFIG).then(() => {
        // meta
        const meta = { div, col, xMin, xMax, range: [xMin, Math.min(xMax, xMin + (xMax - xMin) / 6)] };
        plotMeta.push(meta);

        // disable touch-action on svg if present (prevent single-finger zoom on iOS)
        try {
          const svg = div.querySelector(".main-svg");
          if (svg) svg.style.touchAction = "none";
        } catch (e) {}

        // handlers
        const handler = ev => {
          const p = ev.points && ev.points[0];
          if (!p) return;
          markerX = p.x;
          // if categorical mapped to index, pointNumber gives index already
          const rowIndex = p.pointNumber !== undefined ? p.pointNumber : 0;
          updateMarkerBox(rowIndex);
          drawMarkersAllDebounced(markerX);
        };
        div.on("plotly_click", handler);
        div.on("plotly_hover", handler);

        div.on("plotly_relayout", ev => {
          if (ev["xaxis.range[0]"] !== undefined && ev["xaxis.range[1]"] !== undefined) {
            let r0 = ev["xaxis.range[0]"], r1 = ev["xaxis.range[1]"];
            // If date strings, relayout may provide ISO strings -> convert to ms
            if (timeInfo.type === "date") {
              r0 = Date.parse(r0);
              r1 = Date.parse(r1);
            }
            const [s, e] = clamp(r0, r1, meta.xMin, meta.xMax);
            applyRangeToAll([s, e]);
            plotMeta.forEach(p => p.range = [s, e]);
          } else if (ev["xaxis.autorange"] !== undefined) {
            applyRangeToAll([meta.xMin, meta.xMax]);
            plotMeta.forEach(p => p.range = [meta.xMin, meta.xMax]);
          }
        });
      });
    });

    Promise.all(builds).then(() => {
      resetZoomBtn.disabled = false;
      setStatus(`Построено ${plotMeta.length} графиков — ${parsed.data.length} точек`);
    }).catch(err => {
      setStatus("Ошибка при построении графиков: " + (err && err.message ? err.message : err), false);
    });
  }

  // attach file handler
  fileInput.addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    if (!f) { setStatus("Файл не выбран", false); return; }
    const fr = new FileReader();
    setStatus("Чтение файла...");
    fr.onload = ev => {
      try {
        parsed = parseCSV(ev.target.result);
        setStatus(`Файл загружен — ${parsed.data.length} строк. Использую столбец времени: ${parsed.timeKey}`);
        buildColumnList(parsed.fields);
        selectAllBtn.disabled = deselectAllBtn.disabled = false;
        buildPlots();
      } catch (err) {
        setStatus("Ошибка парсинга: " + (err && err.message ? err.message : err), false);
      }
    };
    fr.onerror = () => setStatus("Ошибка чтения файла", false);
    fr.readAsText(f, "utf-8");
  });

  resetZoomBtn.addEventListener("click", () => {
    if (!plotMeta.length) return;
    const { xMin, xMax } = plotMeta[0];
    const r = [xMin, xMin + (xMax - xMin) / 6];
    applyRangeToAll(r);
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
