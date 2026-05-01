// main.js — wire DOM controls to state, render, and export.

import { state, setMode, subscribe, emit, loadSample, clearAll, updateRoom,
  toggleWall, setLoops, clearLoops, setTracingImage, updateTracingImage,
  removeTracingImage, undo, canUndo } from './state.js';
import { initRenderer, render, fitToContent, applyView, setViewport } from './render.js';
import { initEditor, resetCustomPolygon, resetFreeWall } from './editor.js';
import { generateLoops } from './loops.js';
import { summarise } from './calc.js';
import { exportSVG, exportCSV, printDrawing } from './export.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

const canvas = $('#canvas');
const statusBar = $('#status-bar');

initRenderer(canvas);
initEditor(canvas, { onStatus: setStatus });

function setStatus(msg, soft) {
  statusBar.textContent = msg;
  if (!soft) statusBar.dataset.kind = 'info';
}

// Project metadata bindings.
bindInput('#proj-title', v => state.project.title = v);
bindInput('#proj-client', v => state.project.client = v);
bindInput('#proj-number', v => state.project.projectNumber = v);
bindInput('#proj-scale', v => state.project.scale = parseInt(v, 10) || 50, true);

// Configuration bindings (regenerate-friendly).
bindInput('#cfg-spacing', v => state.config.pipeSpacing = num(v, 200), true);
bindInput('#cfg-edge', v => state.config.edgeSpacing = num(v, 100), true);
bindInput('#cfg-setback', v => state.config.wallSetback = num(v, 100), true);
bindInput('#cfg-edge-width', v => state.config.edgeZoneWidth = num(v, 1000), true);
bindInput('#cfg-maxloop', v => state.config.maxLoopLength = num(v, 100) * 1000, true);
bindInput('#cfg-bend', v => state.config.minBendRadius = num(v, 80), true);

function num(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function bindInput(sel, setter, isNumber = false) {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('input', () => {
    setter(isNumber ? el.value : el.value);
    emit();
  });
}

// Tool buttons.
$$('.tool').forEach(btn => {
  btn.addEventListener('click', () => {
    setMode(btn.dataset.mode);
    if (btn.dataset.mode !== 'draw-custom') resetCustomPolygon();
    if (btn.dataset.mode !== 'add-wall') resetFreeWall();
    setStatus(toolHint(btn.dataset.mode));
    $('#tool-hint').textContent = toolHint(btn.dataset.mode);
  });
});

function toolHint(mode) {
  switch (mode) {
    case 'select': return 'Tap a room to select it. Vertex handles appear on the selected room.';
    case 'draw-room': return 'Drag to draw a rectangular room.';
    case 'draw-custom': return 'Tap each corner in turn (edges snap to horizontal/vertical). Tap near the first corner to close.';
    case 'edit-walls': return 'Tap on (or near) a wall to toggle external/internal.';
    case 'add-wall': return 'Tap once for the start, then again for the other end — the wall snaps to horizontal/vertical and confirms on the second tap.';
    case 'add-door': return 'Tap on (or near) a wall to drop a door — pipe tails will route through it.';
    case 'merge-walls': return 'Tap a vertex (white circle) to merge the two walls meeting there into one.';
    case 'place-manifold': return 'Tap anywhere to place the manifold.';
    case 'draw-nogo': return 'Drag inside a room to add a no-go zone.';
    case 'move-image': return 'Drag the tracing image to position it. Drag the small square at the bottom-right corner to resize.';
    case 'delete': return 'Tap a vertex to merge walls; tap a wall, room, door, or no-go to delete it.';
    default: return '';
  }
}

// Top bar buttons.
// Tracing image: load a file, then expose width / opacity controls.
$('#trace-file').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const src = ev.target.result;
    const probe = new Image();
    probe.onload = () => {
      setTracingImage({
        src,
        naturalWidth: probe.naturalWidth,
        naturalHeight: probe.naturalHeight,
        widthMM: 10000, // default to 10 m wide; user adjusts via the slider
      });
      setStatus('Image loaded. Use the Move Image tool to position it, then trace your rooms over it.');
    };
    probe.src = src;
  };
  reader.readAsDataURL(file);
});

$('#trace-width').addEventListener('input', () => {
  const m = parseFloat($('#trace-width').value);
  if (!Number.isFinite(m) || m <= 0) return;
  updateTracingImage({ w: m * 1000 });
});

$('#trace-opacity').addEventListener('input', () => {
  const pct = parseInt($('#trace-opacity').value, 10);
  updateTracingImage({ opacity: pct / 100 });
});

$('#trace-remove').addEventListener('click', () => {
  removeTracingImage();
  $('#trace-file').value = '';
  setStatus('Tracing image removed.');
});

$('#btn-undo').addEventListener('click', () => {
  if (undo()) setStatus('Undone.');
});

// Cmd+Z (Mac, iPad keyboards) and Ctrl+Z (Windows) trigger undo.
window.addEventListener('keydown', e => {
  const isUndo = (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z');
  if (!isUndo) return;
  // Don't intercept undo while the user is typing in a text/number input.
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  if (undo()) setStatus('Undone.');
});

$('#btn-sample').addEventListener('click', () => {
  loadSample();
  setStatus('Sample plan loaded. Click "Generate Layout" to produce pipework.');
  setTimeout(() => fitToContent(), 30);
});

$('#btn-clear').addEventListener('click', () => {
  if (state.rooms.length === 0 && !state.manifold) return;
  if (!confirm('Clear the entire project?')) return;
  clearAll();
  setStatus('Project cleared.');
});

$('#btn-generate').addEventListener('click', () => {
  const { loops, warnings } = generateLoops(state);
  setLoops(loops, warnings);
  setStatus(`Generated ${loops.length} loop${loops.length === 1 ? '' : 's'}.`);
});

$('#btn-export-svg').addEventListener('click', () => {
  if (state.loops.length === 0 && state.rooms.length === 0) {
    alert('Nothing to export yet — draw rooms and generate a layout first.');
    return;
  }
  exportSVG();
});

$('#btn-export-csv').addEventListener('click', () => {
  if (state.loops.length === 0) {
    alert('Generate a layout first.');
    return;
  }
  exportCSV();
});

$('#btn-export-pdf').addEventListener('click', () => {
  if (state.rooms.length === 0) {
    alert('Draw rooms and generate a layout first.');
    return;
  }
  printDrawing();
});

// Canvas toolbar.
$('#btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
$('#btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
$('#btn-zoom-fit').addEventListener('click', () => { fitToContent(); render(); });

function zoomBy(factor) {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const wx = (cx - state.view.panX) / state.view.zoom;
  const wy = (cy - state.view.panY) / state.view.zoom;
  state.view.zoom *= factor;
  state.view.panX = cx - wx * state.view.zoom;
  state.view.panY = cy - wy * state.view.zoom;
  applyView();
  render();
  emit();
}

// Right panel — selected room editor.
const roomNameEl = $('#room-name');
const roomPatternEl = $('#room-pattern');
const roomFinishEl = $('#room-finish');
const roomZonesEl = $('#room-zones');
const roomAreaEl = $('#room-area');
// N/E/S/W checkboxes map to edge indices 0/1/2/3 on rectangular rooms.
const SIDE_TO_EDGE = { n: 0, e: 1, s: 2, w: 3 };
const wallChecks = {
  n: $('input[data-wall="n"]'),
  e: $('input[data-wall="e"]'),
  s: $('input[data-wall="s"]'),
  w: $('input[data-wall="w"]'),
};

roomNameEl.addEventListener('input', () => {
  const id = state.selection.id;
  if (id) updateRoom(id, { name: roomNameEl.value.toUpperCase() });
});
roomPatternEl.addEventListener('change', () => {
  const id = state.selection.id;
  if (id) updateRoom(id, { pattern: roomPatternEl.value });
});
roomFinishEl.addEventListener('change', () => {
  const id = state.selection.id;
  if (id) updateRoom(id, { finish: roomFinishEl.value });
});
roomZonesEl.addEventListener('input', () => {
  const id = state.selection.id;
  if (!id) return;
  const n = Math.max(1, Math.min(6, parseInt(roomZonesEl.value, 10) || 1));
  updateRoom(id, { zoneCount: n });
});
for (const side of ['n', 'e', 's', 'w']) {
  wallChecks[side].addEventListener('change', () => {
    const id = state.selection.id;
    if (id) toggleWall(id, SIDE_TO_EDGE[side]);
  });
}

// Subscribe to state to keep DOM in sync.
subscribe(() => {
  syncToolbarActive();
  syncRoomPanel();
  syncTracingPanel();
  syncUndoButton();
  render();
  syncSchedule();
  syncCalculations();
  syncWarnings();
  syncZoomLabel();
  syncCanvasCursor();
});

function syncUndoButton() {
  $('#btn-undo').disabled = !canUndo();
}

function syncTracingPanel() {
  const img = state.tracingImage;
  const controls = $('#trace-controls');
  if (!img) {
    controls.hidden = true;
    return;
  }
  controls.hidden = false;
  const widthEl = $('#trace-width');
  if (document.activeElement !== widthEl) {
    widthEl.value = (img.w / 1000).toFixed(2);
  }
  const opEl = $('#trace-opacity');
  if (document.activeElement !== opEl) {
    opEl.value = Math.round((img.opacity ?? 0.5) * 100);
  }
}

function syncToolbarActive() {
  $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
}

function syncCanvasCursor() {
  canvas.classList.toggle('draw-mode', ['draw-room', 'draw-nogo', 'place-manifold'].includes(state.mode));
  canvas.classList.toggle('delete-mode', state.mode === 'delete');
}

function syncRoomPanel() {
  const sel = state.selection.id;
  const room = sel ? state.rooms.find(r => r.id === sel) : null;
  $('#room-empty').hidden = !!room;
  $('#room-form').hidden = !room;
  if (!room) return;
  if (document.activeElement !== roomNameEl) roomNameEl.value = room.name;
  roomPatternEl.value = room.pattern;
  roomFinishEl.value = room.finish || 'tile';
  if (document.activeElement !== roomZonesEl) roomZonesEl.value = room.zoneCount || 1;
  roomAreaEl.textContent = (polygonAreaForRoom(room) / 1e6).toFixed(2);
  // Walls UI: only show N/E/S/W boxes for axis-aligned 4-vertex rooms. For
  // custom polygons, prompt the user to use the Wall tool on individual edges.
  const isRect = isAxisRect(room.vertices);
  const wallsBox = $('.walls-fieldset');
  if (wallsBox) wallsBox.hidden = !isRect;
  if (isRect) {
    for (const side of ['n', 'e', 's', 'w']) {
      wallChecks[side].checked = room.edgeKinds[SIDE_TO_EDGE[side]] === 'external';
    }
  }
}

function polygonAreaForRoom(room) {
  const vs = room.vertices || [];
  let s = 0;
  for (let i = 0, n = vs.length; i < n; i++) {
    const a = vs[i], b = vs[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function isAxisRect(vertices) {
  if (!vertices || vertices.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = vertices[i], b = vertices[(i + 1) % 4];
    if (Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1) return false;
  }
  return true;
}

function syncSchedule() {
  const target = $('#schedule');
  if (state.loops.length === 0) {
    target.innerHTML = '<p class="hint">Generate a layout to populate.</p>';
    return;
  }
  const rows = state.loops.map(l => `
    <tr>
      <td><span class="swatch c${l.colour}"></span>${escapeHtml(l.label.split('-').slice(0, 2).join('-'))}</td>
      <td>${escapeHtml(l.roomName)}</td>
      <td>${(l.totalLength / 1000).toFixed(0)} m</td>
      <td>G${l.group}</td>
    </tr>`).join('');
  target.innerHTML = `<table>
    <thead><tr><th>Loop</th><th>Room</th><th>Length</th><th>Group</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function syncCalculations() {
  const target = $('#calculations');
  if (state.loops.length === 0) {
    target.innerHTML = '<p class="hint">Generate a layout to populate.</p>';
    return;
  }
  const s = summarise(state);
  target.innerHTML = `
    <div class="key">Floor area</div><div class="val">${s.totalArea.toFixed(1)} m²</div>
    <div class="key">Loops</div><div class="val">${s.loopCount}</div>
    <div class="key">Total pipe</div><div class="val">${s.totalPipe.toFixed(1)} m</div>
    <div class="key">Order qty (+${((state.config.wastageFactor - 1) * 100).toFixed(0)}%)</div><div class="val">${s.orderQty.toFixed(1)} m</div>
    <div class="key">Manifold ports</div><div class="val">${s.portsRequired}</div>
    <div class="key">Loop length min/max</div><div class="val">${s.minLen.toFixed(0)} / ${s.maxLen.toFixed(0)} m</div>
    <div class="key">Balance spread</div><div class="val">${s.spread.toFixed(0)} %</div>
    <div class="key">Est. heat output</div><div class="val">~${s.estimatedOutput.toFixed(0)} W/m²</div>
  `;
}

function syncWarnings() {
  const ul = $('#warnings');
  if (state.warnings.length === 0) {
    ul.innerHTML = '<li class="ok">No issues.</li>';
    return;
  }
  ul.innerHTML = state.warnings.map(w => `<li class="${w.level}">${escapeHtml(w.message)}</li>`).join('');
}

function syncZoomLabel() {
  // Show zoom as a percentage relative to the default view (z = 0.08 px/mm
  // is the initial fit-friendly zoom, treated as 100%).
  const pct = (state.view.zoom / 0.08) * 100;
  $('#zoom-level').textContent = `${pct.toFixed(0)}%`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Cursor coords readout.
canvas.addEventListener('pointermove', e => {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left - state.view.panX) / state.view.zoom;
  const y = (e.clientY - rect.top - state.view.panY) / state.view.zoom;
  $('#cursor-coords').textContent = `${(x / 1000).toFixed(2)}, ${(y / 1000).toFixed(2)} m`;
});

// Resize handling.
window.addEventListener('resize', () => { applyView(); render(); });

// Initial state: select tool active.
setMode('select');
emit();
setStatus('Ready. Tip: click "Load Sample" then "Generate Layout".');
