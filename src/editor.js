// editor.js — handles pointer interactions on the SVG canvas and dispatches
// mode-specific actions to the state module. Pan/zoom is built in.

import { state, addRoom, addCustomRoom, addNoGo, deleteRoom, deleteNoGo, deleteVertex,
  addDoor, deleteDoor, addFreeWall, deleteFreeWall, addFreeWallDoor, deleteFreeWallDoor,
  selectRoom, clearSelection, setManifold, toggleWall, hideRoomEdge, emit,
  updateTracingImage, moveRoomBy, moveFreeWallBy, setDoorCenter } from './state.js';
import { clientToWorld, showPreviewRect, clearPreview, applyView, render } from './render.js';

let canvas;
let dragStart = null;
let dragEnd = null;
let panStart = null;
let onStatus = () => {};
// Polygon-drawing buffer: vertices accumulated by the Custom Room tool.
let customVerts = null;
// Tracing-image drag state: { mode: 'move'|'resize', startX, startY, imgX0, imgY0, imgW0 }.
let imageDrag = null;
// Free-wall drawing buffer: the first tapped point waiting for a second tap.
let wallStart = null;
// Active pointers (by pointerId) and the gesture base when 2 fingers are
// down. Two pointers always take precedence over single-pointer tool actions.
const pointers = new Map();
let gestureStart = null;
// Select-mode drag of a room / wall / door. `kind` is the entity type;
// `last` is the previous pointer world position so we apply small deltas.
let selectDrag = null;

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

export function resetCustomPolygon() {
  customVerts = null;
  showPreviewPolygon(null);
}

export function resetFreeWall() {
  wallStart = null;
  showPreviewFreeWall(null, null);
}

function showPreviewFreeWall(a, b) {
  const layer = document.querySelector('#canvas g[data-layer="preview"]');
  if (!layer) return;
  layer.innerHTML = '';
  if (!a) return;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    layer.appendChild(el);
    return el;
  };
  make('circle', { cx: a.x, cy: a.y, r: 100, class: 'preview-close-target' });
  if (!b || (a.x === b.x && a.y === b.y)) return;
  make('line', {
    x1: a.x, y1: a.y, x2: b.x, y2: b.y,
    class: 'preview-dashed',
  });
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 200) return;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const nx = -dy / len, ny = dx / len;
  const off = 220;
  make('text', {
    x: mx + nx * off, y: my + ny * off + 35,
    class: 'preview-length live',
    'font-size': 110,
    'text-anchor': 'middle',
  }).textContent = `${(len / 1000).toFixed(2)} m`;
}

function nearestFreeWall(p, tolerance) {
  if (!Array.isArray(state.walls)) return null;
  let best = null, bestDist = tolerance;
  for (const w of state.walls) {
    const d = pointSegDist(p, w.a.x, w.a.y, w.b.x, w.b.y);
    if (d < bestDist) { bestDist = d; best = w; }
  }
  return best;
}

// Return { roomId, doorId } if the pointer event hit a door's transparent
// click target, else null.
function doorAt(target) {
  if (!target || !target.dataset) return null;
  if (!target.dataset.doorId) return null;
  return { roomId: target.dataset.roomId, doorId: target.dataset.doorId };
}

// Find the nearest polygon edge across all rooms within `tolerance` mm.
// Returns { roomId, edgeIndex, distance } or null.
function nearestRoomEdge(p, tolerance) {
  let best = null, bestDist = tolerance;
  for (const r of state.rooms) {
    const vs = r.vertices || [];
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      const d = pointSegDist(p, a.x, a.y, b.x, b.y);
      if (d < bestDist) { bestDist = d; best = { roomId: r.id, edgeIndex: i, distance: d }; }
    }
  }
  return best;
}

function snap(v, grid = 50) { return Math.round(v / grid) * grid; }

function beginGesture() {
  const pts = [...pointers.values()].slice(0, 2);
  const cx = (pts[0].x + pts[1].x) / 2;
  const cy = (pts[0].y + pts[1].y) / 2;
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  // Pre-compute the world point under the gesture centre so we can keep it
  // anchored throughout the pinch (so the canvas tracks your fingers).
  const w = clientToWorld(cx, cy);
  gestureStart = { cx, cy, dist: d, zoom: state.view.zoom, worldX: w.x, worldY: w.y };
}

function cancelSinglePointerActions() {
  dragStart = null; dragEnd = null;
  panStart = null;
  imageDrag = null;
  clearPreview();
}

function onPointerDown(e) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // If a second finger lands while a tool action is mid-gesture, abandon the
  // tool action and start a pinch/pan gesture instead.
  if (pointers.size >= 2) {
    cancelSinglePointerActions();
    beginGesture();
    return;
  }
  if (e.button === 1 || (e.button === 0 && e.shiftKey) || e.button === 2) {
    panStart = { x: e.clientX, y: e.clientY, panX: state.view.panX, panY: state.view.panY };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;

  const wp = clientToWorld(e.clientX, e.clientY);
  const sp = { x: snap(wp.x), y: snap(wp.y) };

  switch (state.mode) {
    case 'add-image': {
      // Tap anywhere to open the file picker if no image is loaded yet.
      // Once an image is loaded, taps in this mode allow drag-to-position
      // and the bottom-right corner handle resizes.
      if (!state.tracingImage) {
        const fileInput = document.getElementById('trace-file');
        if (fileInput) fileInput.click();
        break;
      }
      const img = state.tracingImage;
      const handle = e.target && e.target.dataset && e.target.dataset.traceHandle;
      if (handle === 'corner') {
        imageDrag = { mode: 'resize', startX: wp.x, startY: wp.y, imgX0: img.x, imgY0: img.y, imgW0: img.w };
      } else {
        imageDrag = { mode: 'move', startX: wp.x, startY: wp.y, imgX0: img.x, imgY0: img.y };
      }
      canvas.setPointerCapture(e.pointerId);
      break;
    }
    case 'draw-room':
      dragStart = sp;
      canvas.setPointerCapture(e.pointerId);
      break;
    case 'draw-custom': {
      // Tap-to-place corners. Each new corner snaps so its edge from the
      // previous corner is axis-aligned. Tap near the start to close.
      if (!customVerts) customVerts = [];
      const pt = customVerts.length > 0
        ? snapToAxis(customVerts[customVerts.length - 1], sp)
        : sp;
      // Closing: tap within snap radius of the first vertex finalises the
      // polygon. Need at least 4 corners (3 + close).
      if (customVerts.length >= 3) {
        const first = customVerts[0];
        if (Math.hypot(pt.x - first.x, pt.y - first.y) < 200) {
          // Close — last edge goes from last placed to first.
          const r = addCustomRoom(customVerts);
          customVerts = null;
          if (r) onStatus(`Custom room ${r.name} created with ${r.vertices.length} corners.`);
          showPreviewPolygon(null);
          return;
        }
      }
      customVerts.push(pt);
      onStatus(`Corner ${customVerts.length} added at ${(pt.x / 1000).toFixed(2)}, ${(pt.y / 1000).toFixed(2)} m. Tap near the first corner to close.`);
      showPreviewPolygon(customVerts);
      return;
    }
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
        toggleWall(hit.roomId, hit.edgeIndex);
        onStatus(`Toggled wall ${hit.edgeIndex} on ${hit.roomId}.`);
        break;
      }
      // Fall-back: nearest edge to the click on the nearest room.
      const room = roomNearest(wp, 1000);
      if (!room) break;
      const placement = nearestEdgeOnRoom(room, wp);
      if (placement) {
        toggleWall(room.id, placement.edgeIndex);
        onStatus(`Toggled wall ${placement.edgeIndex} on ${room.name}.`);
      }
      break;
    }
    case 'add-door': {
      // Pick the closest wall — free wall or room polygon edge — and place a
      // door there. Doors attach to whichever surface is nearest the tap.
      const tol = 1000;
      const fw = nearestFreeWall(wp, tol);
      const fwDist = fw ? pointSegDist(wp, fw.a.x, fw.a.y, fw.b.x, fw.b.y) : Infinity;
      const re = nearestRoomEdge(wp, tol);
      const reDist = re ? re.distance : Infinity;
      if (fw && fwDist <= reDist) {
        // Project the click onto the free wall to compute the fractional centre.
        const dx = fw.b.x - fw.a.x, dy = fw.b.y - fw.a.y;
        const lenSq = dx * dx + dy * dy || 1;
        const t = ((wp.x - fw.a.x) * dx + (wp.y - fw.a.y) * dy) / lenSq;
        addFreeWallDoor(fw.id, t, 800);
        onStatus('Added door on free wall.');
        break;
      }
      if (re) {
        const room = state.rooms.find(r => r.id === re.roomId);
        if (!room) break;
        // Compute the fractional centre along the polygon edge.
        const a = room.vertices[re.edgeIndex];
        const b = room.vertices[(re.edgeIndex + 1) % room.vertices.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy || 1;
        const t = ((wp.x - a.x) * dx + (wp.y - a.y) * dy) / lenSq;
        const center = Math.max(0.05, Math.min(0.95, t));
        addDoor(re.roomId, re.edgeIndex, center, 800);
        onStatus(`Added door on ${room.name}.`);
        break;
      }
      onStatus('Tap on a wall (room edge or free wall) to place a door.');
      break;
    }
    case 'merge-walls': {
      // Tap a vertex to merge its two adjacent walls into one.
      if (e.target && e.target.dataset && e.target.dataset.vertexId !== undefined) {
        deleteVertex(e.target.dataset.roomId, e.target.dataset.vertexId);
        onStatus('Walls merged.');
        break;
      }
      onStatus('Tap a vertex (small white circle) to merge the two walls meeting there.');
      break;
    }
    case 'add-wall': {
      // Two-tap drawing: first tap sets the start, second tap commits the
      // wall (axis-snapped to the start). The wall is standalone and does not
      // need to connect to a room.
      if (!wallStart) {
        wallStart = sp;
        onStatus('First corner placed. Tap the other end to confirm.');
        showPreviewFreeWall(wallStart, wallStart);
        return;
      }
      const end = snapToAxis(wallStart, sp);
      const w = addFreeWall(wallStart, end, 'internal');
      wallStart = null;
      showPreviewFreeWall(null, null);
      if (w) onStatus('Wall added.');
      return;
    }
    case 'delete': {
      const target = e.target;
      if (target && target.dataset) {
        if (target.dataset.vertexId !== undefined && target.dataset.roomId) {
          deleteVertex(target.dataset.roomId, target.dataset.vertexId);
          onStatus('Removed vertex (walls merged).');
          break;
        }
        if (target.dataset.doorId) {
          // Door delete: free-wall doors carry a freeWallId, room doors carry a roomId.
          if (target.dataset.freeWallId) {
            deleteFreeWallDoor(target.dataset.freeWallId, target.dataset.doorId);
            onStatus('Removed door.');
          } else {
            deleteDoor(target.dataset.roomId, target.dataset.doorId);
            onStatus('Removed door.');
          }
          break;
        }
        if (target.dataset.nogoId) {
          deleteNoGo(target.dataset.roomId, target.dataset.nogoId);
          onStatus('Removed no-go zone.');
          break;
        }
        if (target.dataset.freeWallId) {
          deleteFreeWall(target.dataset.freeWallId);
          onStatus('Removed wall.');
          break;
        }
        if (target.dataset.edgeIndex !== undefined && target.dataset.roomId) {
          // Polygon edge tap → hide the wall (room shape is preserved).
          hideRoomEdge(target.dataset.roomId, target.dataset.edgeIndex);
          onStatus('Wall removed from room.');
          break;
        }
      }
      // Fall back: nearest free wall, then nearest polygon edge, then room.
      const nearestFree = nearestFreeWall(wp, 400);
      if (nearestFree) {
        deleteFreeWall(nearestFree.id);
        onStatus('Removed wall.');
        break;
      }
      const re = nearestRoomEdge(wp, 400);
      if (re) {
        hideRoomEdge(re.roomId, re.edgeIndex);
        onStatus('Wall removed from room.');
        break;
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
      // Priority: door → free wall → room edge (polygon wall) → room area.
      // Doors and walls are easier targets than the room area underneath them.
      const door = doorAt(e.target);
      if (door) {
        state.selection = { type: 'door', roomId: door.roomId, doorId: door.doorId };
        selectDrag = { kind: 'door', roomId: door.roomId, doorId: door.doorId, last: wp };
        canvas.setPointerCapture(e.pointerId);
        emit();
        break;
      }
      const fw = nearestFreeWall(wp, 400);
      if (fw) {
        state.selection = { type: 'free-wall', wallId: fw.id };
        selectDrag = { kind: 'free-wall', wallId: fw.id, last: wp };
        canvas.setPointerCapture(e.pointerId);
        emit();
        break;
      }
      // Polygon edge near the click — selects an individual wall of a room
      // so the user can flip its type via the sidebar.
      const re = nearestRoomEdge(wp, 400);
      if (re) {
        state.selection = { type: 'wall', roomId: re.roomId, edgeIndex: re.edgeIndex };
        selectDrag = null;
        emit();
        break;
      }
      const room = roomAt(wp);
      if (room) {
        selectRoom(room.id);
        selectDrag = { kind: 'room', roomId: room.id, last: wp };
        canvas.setPointerCapture(e.pointerId);
        break;
      }
      clearSelection();
      selectDrag = null;
      break;
    }
  }
}

function onPointerMove(e) {
  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  // Two-finger gesture: pinch to zoom + drag to pan, with the gesture centre
  // staying anchored to the same world point (so the canvas feels like paper
  // under your fingers).
  if (pointers.size >= 2 && gestureStart) {
    const pts = [...pointers.values()].slice(0, 2);
    const cx = (pts[0].x + pts[1].x) / 2;
    const cy = (pts[0].y + pts[1].y) / 2;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const scale = d / Math.max(1, gestureStart.dist);
    const newZoom = Math.max(0.005, Math.min(2.0, gestureStart.zoom * scale));
    state.view.zoom = newZoom;
    state.view.panX = cx - gestureStart.worldX * newZoom;
    state.view.panY = cy - gestureStart.worldY * newZoom;
    applyView();
    emit();
    return;
  }

  const wp = clientToWorld(e.clientX, e.clientY);
  onStatus(`x: ${(wp.x / 1000).toFixed(2)} m  y: ${(wp.y / 1000).toFixed(2)} m  |  mode: ${state.mode}`, true);

  if (panStart) {
    state.view.panX = panStart.panX + (e.clientX - panStart.x);
    state.view.panY = panStart.panY + (e.clientY - panStart.y);
    applyView();
    return;
  }
  if (imageDrag) {
    const dx = wp.x - imageDrag.startX;
    const dy = wp.y - imageDrag.startY;
    if (imageDrag.mode === 'move') {
      updateTracingImage({ x: imageDrag.imgX0 + dx, y: imageDrag.imgY0 + dy });
    } else if (imageDrag.mode === 'resize') {
      const newW = Math.max(500, imageDrag.imgW0 + dx);
      updateTracingImage({ w: newW });
    }
    return;
  }
  if (selectDrag) {
    const dx = wp.x - selectDrag.last.x;
    const dy = wp.y - selectDrag.last.y;
    selectDrag.last = wp;
    if (selectDrag.kind === 'room') {
      moveRoomBy(selectDrag.roomId, dx, dy);
    } else if (selectDrag.kind === 'free-wall') {
      moveFreeWallBy(selectDrag.wallId, dx, dy);
    } else if (selectDrag.kind === 'door') {
      // Project the cursor onto the door's parent edge to compute the new
      // fractional centre. Doors slide along their wall; they don't jump off.
      const room = state.rooms.find(r => r.id === selectDrag.roomId);
      if (room) {
        const door = (room.doors || []).find(d => d.id === selectDrag.doorId);
        if (door) {
          const a = room.vertices[door.edgeIndex];
          const b = room.vertices[(door.edgeIndex + 1) % room.vertices.length];
          const ex = b.x - a.x, ey = b.y - a.y;
          const lenSq = ex * ex + ey * ey || 1;
          const t = ((wp.x - a.x) * ex + (wp.y - a.y) * ey) / lenSq;
          setDoorCenter(selectDrag.roomId, selectDrag.doorId, t);
        }
      }
    }
    return;
  }
  // Live preview while drawing a custom polygon: dashed lead-in from the last
  // placed corner to the snapped cursor, plus a dashed closing line back to
  // the first corner once we have ≥3 placed corners.
  if (state.mode === 'draw-custom' && customVerts && customVerts.length > 0) {
    const cur = snapToAxis(customVerts[customVerts.length - 1], { x: snap(wp.x), y: snap(wp.y) });
    showPreviewPolygon(customVerts, cur);
  }
  // Live preview while drawing a free wall: dashed line from the first tap
  // to the snapped cursor, with the live length label.
  if (state.mode === 'add-wall' && wallStart) {
    const cur = snapToAxis(wallStart, { x: snap(wp.x), y: snap(wp.y) });
    showPreviewFreeWall(wallStart, cur);
  }
  if (!dragStart) return;
  dragEnd = { x: snap(wp.x), y: snap(wp.y) };
  showPreviewRect({
    x: dragStart.x, y: dragStart.y,
    w: dragEnd.x - dragStart.x, h: dragEnd.y - dragStart.y,
  });
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gestureStart = null;
  if (panStart) {
    panStart = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  if (imageDrag) {
    imageDrag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  if (selectDrag) {
    selectDrag = null;
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
  for (let i = state.rooms.length - 1; i >= 0; i--) {
    const r = state.rooms[i];
    if (pointInRoom(p, r)) return r;
  }
  return null;
}

function pointInRoom(p, r) {
  const vs = r.vertices;
  if (!vs) return false;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const vi = vs[i], vj = vs[j];
    const intersect = ((vi.y > p.y) !== (vj.y > p.y)) &&
      (p.x < (vj.x - vi.x) * (p.y - vi.y) / ((vj.y - vi.y) || 1e-9) + vi.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

function wallAt(target) {
  if (!target || !target.dataset) return null;
  const { roomId, edgeIndex } = target.dataset;
  if (!roomId || edgeIndex === undefined) return null;
  return { roomId, edgeIndex: Number(edgeIndex) };
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
  if (!r.vertices) return Infinity;
  let best = Infinity;
  for (let i = 0; i < r.vertices.length; i++) {
    const a = r.vertices[i], b = r.vertices[(i + 1) % r.vertices.length];
    const d = pointSegDist(p, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

function pointSegDist(p, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

// Snap a point to the nearest polygon edge of a room. Returns the edge index
// and the fractional centre (0..1) along that edge.
function nearestEdgeOnRoom(r, p) {
  if (!r.vertices) return null;
  let best = null, bestDist = Infinity;
  for (let i = 0; i < r.vertices.length; i++) {
    const a = r.vertices[i], b = r.vertices[(i + 1) % r.vertices.length];
    const d = pointSegDist(p, a.x, a.y, b.x, b.y);
    if (d < bestDist) { bestDist = d; best = { edgeIndex: i, a, b }; }
  }
  if (!best) return null;
  const dx = best.b.x - best.a.x, dy = best.b.y - best.a.y;
  const lenSq = dx * dx + dy * dy;
  let t = ((p.x - best.a.x) * dx + (p.y - best.a.y) * dy) / lenSq;
  t = Math.max(0.05, Math.min(0.95, t));
  return { edgeIndex: best.edgeIndex, center: t };
}

// Snap `pt` to be axis-aligned with `prev`: keep the larger axis-parallel
// component and zero the other. Mirrors the snap rule used when corners are
// committed so the preview matches the result of a tap.
function snapToAxis(prev, pt) {
  if (Math.abs(pt.x - prev.x) < Math.abs(pt.y - prev.y)) {
    return { x: prev.x, y: pt.y };
  }
  return { x: pt.x, y: prev.y };
}

// In-progress polygon preview drawn while the user places corners.
//   - Solid blue line: edges connecting placed corners.
//   - Dashed blue line: lead-in from the last placed corner to the cursor.
//   - Dashed grey line: closing edge from the cursor back to the first corner
//     (only when ≥ 3 corners are placed, since closing earlier would be a
//     degenerate shape).
//   - Metre labels at the midpoint of each preview line so the user sees the
//     length they're about to commit.
function showPreviewPolygon(verts, cursor) {
  const layer = document.querySelector('#canvas g[data-layer="preview"]');
  if (!layer) return;
  layer.innerHTML = '';
  if (!verts || verts.length === 0) return;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    layer.appendChild(el);
    return el;
  };

  // Solid edges between placed corners.
  if (verts.length >= 2) {
    make('polyline', {
      points: verts.map(v => `${v.x},${v.y}`).join(' '),
      class: 'preview',
      fill: 'none',
    });
  }
  for (const v of verts) {
    make('circle', { cx: v.x, cy: v.y, r: 80, class: 'preview' });
  }
  // Length labels on existing edges (helps when re-thinking the shape).
  for (let i = 0; i + 1 < verts.length; i++) {
    edgeLengthLabel(make, verts[i], verts[i + 1], 'preview-length');
  }

  if (!cursor) return;

  // Dashed lead-in from last vertex to the snapped cursor.
  const last = verts[verts.length - 1];
  make('line', {
    x1: last.x, y1: last.y, x2: cursor.x, y2: cursor.y,
    class: 'preview-dashed',
  });
  edgeLengthLabel(make, last, cursor, 'preview-length live');

  // Dashed closing line back to the first vertex.
  if (verts.length >= 2) {
    const first = verts[0];
    make('line', {
      x1: cursor.x, y1: cursor.y, x2: first.x, y2: first.y,
      class: 'preview-closing',
    });
    if (verts.length >= 2) edgeLengthLabel(make, cursor, first, 'preview-length closing');
    // Highlight the first corner so the user knows where to tap to close.
    make('circle', { cx: first.x, cy: first.y, r: 200, class: 'preview-close-target' });
  }
}

function edgeLengthLabel(make, a, b, cls) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 200) return;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  // Offset the label perpendicular to the line so it doesn't sit on top of it.
  const nx = -dy / len, ny = dx / len;
  const off = 220;
  make('text', {
    x: mx + nx * off, y: my + ny * off + 35,
    class: cls,
    'font-size': 110,
    'text-anchor': 'middle',
  }).textContent = `${(len / 1000).toFixed(2)} m`;
}
