// DoKu Log Viewer — v2.0
// RomRaider / EcuFlash CSV · Multi-file · Overlay + Stacked · Synchronized zoom

'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const FILE_COLORS = [
  '#3b82f6', '#f59e0b', '#10b981', '#a78bfa', '#f97316', '#ec4899'
];

const PARAM_GROUPS = [
  { id: 'engine',  label: 'Двигатель',    patterns: [/rpm|revs|engine.speed/i] },
  { id: 'fuel',    label: 'Топливо',      patterns: [/afr|lambda|fueling|inj|duty|fuel|o2|wbo2|faf|learning/i] },
  { id: 'boost',   label: 'Наддув',       patterns: [/boost|manifold|map|baro|pressure|maf|air/i] },
  { id: 'temps',   label: 'Температуры',  patterns: [/temp|coolant|iat|oil|egt|water/i] },
  { id: 'ignition',label: 'Зажигание',    patterns: [/knock|timing|advance|retard|ign/i] },
  { id: 'throttle',label: 'Дроссель',     patterns: [/tps|throttle|pedal/i] },
  { id: 'speed',   label: 'Скорость',     patterns: [/speed|gear|vehicle|mph|kmh|kph/i] },
  { id: 'battery', label: 'Питание',      patterns: [/batt|volt/i] },
  { id: 'other',   label: 'Прочее',       patterns: [/.*/] },
];

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = {
  files: [],          // { id, name, color, rows, headers, units, timeKey, timeValues }
  mode: 'stacked',   // 'stacked' | 'overlay'
  selectedParams: new Set(),
  axisAssign: {},     // param → 'y1' | 'y2'  (overlay mode)
  plots: [],          // { div, param, fileId? } in stacked; [{div}] in overlay
  zoomRange: null,    // { xMin, xMax }
  syncZoom: false,
};

// ─── DOM REFS ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const fileInput       = $('fileInput');
const fileList        = $('fileList');
const paramsSection   = $('paramsSection');
const paramGroups     = $('paramGroups');
const paramSearchInput= $('paramSearchInput');
const plotsContainer  = $('plotsContainer');
const emptyState      = $('emptyState');
const crosshairBar    = $('crosshairBar');
const crosshairTime   = $('crosshairTime');
const crosshairValues = $('crosshairValues');
const topbarStatus    = $('topbarStatus');
const resetZoomBtn    = $('resetZoomBtn');
const syncZoomBtn     = $('syncZoomBtn');
const modeStacked     = $('modeStacked');
const modeOverlay     = $('modeOverlay');
const overlaySection  = $('overlaySection');
const axisAssignEl    = $('axisAssign');
const sidebarToggle   = $('sidebarToggle');
const sidebar         = $('sidebar');

// ─── CSV PARSER ───────────────────────────────────────────────────────────────

function detectDelimiter(txt) {
  const sample = txt.slice(0, 2000);
  const commas = (sample.match(/,/g) || []).length;
  const semis  = (sample.match(/;/g) || []).length;
  const tabs   = (sample.match(/\t/g) || []).length;
  if (tabs > commas && tabs > semis) return '\t';
  return semis > commas ? ';' : ',';
}

function splitLine(line, d) {
  const out = [];
  let cur = '', q = false;
  for (const c of line) {
    if (c === '"') { q = !q; continue; }
    if (!q && c === d) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// Splits "Engine Speed (rpm)" -> { name: "Engine Speed", unit: "rpm" }.
// Headers without a trailing (unit) are returned unchanged.
function splitHeaderNameUnit(raw) {
  const h = raw.trim();
  const m = h.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m && m[1].trim()) return { name: m[1].trim(), unit: m[2].trim() };
  return { name: h, unit: '' };
}

function parseCSV(text) {
  const d = detectDelimiter(text);
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV пуст');

  const headerLine = splitLine(lines[0], d);

  // Some exports (older RomRaider/EPCS) put units on a separate second row
  // instead of embedding them in the header, e.g. "RPM" / "(rpm)".
  let unitsLine = null;
  let dataStart = 1;
  if (lines.length > 2) {
    const secondRow = splitLine(lines[1], d);
    const isUnitsRow = secondRow.every(v =>
      v === '' || /^\(.*\)$/.test(v.trim()) || /^[a-z°%\/]{1,8}$/i.test(v.trim())
    ) && secondRow.some(v => v.trim() !== '');
    if (isUnitsRow) {
      unitsLine = secondRow;
      dataStart = 2;
    }
  }

  // Clean header names — split inline "(unit)" suffix when present,
  // otherwise fall back to the separate units row (if any).
  const headers = [];
  const units = [];
  headerLine.forEach((raw, i) => {
    const { name, unit } = splitHeaderNameUnit(raw);
    headers.push(name);
    units.push(unit || (unitsLine ? (unitsLine[i] || '').replace(/^\(|\)$/g, '').trim() : ''));
  });

  // Find time column (match against the CLEANED name)
  const timeKey = headers.find(h => /^time$/i.test(h) || /^timestamp$/i.test(h) || /utc/i.test(h)) || headers[0];
  const timeIdx = headers.indexOf(timeKey);

  const rows = [];
  for (let i = dataStart; i < lines.length; i++) {
    const vals = splitLine(lines[i], d);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ''; });
    rows.push(row);
  }

  // Parse time to float seconds (RomRaider: "0.000" format)
  const timeValues = rows.map(r => {
    const v = parseFloat(String(r[timeKey]).replace(',', '.'));
    return isNaN(v) ? null : v;
  });

  return { headers, units, timeKey, timeValues, rows };
}

// ─── FILE MANAGEMENT ──────────────────────────────────────────────────────────

function colorForIndex(i) { return FILE_COLORS[i % FILE_COLORS.length]; }

function addFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const parsed = parseCSV(e.target.result);
        const id = Date.now() + Math.random();
        const idx = state.files.length;
        state.files.push({
          id,
          name: file.name.replace(/\.csv$/i, ''),
          color: colorForIndex(idx),
          ...parsed
        });
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsText(file, 'utf-8');
  });
}

function removeFile(id) {
  state.files = state.files.filter(f => f.id !== id);
  rebuildAll();
}

function renderFileList() {
  fileList.innerHTML = '';
  state.files.forEach(f => {
    const item = document.createElement('div');
    item.className = 'file-item';

    const dot = document.createElement('div');
    dot.className = 'file-dot';
    dot.style.background = f.color;

    const name = document.createElement('div');
    name.className = 'file-name';
    name.title = f.name;
    name.textContent = f.name;

    const rows = document.createElement('div');
    rows.className = 'file-rows';
    rows.textContent = f.rows.length + 'r';

    const rm = document.createElement('button');
    rm.className = 'file-remove';
    rm.title = 'Удалить';
    rm.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    rm.addEventListener('click', () => removeFile(f.id));

    item.append(dot, name, rows, rm);
    fileList.appendChild(item);
  });
}

// ─── PARAMETER MANAGEMENT ─────────────────────────────────────────────────────

function getAllParams() {
  // Collect unique param names across all files, skip time columns
  const seen = new Map(); // name → { unit }
  state.files.forEach(f => {
    f.headers.forEach((h, i) => {
      if (h === f.timeKey) return;
      if (!seen.has(h)) seen.set(h, { unit: f.units[i] || '' });
    });
  });
  return seen;
}

function groupParam(name) {
  for (const g of PARAM_GROUPS) {
    if (g.patterns.some(p => p.test(name))) return g.id;
  }
  return 'other';
}

function renderParamGroups(filter = '') {
  const allParams = getAllParams();
  const fl = filter.toLowerCase();

  // Build group buckets
  const grouped = {};
  PARAM_GROUPS.forEach(g => { grouped[g.id] = []; });

  allParams.forEach(({ unit }, name) => {
    if (fl && !name.toLowerCase().includes(fl)) return;
    const gid = groupParam(name);
    grouped[gid].push({ name, unit });
  });

  paramGroups.innerHTML = '';

  PARAM_GROUPS.forEach(g => {
    const items = grouped[g.id];
    if (!items.length) return;

    const grpEl = document.createElement('div');
    grpEl.className = 'param-group' + (filter ? ' open' : ' open'); // open by default with filter; also open by default for usability
    grpEl.dataset.gid = g.id;

    const header = document.createElement('div');
    header.className = 'param-group-header';
    header.textContent = g.label + ` (${items.length})`;
    header.addEventListener('click', () => grpEl.classList.toggle('open'));

    const itemsEl = document.createElement('div');
    itemsEl.className = 'param-group-items';

    items.forEach(({ name, unit }) => {
      const row = document.createElement('label');
      row.className = 'param-item';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.dataset.param = name;
      chk.checked = state.selectedParams.has(name);
      chk.addEventListener('change', () => {
        if (chk.checked) state.selectedParams.add(name);
        else state.selectedParams.delete(name);
        onParamChange(name, chk.checked);
      });

      const lbl = document.createElement('span');
      lbl.className = 'param-label';
      lbl.title = name;
      lbl.textContent = name;

      const unt = document.createElement('span');
      unt.className = 'param-unit';
      unt.textContent = unit;

      row.append(chk, lbl, unt);
      itemsEl.appendChild(row);
    });

    grpEl.append(header, itemsEl);
    paramGroups.appendChild(grpEl);
  });
}

function onParamChange(param, selected) {
  if (state.mode === 'overlay') {
    if (selected) state.axisAssign[param] = state.axisAssign[param] || 'y1';
    else delete state.axisAssign[param];
    renderAxisAssign();
    buildOverlay();
  } else {
    if (selected) addStackedPlot(param);
    else removeStackedPlot(param);
  }
  updateStatus();
}

// ─── AXIS ASSIGN (overlay) ────────────────────────────────────────────────────

function renderAxisAssign() {
  axisAssignEl.innerHTML = '';
  state.selectedParams.forEach(param => {
    const row = document.createElement('div');
    row.className = 'axis-row';

    const lbl = document.createElement('span');
    lbl.textContent = param;
    lbl.style.flex = '1';
    lbl.style.overflow = 'hidden';
    lbl.style.textOverflow = 'ellipsis';

    const sel = document.createElement('select');
    ['y1', 'y2'].forEach(ax => {
      const opt = document.createElement('option');
      opt.value = ax;
      opt.textContent = ax === 'y1' ? 'Ось 1' : 'Ось 2';
      if (state.axisAssign[param] === ax) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      state.axisAssign[param] = sel.value;
      buildOverlay();
    });

    row.append(lbl, sel);
    axisAssignEl.appendChild(row);
  });
}

// ─── PLOTLY HELPERS ───────────────────────────────────────────────────────────

const PLOTLY_LAYOUT_BASE = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: '#0d0f14',
  font: { family: 'IBM Plex Mono, monospace', color: '#6b7591', size: 11 },
  margin: { t: 8, l: 52, r: 12, b: 36 },
  xaxis: {
    gridcolor: '#1c2030',
    linecolor: '#252a3a',
    tickcolor: '#252a3a',
    zerolinecolor: '#252a3a',
    color: '#6b7591',
    type: 'linear',
  },
  yaxis: {
    gridcolor: '#1c2030',
    linecolor: '#252a3a',
    tickcolor: '#252a3a',
    zerolinecolor: '#1c2030',
    color: '#6b7591',
    fixedrange: false,
  },
  hovermode: 'x unified',
  hoverlabel: {
    bgcolor: '#141720',
    bordercolor: '#252a3a',
    font: { family: 'IBM Plex Mono, monospace', size: 11, color: '#e2e6f0' }
  },
  dragmode: 'pan',
  showlegend: false,
};

const PLOTLY_CONFIG = {
  displayModeBar: false,
  responsive: true,
  scrollZoom: true,
};

function getTimeX(file) {
  return file.timeValues;
}

function getY(file, param) {
  return file.rows.map(r => {
    const v = parseFloat(String(r[param] ?? '').replace(',', '.'));
    return isNaN(v) ? null : v;
  });
}

function makeTrace(file, param, overrides = {}) {
  return {
    x: getTimeX(file),
    y: getY(file, param),
    mode: 'lines',
    name: state.files.length > 1 ? file.name : param,
    line: { color: file.color, width: 1.5 },
    connectgaps: false,
    hovertemplate: `%{y:.3f}<extra>${file.name}</extra>`,
    ...overrides,
  };
}

// ─── STACKED MODE ─────────────────────────────────────────────────────────────

function buildStacked() {
  plotsContainer.innerHTML = '';
  plotsContainer.className = 'plots-container';
  state.plots = [];

  // Decide empty-state from the SELECTION, not from state.plots — the
  // Plotly.newPlot() calls below resolve asynchronously, so state.plots
  // is still empty at this point even when params are selected.
  showEmpty(state.selectedParams.size === 0);

  state.selectedParams.forEach(param => {
    appendStackedCard(param);
  });
}

function appendStackedCard(param) {
  const unit = getUnitForParam(param);

  const card = document.createElement('div');
  card.className = 'plot-card';
  card.dataset.param = param;

  const title = document.createElement('div');
  title.className = 'plot-title';
  title.innerHTML = `<span class="plot-title-name">${param}</span>${unit ? `<span class="plot-title-unit">(${unit})</span>` : ''}`;

  const div = document.createElement('div');
  div.className = 'plot-div';

  card.append(title, div);
  plotsContainer.appendChild(card);

  const traces = state.files.map(f => makeTrace(f, param));
  const layout = buildStackedLayout(param, unit);

  Plotly.newPlot(div, traces, layout, PLOTLY_CONFIG).then(() => {
    attachZoomSync(div, param);
    attachCrosshair(div, param);
    state.plots.push({ div, param });
  });
}

function addStackedPlot(param) {
  appendStackedCard(param);
  showEmpty(false);
}

function removeStackedPlot(param) {
  const card = plotsContainer.querySelector(`[data-param="${CSS.escape(param)}"]`);
  if (card) card.remove();
  state.plots = state.plots.filter(p => p.param !== param);
  showEmpty(state.plots.length === 0);
}

function buildStackedLayout(param, unit) {
  return {
    ...PLOTLY_LAYOUT_BASE,
    xaxis: {
      ...PLOTLY_LAYOUT_BASE.xaxis,
      title: { text: 'Time (s)', font: { size: 10 } },
      range: state.zoomRange ? [state.zoomRange.xMin, state.zoomRange.xMax] : undefined,
    },
    yaxis: {
      ...PLOTLY_LAYOUT_BASE.yaxis,
      title: { text: unit || '', font: { size: 10 }, standoff: 6 },
    },
    showlegend: state.files.length > 1,
    legend: {
      orientation: 'h',
      x: 0, y: -0.25,
      font: { size: 10 },
      bgcolor: 'transparent',
    },
  };
}

// ─── OVERLAY MODE ─────────────────────────────────────────────────────────────

function buildOverlay() {
  plotsContainer.innerHTML = '';
  plotsContainer.className = 'plots-container overlay-mode';
  state.plots = [];

  if (!state.selectedParams.size) {
    showEmpty(true);
    return;
  }
  showEmpty(false);

  const card = document.createElement('div');
  card.className = 'plot-card';

  const div = document.createElement('div');
  div.className = 'plot-div';
  card.appendChild(div);
  plotsContainer.appendChild(card);

  const traces = [];
  let hasY2 = false;

  state.files.forEach(file => {
    state.selectedParams.forEach(param => {
      const axis = state.axisAssign[param] || 'y1';
      if (axis === 'y2') hasY2 = true;

      const paramColor = paramColorInOverlay(param);
      const lineColor = state.files.length > 1 ? file.color : paramColor;

      traces.push(makeTrace(file, param, {
        name: state.files.length > 1 ? `${file.name} · ${param}` : param,
        line: { color: lineColor, width: 1.5 },
        yaxis: axis === 'y2' ? 'y2' : 'y',
        hovertemplate: `%{y:.3f}<extra>${file.name} · ${param}</extra>`,
      }));
    });
  });

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    showlegend: true,
    legend: {
      orientation: 'h',
      x: 0, y: -0.12,
      font: { size: 10 },
      bgcolor: 'transparent',
    },
    xaxis: {
      ...PLOTLY_LAYOUT_BASE.xaxis,
      title: { text: 'Time (s)', font: { size: 10 } },
      range: state.zoomRange ? [state.zoomRange.xMin, state.zoomRange.xMax] : undefined,
    },
    yaxis: {
      ...PLOTLY_LAYOUT_BASE.yaxis,
      title: { text: 'Ось 1', font: { size: 10 } },
    },
    ...(hasY2 ? {
      yaxis2: {
        ...PLOTLY_LAYOUT_BASE.yaxis,
        overlaying: 'y',
        side: 'right',
        title: { text: 'Ось 2', font: { size: 10 } },
        showgrid: false,
      }
    } : {}),
    margin: { ...PLOTLY_LAYOUT_BASE.margin, r: hasY2 ? 52 : 12 },
  };

  Plotly.newPlot(div, traces, layout, PLOTLY_CONFIG).then(() => {
    attachZoomSync(div, '__overlay__');
    attachCrosshair(div, '__overlay__');
    state.plots.push({ div, param: '__overlay__' });
  });
}

// Derive a color per-param in overlay (cycle through a warm palette)
const OVERLAY_PARAM_COLORS = [
  '#3b82f6','#f59e0b','#10b981','#a78bfa','#f97316','#ec4899','#06b6d4','#84cc16'
];
let _paramColorMap = {};
let _paramColorIdx = 0;
function paramColorInOverlay(param) {
  if (!_paramColorMap[param]) {
    _paramColorMap[param] = OVERLAY_PARAM_COLORS[_paramColorIdx % OVERLAY_PARAM_COLORS.length];
    _paramColorIdx++;
  }
  return _paramColorMap[param];
}

// ─── ZOOM SYNC ────────────────────────────────────────────────────────────────

let _zoomLock = false;

function attachZoomSync(div, param) {
  div.on('plotly_relayout', data => {
    if (_zoomLock) return;
    const x0 = data['xaxis.range[0]'];
    const x1 = data['xaxis.range[1]'];

    if (x0 !== undefined && x1 !== undefined) {
      state.zoomRange = { xMin: x0, xMax: x1 };
      resetZoomBtn.disabled = false;
      if (state.syncZoom) syncAllZoom(div, x0, x1);
    }

    if (data['xaxis.autorange']) {
      state.zoomRange = null;
      resetZoomBtn.disabled = true;
      if (state.syncZoom) resetAllZoom(div);
    }
  });
}

function syncAllZoom(source, x0, x1) {
  _zoomLock = true;
  state.plots.forEach(p => {
    if (p.div === source) return;
    Plotly.relayout(p.div, { 'xaxis.range': [x0, x1] });
  });
  _zoomLock = false;
}

function resetAllZoom(source) {
  _zoomLock = true;
  state.plots.forEach(p => {
    if (p.div === source) return;
    Plotly.relayout(p.div, { 'xaxis.autorange': true });
  });
  _zoomLock = false;
}

// ─── CROSSHAIR ────────────────────────────────────────────────────────────────

function attachCrosshair(div, param) {
  div.on('plotly_hover', data => {
    if (!data.points || !data.points[0]) return;
    const pt = data.points[0];
    const xVal = pt.x;

    // Draw vertical line on all stacked plots
    if (state.mode === 'stacked') {
      state.plots.forEach(p => {
        Plotly.relayout(p.div, {
          shapes: [{
            type: 'line',
            x0: xVal, x1: xVal,
            y0: 0, y1: 1,
            xref: 'x', yref: 'paper',
            line: { color: '#f59e0b', width: 1, dash: 'dot' }
          }]
        });
      });
    }

    updateCrosshairBar(xVal);
  });

  div.on('plotly_unhover', () => {
    // Keep crosshair visible until next hover on different chart
  });
}

function updateCrosshairBar(xVal) {
  crosshairBar.style.display = 'flex';
  crosshairTime.textContent = typeof xVal === 'number' ? xVal.toFixed(3) + ' s' : xVal;

  crosshairValues.innerHTML = '';

  state.files.forEach(file => {
    // Find closest row
    const idx = findClosestIndex(file.timeValues, xVal);
    if (idx === -1) return;
    const row = file.rows[idx];

    state.selectedParams.forEach(param => {
      const val = row[param];
      const numVal = parseFloat(String(val).replace(',', '.'));
      const unit = getUnitForParam(param);

      const item = document.createElement('div');
      item.className = 'cv-item';

      if (state.files.length > 1) {
        const dot = document.createElement('div');
        dot.className = 'cv-dot';
        dot.style.background = file.color;
        item.appendChild(dot);
      }

      const nm = document.createElement('span');
      nm.className = 'cv-name';
      nm.textContent = state.files.length > 1 ? `${param}` : param;

      const vl = document.createElement('span');
      vl.className = 'cv-val';
      vl.textContent = isNaN(numVal) ? (val || '—') : numVal.toFixed(2);

      const un = document.createElement('span');
      un.className = 'cv-unit';
      un.textContent = unit;

      item.append(nm, vl, un);
      crosshairValues.appendChild(item);
    });
  });
}

function findClosestIndex(timeValues, target) {
  if (!timeValues || !timeValues.length) return -1;
  let lo = 0, hi = timeValues.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeValues[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getUnitForParam(param) {
  for (const f of state.files) {
    const idx = f.headers.indexOf(param);
    if (idx !== -1 && f.units[idx]) return f.units[idx];
  }
  return '';
}

function showEmpty(yes) {
  emptyState.style.display = yes ? 'flex' : 'none';
  plotsContainer.style.display = yes ? 'none' : '';
}

function updateStatus() {
  const n = state.files.length;
  const p = state.selectedParams.size;
  if (n === 0) {
    topbarStatus.textContent = 'Загрузите CSV-лог RomRaider / EcuFlash';
    return;
  }
  topbarStatus.textContent =
    `${n} файл${n > 1 ? 'а' : ''} · ${p} параметр${p === 1 ? '' : p < 5 ? 'а' : 'ов'} · ${state.mode === 'overlay' ? 'Overlay' : 'Стек'}`;
}

function rebuildAll() {
  // Any full rebuild (file added/removed, mode switch) should start
  // from the full data range — stale zoom from a previous view should
  // never silently carry over and truncate the new charts.
  state.zoomRange = null;
  resetZoomBtn.disabled = true;

  renderFileList();
  if (state.files.length === 0) {
    paramsSection.style.display = 'none';
    overlaySection.style.display = 'none';
    plotsContainer.innerHTML = '';
    showEmpty(true);
    resetZoomBtn.disabled = true;
    syncZoomBtn.disabled = true;
    updateStatus();
    return;
  }

  paramsSection.style.display = '';
  overlaySection.style.display = state.mode === 'overlay' ? '' : 'none';
  syncZoomBtn.disabled = false;

  // Remove selected params that no longer exist in any file
  const allParams = getAllParams();
  [...state.selectedParams].forEach(p => {
    if (!allParams.has(p)) state.selectedParams.delete(p);
  });

  renderParamGroups(paramSearchInput.value);
  _paramColorMap = {};
  _paramColorIdx = 0;

  if (state.mode === 'stacked') buildStacked();
  else buildOverlay();

  updateStatus();
}

// ─── EVENT HANDLERS ───────────────────────────────────────────────────────────

fileInput.addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;

  for (const f of files) {
    try { await addFile(f); }
    catch (err) { console.error('Parse error:', err); }
  }

  fileInput.value = '';
  rebuildAll();
});

$('selectAllBtn').addEventListener('click', () => {
  getAllParams().forEach((_, name) => state.selectedParams.add(name));
  rebuildAll();
});

$('deselectAllBtn').addEventListener('click', () => {
  state.selectedParams.clear();
  rebuildAll();
});

paramSearchInput.addEventListener('input', () => {
  renderParamGroups(paramSearchInput.value);
});

modeStacked.addEventListener('click', () => {
  if (state.mode === 'stacked') return;
  state.mode = 'stacked';
  modeStacked.classList.add('active');
  modeOverlay.classList.remove('active');
  rebuildAll();
});

modeOverlay.addEventListener('click', () => {
  if (state.mode === 'overlay') return;
  state.mode = 'overlay';
  modeOverlay.classList.add('active');
  modeStacked.classList.remove('active');
  rebuildAll();
});

resetZoomBtn.addEventListener('click', () => {
  state.zoomRange = null;
  state.plots.forEach(p => {
    Plotly.relayout(p.div, { 'xaxis.autorange': true });
  });
  resetZoomBtn.disabled = true;
});

syncZoomBtn.addEventListener('click', () => {
  state.syncZoom = !state.syncZoom;
  syncZoomBtn.style.color = state.syncZoom ? 'var(--accent)' : '';
  syncZoomBtn.style.borderColor = state.syncZoom ? 'var(--accent)' : '';
  syncZoomBtn.title = state.syncZoom ? 'Синхронизация включена' : 'Синхронизировать зум';
});

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  setTimeout(() => {
    state.plots.forEach(p => Plotly.Plots.resize(p.div));
  }, 220);
});

// ─── INIT ─────────────────────────────────────────────────────────────────────

showEmpty(true);
updateStatus();
