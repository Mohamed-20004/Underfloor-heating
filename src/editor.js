// editor.js — handles pointer interactions on the SVG canvas and dispatches
// mode-specific actions to the state module. Pan/zoom is built in.

import { state, addRoom, addNoGo, deleteRoom, deleteNoGo, addDoor, deleteDoor,
  selectRoom, clearSelection, setManifold, toggleWall, emit } from './state.js';
import { clientToWorld, showPreviewRect, clearPreview, applyView, render } from './render.js';

let canvas;
let dragStart = null;
let dragEnd = null;
let panStart = null;
let onStatus = () => {};

export function initEditor(canvasEl, opts = {}) {
  canvas = canvasEl;
  if (opts.onStatus) onStatus = opts.onStatus;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}

function snap(v, grid = 50) { return Math.round(v / grid) * grid; }

function onPointerDown(e) {
  if (e.button === 1 || (e.button === 0 && e.shiftKey) || e.button === 2) {
    panStart = { x: e.clientX, y: e.clientY, panX: state.view.panX, panY: state.view.panY };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;

  const wp = clientToWorld(e.clientX, e.clientY);
  const sp = { x: snap(wp.x), y: snap(wp.y) };

  switch (state.mode) {
    case 'draw-room':
      dragStart = sp;
      canvas.setPointerCapture(e.pointerId);
      break;
    case 'draw-nogo': {
      const room = roomAt(wp);
      if (!room) { onStatus('Click and drag inside a room to define a no-go zone.'); return; }
      dragStart = { ...sp, roomId: room.id };
      canvas.setPointerCapture(e.pointerId);
      break;
    }
    case 'place-manifold':
      setManifold(sp);
      onStatus(`Manifold placed at ${(sp.x / 1000).toFixed(2)} m, ${(sp.y / 1000).toFixed(2)} m.`);
      break;
    case 'edit-walls': {
      const hit = wallAt(e.target);
      if (hit) {
        toggleWall(hit.roomId, hit.side);
        onStatus(`Toggled wall: ${hit.roomId} ${hit.side}.`);
      }
      break;
    }
    case 'add-door': {
      // Pick the closest wall edge of the closest room and place a door there.
      const room = roomNearest(wp, 800);
      if (!room) { onStatus('Tap on a room edge to place a door.'); break; }
      const placement = nearestEdgeOnRoom(room, wp);
      if (!placement) break;
      addDoor(room.id, placement.side, placement.center, 800);
      onStatus(`Added door on ${room.name} (${placement.side} wall).`);
      break;
    }
    case 'delete': {
      const target = e.target;
      if (target && target.dataset) {
        if (target.dataset.doorId) {
          deleteDoor(target.dataset.roomId, target.dataset.doorId);
          onStatus('Removed door.');
          break;
        }
        if (target.dataset.nogoId) {
          deleteNoGo(target.dataset.roomId, target.dataset.nogoId);
          onStatus('Removed no-go zone.');
          break;
        }
      }
      const room = roomAt(wp);
      if (room) {
        deleteRoom(room.id);
        onStatus(`Deleted room ${room.name}.`);
      }
      break;
    }
    case 'select':
    default: {
      const room = roomAt(wp);
      if (room) selectRoom(room.id);
      else clearSelection();
      break;
    }
  }
}

function onPointerMove(e) {
  const wp = clientToWorld(e.clientX, e.clientY);
  onStatus(`x: ${(wp.x / 1000).toFixed(2)} m  y: ${(wp.y / 1000).toFixed(2)} m  |  mode: ${state.mode}`, true);

  if (panStart) {
    state.view.panX = panStart.panX + (e.clientX - panStart.x);
    state.view.panY = panStart.panY + (e.clientY - panStart.y);
    applyView();
    return;
  }
  if (!dragStart) return;
  dragEnd = { x: snap(wp.x), y: snap(wp.y) };
  showPreviewRect({
    x: dragStart.x, y: dragStart.y,
    w: dragEnd.x - dragStart.x, h: dragEnd.y - dragStart.y,
  });
}

function onPointerUp(e) {
  if (panStart) {
    panStart = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  if (!dragStart || !dragEnd) {
    dragStart = null; dragEnd = null;
    clearPreview();
    return;
  }

  const rect = normaliseRect(dragStart, dragEnd);
  // Filter out tiny accidental drags (< 200 mm in either dimension).
  if (rect.w < 200 || rect.h < 200) {
    onStatus('Drag too small — discarded.');
    dragStart = null; dragEnd = null;
    clearPreview();
    return;
  }

  if (state.mode === 'draw-room') {
    const r = addRoom(rect);
    onStatus(`Created room ${r.name} (${(rect.w / 1000).toFixed(1)} × ${(rect.h / 1000).toFixed(1)} m).`);
  } else if (state.mode === 'draw-nogo') {
    addNoGo(dragStart.roomId, rect);
    onStatus(`Added no-go zone (${(rect.w / 1000).toFixed(1)} × ${(rect.h / 1000).toFixed(1)} m).`);
  }
  dragStart = null; dragEnd = null;
  clearPreview();
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

function onWheel(e) {
  e.preventDefault();
  const z = state.view.zoom;
  // Zoom toward cursor: world point under cursor stays put.
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  const wp = clientToWorld(e.clientX, e.clientY);
  const factor = Math.pow(1.0015, -e.deltaY);
  const newZoom = Math.max(0.005, Math.min(2.0, z * factor));
  state.view.zoom = newZoom;
  state.view.panX = cx - wp.x * newZoom;
  state.view.panY = cy - wp.y * newZoom;
  applyView();
  emit();
}

function normaliseRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function roomAt(p) {
  // Search from last to first so newest rooms (drawn on top) win.
  for (let i = state.rooms.length - 1; i >= 0; i--) {
    const r = state.rooms[i];
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
  }
  return null;
}

function wallAt(target) {
  if (!target || !target.dataset) return null;
  const { roomId, wallSide } = target.dataset;
  if (!roomId || !wallSide) return null;
  return { roomId, side: wallSide };
}

// Find the room whose perimeter is closest to point p, within `tolerance` mm.
function roomNearest(p, tolerance) {
  let best = null, bestDist = tolerance;
  for (const r of state.rooms) {
    const d = distToRoomPerimeter(p, r);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}

function distToRoomPerimeter(p, r) {
  // Distance from p to the nearest of the four wall segments.
  const x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  return Math.min(
    pointSegDist(p, x1, y1, x2, y1),
    pointSegDist(p, x2, y1, x2, y2),
    pointSegDist(p, x1, y2, x2, y2),
    pointSegDist(p, x1, y1, x1, y2),
  );
}

function pointSegDist(p, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

// Snap a point to the nearest of a room's four wall edges. Returns the side
// and the fractional centre (0..1) along that wall.
function nearestEdgeOnRoom(r, p) {
  const candidates = [
    { side: 'n', a: { x: r.x, y: r.y },               b: { x: r.x + r.w, y: r.y } },
    { side: 'e', a: { x: r.x + r.w, y: r.y },         b: { x: r.x + r.w, y: r.y + r.h } },
    { side: 's', a: { x: r.x, y: r.y + r.h },         b: { x: r.x + r.w, y: r.y + r.h } },
    { side: 'w', a: { x: r.x, y: r.y },               b: { x: r.x, y: r.y + r.h } },
  ];
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = pointSegDist(p, c.a.x, c.a.y, c.b.x, c.b.y);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  if (!best) return null;
  // Compute fractional centre along the wall.
  const dx = best.b.x - best.a.x, dy = best.b.y - best.a.y;
  const lenSq = dx * dx + dy * dy;
  let t = ((p.x - best.a.x) * dx + (p.y - best.a.y) * dy) / lenSq;
  t = Math.max(0.05, Math.min(0.95, t));
  return { side: best.side, center: t };
}
