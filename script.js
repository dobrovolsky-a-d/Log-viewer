// Subaru Log Viewer — PRO Lite 1.0 FINAL
// Mobile-first. Stable. X = Time as string. No zoom. No drag.

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  const columnsContainer = document.getElementById("columnsContainer");
  const plotsContainer = document.getElementById("plotsContainer");
  const markerBox = document.getElementById("markerData");
  const status = document.getElementById("status");

  let parsed = null;
  let plots = [];
  let lastMarkerX = null;

  const CONFIG = {
    displayModeBar: false,
    responsive: true,
    scrollZoom: false,
    doubleClick: false
  };

  function setStatus(text, ok = true) {
    status.textContent = text;
    status.style.color = ok ? "#064e3b" : "#b91c1c";
  }

  // ---------- CSV ----------
  function detectDelimiter(txt) {
    return txt.indexOf(";") > txt.indexOf(",") ? ";" : ",";
  }

  function splitLine(line, d) {
    const out = [];
    let cur = "", q = false;
    for (let c of line) {
      if (c === '"') { q = !q; continue; }
      if (!q && c === d) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(v => v.trim());
  }

  function parseCSV(txt) {
    const d = detectDelimiter(txt);
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw "CSV пуст";

    const head = splitLine(lines[0], d);
    const rows = lines.slice(1).map(l => {
      const vals = splitLine(l, d);
      const o = {};
      head.forEach((h, i) => o[h] = vals[i] ?? "");
      return o;
    });

    const timeKey = head.find(h => /time|timestamp|utc/i.test(h)) || head[0];
    rows.forEach(r => r.__time = r[timeKey]);

    return { head, rows };
  }

  // ---------- UI ----------
  function buildColumnList(cols) {
    columnsContainer.innerHTML = "";
    cols.forEach((c, i) => {
      if (/time|timestamp|utc/i.test(c)) return;

      const wrap = document.createElement("div");
      wrap.className = "column-item";

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.dataset.col = c;
      chk.checked = /rpm|afr|maf|boost|inj|duty/i.test(c);

      const lab = document.createElement("label");
      lab.textContent = c;

      wrap.append(chk, lab);
      columnsContainer.append(wrap);

      chk.addEventListener("change", buildPlots);
    });
  }

  function updateMarker(rowIndex) {
    const row = parsed.rows[rowIndex];
    let html = `<div class="marker-title">Time: ${row.__time}</div>`;
    html += `<div class="marker-list">`;
    plots.forEach(p => {
      html += `
        <div class="marker-row">
          <span class="marker-key">${p.col}</span>
          <span class="marker-val">${row[p.col] || "-"}</span>
        </div>`;
    });
    html += `</div>`;
    markerBox.innerHTML = html;
    markerBox.style.display = "block";
  }

  function drawVerticalLine(x) {
    plots.forEach(p => {
      Plotly.relayout(p.div, {
        shapes: [{
          type: "line",
          x0: x,
          x1: x,
          y0: 0,
          y1: 1,
          xref: "x",
          yref: "paper",
          line: { color: "#ef4444", width: 1.5 }
        }]
      });
    });
  }

  // ---------- PLOTS ----------
  function buildPlots() {
    plotsContainer.innerHTML = "";
    plots = [];

    const selected = [...columnsContainer.querySelectorAll("input:checked")]
      .map(i => i.dataset.col);

    if (!selected.length) return;

    const x = parsed.rows.map(r => r.__time);

    selected.forEach(col => {
      const y = parsed.rows.map(r => {
        const v = parseFloat(String(r[col]).replace(",", "."));
        return isNaN(v) ? null : v;
      });

      const div = document.createElement("div");
      div.className = "plot";
      plotsContainer.append(div);

      Plotly.newPlot(div, [{
        x, y,
        mode: "lines",
        line: { width: 2 }
      }], {
        title: col,
        xaxis: {
          type: "category",
          title: "Time"
        },
        yaxis: {
          fixedrange: true
        },
        dragmode: false,
        hovermode: false,
        margin: { t: 36, l: 50, r: 10, b: 40 }
      }, CONFIG).then(() => {
        div.querySelector(".main-svg").style.touchAction = "manipulation";

        div.on("plotly_click", ev => {
          if (!ev.points || !ev.points[0]) return;
          const p = ev.points[0];
          lastMarkerX = p.x;
          updateMarker(p.pointNumber);
          drawVerticalLine(lastMarkerX);
        });

        plots.push({ div, col });
      });
    });

    setStatus(`Построено ${selected.length} графиков — ${parsed.rows.length} точек`);
  }

  // ---------- FILE ----------
  fileInput.addEventListener("change", e => {
    const f = e.target.files[0];
    if (!f) return;

    const r = new FileReader();
    setStatus("Чтение файла...");
    r.onload = ev => {
      try {
        parsed = parseCSV(ev.target.result);
        buildColumnList(parsed.head);
        buildPlots();
        setStatus(`Файл загружен — ${parsed.rows.length} строк`);
      } catch (err) {
        setStatus("Ошибка CSV", false);
      }
    };
    r.readAsText(f);
  });
});
