// render.js — SVG rendering of the floor plan, pipes, labels, and title block.
// The SVG uses a viewBox in millimetres so vector exports are correctly scaled.

import { state } from './state.js';
import { pointsToSmoothPath, bbox, polygonArea, edgeLength, edgeOutwardNormal } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// World bounds: a 32 m × 32 m square (≈ 1024 m²). Pan and zoom are clamped so
// the user can't drift off into the void and lose the floorplan. Drawings
// fit comfortably inside; UFH plans for residential ground floors are well
// under this footprint.
export const WORLD_BOUNDS = { x: 0, y: 0, w: 32000, h: 32000 };
const VIEW_MARGIN = 4000; // millimetres of breathing room around the bounds
const MAX_ZOOM = 0.5;     // px per mm — beyond this is unreadably zoomed in

let canvas;
let layers = {};

export function initRenderer(svgEl) {
  canvas = svgEl;
  // Build persistent layer groups so we can re-render without thrashing.
  canvas.innerHTML = '';
  for (const name of ['background', 'trace', 'rooms', 'walls', 'free-walls', 'nogo', 'pipes', 'tails', 'manifold', 'labels', 'preview', 'title-block']) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-layer', name);
    canvas.appendChild(g);
    layers[name] = g;
  }
  applyView();
}

export function setViewport(width, height) {
  canvas.setAttribute('width', width);
  canvas.setAttribute('height', height);
  applyView();
}

export function applyView() {
  if (!canvas) return;
  clampView();
  const w = canvas.clientWidth || 1200;
  const h = canvas.clientHeight || 800;
  const z = state.view.zoom;
  const vbW = w / z;
  const vbH = h / z;
  const vbX = -state.view.panX / z;
  const vbY = -state.view.panY / z;
  canvas.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
}

// Clamp pan and zoom so the world bounds (with a small margin) always stay
// at least partially in view. The min zoom is dynamic so the whole canvas
// fits a typical viewport when the user zooms all the way out — that way the
// floorplan is always one Fit-button-press away.
function clampView() {
  const w = canvas.clientWidth || 1200;
  const h = canvas.clientHeight || 800;
  // Min zoom: the whole bounds (plus margin on each side) must fit in the
  // viewport. So zooming all the way out shows the entire canvas.
  const fitZoomX = w / (WORLD_BOUNDS.w + VIEW_MARGIN * 2);
  const fitZoomY = h / (WORLD_BOUNDS.h + VIEW_MARGIN * 2);
  const minZoom = Math.min(fitZoomX, fitZoomY);
  state.view.zoom = Math.max(minZoom, Math.min(MAX_ZOOM, state.view.zoom));
  const z = state.view.zoom;

  const minX = WORLD_BOUNDS.x - VIEW_MARGIN;
  const maxX = WORLD_BOUNDS.x + WORLD_BOUNDS.w + VIEW_MARGIN;
  const minY = WORLD_BOUNDS.y - VIEW_MARGIN;
  const maxY = WORLD_BOUNDS.y + WORLD_BOUNDS.h + VIEW_MARGIN;
  const vbW = w / z, vbH = h / z;
  // Keep the bounds at least 200 mm visible inside the viewport on each axis,
  // so the user can never pan it completely off-screen.
  const vbX = Math.max(minX - vbW + 200, Math.min(maxX - 200, -state.view.panX / z));
  const vbY = Math.max(minY - vbH + 200, Math.min(maxY - 200, -state.view.panY / z));
  state.view.panX = -vbX * z;
  state.view.panY = -vbY * z;
}

export function clientToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const z = state.view.zoom;
  return {
    x: (clientX - rect.left - state.view.panX) / z,
    y: (clientY - rect.top - state.view.panY) / z,
  };
}

export function fitToContent() {
  const all = [];
  for (const r of state.rooms) {
    for (const v of r.vertices || []) all.push(v);
  }
  for (const w of state.walls || []) {
    all.push(w.a); all.push(w.b);
  }
  if (state.manifold) all.push(state.manifold);
  // Fall back to the full bounded canvas when there's nothing drawn yet, so a
  // fresh project starts with the whole work area in view.
  let b;
  if (all.length < 2) {
    // Empty canvas: focus on a 16 m × 16 m work area in the top-left rather
    // than the full 32 m bounds, so widgets and the manifold are at a usable
    // size right away. The user can pinch out for the full canvas.
    b = { x: WORLD_BOUNDS.x, y: WORLD_BOUNDS.y, w: 16000, h: 16000 };
  } else {
    b = bbox(all);
  }
  const w = canvas.clientWidth || 1200;
  const h = canvas.clientHeight || 800;
  const padding = 80;
  const zoomX = (w - padding * 2) / Math.max(1, b.w);
  const zoomY = (h - padding * 2) / Math.max(1, b.h);
  const z = Math.min(zoomX, zoomY);
  state.view.zoom = z;
  state.view.panX = padding - b.x * z;
  state.view.panY = padding - b.y * z;
  applyView();
}

export function render() {
  if (!canvas) return;
  applyView();
  drawBackground();
  drawTracingImage();
  drawRooms();
  drawFreeWalls();
  drawWalls();
  drawNoGo();
  drawManifold();
  drawPipes();
  drawLoopLabels();
  drawTitleBlock();
}

function svg(name, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) {
    if (attrs[k] === undefined || attrs[k] === null) continue;
    el.setAttribute(k, attrs[k]);
  }
  if (parent) parent.appendChild(el);
  return el;
}

function clear(layer) { layer.innerHTML = ''; }

function drawBackground() {
  clear(layers.background);
  const minor = 1000;          // 1 m — the user-facing "1 sq m" grid
  const major = 5000;          // 5 m — emphasised every fifth line
  const w = canvas.clientWidth || 1200;
  const h = canvas.clientHeight || 800;
  const z = state.view.zoom;
  const vbW = w / z, vbH = h / z;
  const vbX = -state.view.panX / z, vbY = -state.view.panY / z;

  // Hide the grid below a tiny zoom threshold to avoid drawing thousands of
  // lines when the user zooms way out.
  if (z < 0.005) return;

  // The grid only renders inside the world bounds, so the user always has a
  // clear visual cue of where the canvas starts and ends.
  const gridStartX = Math.max(WORLD_BOUNDS.x, Math.floor(vbX / minor) * minor);
  const gridStartY = Math.max(WORLD_BOUNDS.y, Math.floor(vbY / minor) * minor);
  const gridEndX = Math.min(WORLD_BOUNDS.x + WORLD_BOUNDS.w, vbX + vbW);
  const gridEndY = Math.min(WORLD_BOUNDS.y + WORLD_BOUNDS.h, vbY + vbH);

  const startX = gridStartX;
  const startY = gridStartY;

  // Minor grid: every 1 m. Stroke width is in world units (mm), so we scale
  // it inverse to zoom to keep it ~1 px on screen regardless of zoom level.
  const minorStroke = Math.max(2, 1 / z);
  const majorStroke = Math.max(6, 3 / z);

  // Tinted background of the bounded canvas — gives the user a clear sense of
  // "this is the work area" against the surrounding off-bounds void.
  svg('rect', {
    x: WORLD_BOUNDS.x, y: WORLD_BOUNDS.y,
    width: WORLD_BOUNDS.w, height: WORLD_BOUNDS.h,
    fill: '#ffffff',
  }, layers.background);

  for (let x = startX; x <= gridEndX; x += minor) {
    const isMajor = Math.round(x / minor) % (major / minor) === 0;
    svg('line', {
      x1: x, y1: gridStartY, x2: x, y2: gridEndY,
      stroke: isMajor ? '#cdd2da' : '#e3e6eb',
      'stroke-width': isMajor ? majorStroke : minorStroke,
    }, layers.background);
  }
  for (let y = startY; y <= gridEndY; y += minor) {
    const isMajor = Math.round(y / minor) % (major / minor) === 0;
    svg('line', {
      x1: gridStartX, y1: y, x2: gridEndX, y2: y,
      stroke: isMajor ? '#cdd2da' : '#e3e6eb',
      'stroke-width': isMajor ? majorStroke : minorStroke,
    }, layers.background);
  }

  // Solid border framing the bounded canvas.
  svg('rect', {
    x: WORLD_BOUNDS.x, y: WORLD_BOUNDS.y,
    width: WORLD_BOUNDS.w, height: WORLD_BOUNDS.h,
    fill: 'none',
    stroke: '#9aa3b1',
    'stroke-width': Math.max(20, 6 / z),
  }, layers.background);

  // Metre coordinate labels along the major grid. Skip when too zoomed out
  // (labels would overlap) or too zoomed in (labels would be huge).
  if (z > 0.02 && z < 0.5) {
    const fontSize = Math.max(80, 12 / z);
    const padding = 8 / z;
    const labelStartX = Math.max(WORLD_BOUNDS.x, Math.ceil(vbX / major) * major);
    const labelEndX = Math.min(WORLD_BOUNDS.x + WORLD_BOUNDS.w, vbX + vbW);
    const labelStartY = Math.max(WORLD_BOUNDS.y, Math.ceil(vbY / major) * major);
    const labelEndY = Math.min(WORLD_BOUNDS.y + WORLD_BOUNDS.h, vbY + vbH);
    for (let x = labelStartX; x <= labelEndX; x += major) {
      svg('text', {
        x, y: Math.max(vbY, WORLD_BOUNDS.y) + fontSize + padding,
        'font-size': fontSize,
        fill: '#a8aebc',
        'text-anchor': 'middle',
        'font-family': '-apple-system, sans-serif',
      }, layers.background).textContent = `${x / 1000} m`;
    }
    for (let y = labelStartY; y <= labelEndY; y += major) {
      svg('text', {
        x: Math.max(vbX, WORLD_BOUNDS.x) + padding, y: y - padding / 2,
        'font-size': fontSize,
        fill: '#a8aebc',
        'font-family': '-apple-system, sans-serif',
      }, layers.background).textContent = `${y / 1000} m`;
    }
  }
}

function drawTracingImage() {
  clear(layers.trace);
  const img = state.tracingImage;
  if (!img || !img.src) return;
  // SVG image element with absolute world coords. preserveAspectRatio="none"
  // would let the user squash the image, but we keep aspect ratio locked via
  // state.updateTracingImage so width changes scale height.
  const el = svg('image', {
    x: img.x, y: img.y, width: img.w, height: img.h,
    href: img.src, opacity: img.opacity ?? 0.5,
    preserveAspectRatio: 'none',
    'pointer-events': state.mode === 'add-image' ? 'auto' : 'none',
    'data-trace-image': '1',
  }, layers.trace);
  // When the Image tool is active, draw a dashed outline and a corner
  // resize handle so the user has a clear visual target.
  if (state.mode === 'add-image') {
    svg('rect', {
      x: img.x, y: img.y, width: img.w, height: img.h,
      class: 'trace-outline',
      'pointer-events': 'none',
    }, layers.trace);
    svg('rect', {
      x: img.x + img.w - 200, y: img.y + img.h - 200, width: 400, height: 400,
      class: 'trace-handle',
      'data-trace-handle': 'corner',
    }, layers.trace);
  }
  return el;
}

function drawFreeWalls() {
  clear(layers['free-walls']);
  const walls = state.walls || [];
  const sel = state.selection;
  for (const w of walls) {
    const isSelected = sel.type === 'free-wall' && sel.wallId === w.id;
    const baseCls = w.kind === 'external' ? 'wall external' : 'wall internal';
    const cls = baseCls + (isSelected ? ' selected' : '');
    const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
    const len = Math.hypot(dx, dy);
    const seg = { a: w.a, b: w.b, length: len };
    const doors = (w.doors || []);
    const subSegs = breakWallByDoors(seg, doors);
    for (const sub of subSegs) {
      svg('line', {
        x1: sub.a.x, y1: sub.a.y, x2: sub.b.x, y2: sub.b.y,
        class: cls,
        'data-free-wall-id': w.id,
      }, layers['free-walls']);
    }
    // Length label centred and offset perpendicular to the wall.
    if (len >= 600) {
      const mx = (w.a.x + w.b.x) / 2, my = (w.a.y + w.b.y) / 2;
      const nx = -dy / len, ny = dx / len;
      const off = 220;
      const isVertical = Math.abs(dx) < 1;
      const tx = mx + nx * off, ty = my + ny * off;
      const rotation = isVertical ? `rotate(-90 ${tx} ${ty})` : '';
      svg('text', {
        x: tx, y: ty + 35,
        class: 'wall-length',
        'font-size': 95,
        'text-anchor': 'middle',
        transform: rotation,
      }, layers['free-walls']).textContent = `${(len / 1000).toFixed(2)} m`;
    }
    // Door leaves and click targets for each door on this wall.
    for (const d of doors) drawFreeWallDoor(w, d);
  }
}

function drawFreeWallDoor(wall, d) {
  const a = wall.a, b = wall.b;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // Free walls don't have an "inside" — pick the right-hand perpendicular as
  // the swing side. The user can flip the wall's own kind via the sidebar
  // but the door always swings to a consistent side here.
  const ix = -uy, iy = ux;
  const w = d.width;
  const cx = a.x + ux * len * d.center;
  const cy = a.y + uy * len * d.center;
  const half = w / 2;
  const post1 = { x: cx - ux * half, y: cy - uy * half };
  const post2 = { x: cx + ux * half, y: cy + uy * half };
  const swingTarget = { x: post2.x + ix * w, y: post2.y + iy * w };
  svg('line', {
    x1: post2.x, y1: post2.y, x2: swingTarget.x, y2: swingTarget.y,
    class: 'door-leaf',
  }, layers['free-walls']);
  svg('path', {
    d: `M ${post1.x} ${post1.y} A ${w} ${w} 0 0 1 ${swingTarget.x} ${swingTarget.y}`,
    class: 'door-arc',
  }, layers['free-walls']);
  // Touch hit target — carries both freeWallId and doorId so the Delete tool
  // and the Select tool's drag/select can route correctly.
  svg('rect', {
    x: cx - half, y: cy - half, width: w, height: w,
    fill: 'transparent', stroke: 'transparent',
    'data-free-wall-id': wall.id,
    'data-door-id': d.id,
  }, layers['free-walls']);
}

function drawRooms() {
  clear(layers.rooms);
  for (const room of state.rooms) {
    const isSelected = state.selection.id === room.id;
    const points = (room.vertices || []).map(v => `${v.x},${v.y}`).join(' ');
    svg('polygon', {
      points,
      class: 'room-rect' + (isSelected ? ' selected' : ''),
      'data-room-id': room.id,
    }, layers.rooms);
    // Room label centred on bounding-box midpoint (good enough for axis-
    // aligned polygons; for highly concave rooms, label may sit outside).
    const b = bbox(room.vertices || []);
    const labelSize = Math.min(b.w, b.h) * 0.10;
    const fontSize = Math.max(120, Math.min(260, labelSize));
    svg('text', {
      x: b.cx, y: b.cy - fontSize * 0.1,
      class: 'room-label',
      'font-size': fontSize,
    }, layers.rooms).textContent = room.name;
    const areaSize = fontSize * 0.55;
    svg('text', {
      x: b.cx, y: b.cy + areaSize * 1.4,
      class: 'room-area',
      'font-size': areaSize,
    }, layers.rooms).textContent = `${(polygonArea(room.vertices || []) / 1e6).toFixed(1)} m²`;
  }
}

function drawWalls() {
  // Polygon zones no longer draw their edges as walls — walls are exclusively
  // free-wall objects drawn with the Wall tool. We still render selected-room
  // vertex handles here so they sit above the zone fill.
  clear(layers.walls);
  for (const room of state.rooms) {
    const vs = room.vertices || [];
    const showHandles = state.selection.id === room.id || state.mode === 'merge-walls';
    if (showHandles) {
      for (let v = 0; v < vs.length; v++) drawVertexHandle(room, v, vs[v]);
    }
  }
}

function wallClass(kind) {
  if (kind === 'external') return 'wall external';
  if (kind === 'partition') return 'wall partition';
  return 'wall internal';
}

function drawWallLengthLabel(room, vs, edgeIndex, len) {
  if (len < 600) return; // skip tiny edges
  const a = vs[edgeIndex], b = vs[(edgeIndex + 1) % vs.length];
  const midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2;
  const out = edgeOutwardNormal(vs, edgeIndex);
  const offset = 220; // mm
  const lx = midx + out.x * offset;
  const ly = midy + out.y * offset;
  const fontSize = 95;
  // For vertical walls, rotate the label 90° so it reads along the wall.
  const isVertical = Math.abs(a.x - b.x) < 1;
  const rotation = isVertical ? `rotate(-90 ${lx} ${ly})` : '';
  svg('text', {
    x: lx, y: ly + fontSize * 0.35,
    class: 'wall-length',
    'font-size': fontSize,
    'text-anchor': 'middle',
    transform: rotation,
  }, layers.walls).textContent = `${(len / 1000).toFixed(2)} m`;
}

function drawVertexHandle(room, index, v) {
  svg('circle', {
    cx: v.x, cy: v.y, r: 80,
    class: 'vertex-handle',
    'data-room-id': room.id,
    'data-vertex-id': index,
  }, layers.walls);
}

// Split a wall segment around door openings, returning an array of sub-segments
// that flank the doors. Doors are ordered along the wall by their centre.
function breakWallByDoors(seg, doors) {
  if (!doors.length) return [seg];
  const sorted = [...doors].sort((a, b) => a.center - b.center);
  const result = [];
  // Parametric position along segment from a (t=0) to b (t=1).
  const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
  const lenMM = seg.length;
  let cursor = 0;
  for (const d of sorted) {
    const halfFrac = (d.width / 2) / lenMM;
    const start = Math.max(0, d.center - halfFrac);
    const end = Math.min(1, d.center + halfFrac);
    if (start > cursor + 1e-4) {
      result.push({
        a: { x: seg.a.x + dx * cursor, y: seg.a.y + dy * cursor },
        b: { x: seg.a.x + dx * start, y: seg.a.y + dy * start },
      });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < 1 - 1e-4) {
    result.push({
      a: { x: seg.a.x + dx * cursor, y: seg.a.y + dy * cursor },
      b: { x: seg.a.x + dx, y: seg.a.y + dy },
    });
  }
  return result;
}

function drawDoor(room, d) {
  const vs = room.vertices || [];
  if (!vs.length) return;
  const a = vs[d.edgeIndex];
  const b = vs[(d.edgeIndex + 1) % vs.length];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len; // tangent
  const out = edgeOutwardNormal(vs, d.edgeIndex);
  // Inward normal (into the room) for the swing arc.
  const ix = -out.x, iy = -out.y;
  const cx = a.x + ux * len * d.center;
  const cy = a.y + uy * len * d.center;
  const w = d.width, half = w / 2;
  const post1 = { x: cx - ux * half, y: cy - uy * half };
  const post2 = { x: cx + ux * half, y: cy + uy * half };
  // Hinge at post2; swing target sits a quarter-turn inward from post1.
  const swingTarget = { x: post2.x + ix * w, y: post2.y + iy * w };
  // Door leaf.
  svg('line', {
    x1: post2.x, y1: post2.y, x2: swingTarget.x, y2: swingTarget.y,
    class: 'door-leaf',
  }, layers.walls);
  // Swing arc from post1 (closed position) to swingTarget (90° open).
  svg('path', {
    d: `M ${post1.x} ${post1.y} A ${w} ${w} 0 0 1 ${swingTarget.x} ${swingTarget.y}`,
    class: 'door-arc',
  }, layers.walls);
  // Touch hit target.
  svg('rect', {
    x: cx - half, y: cy - half, width: w, height: w,
    fill: 'transparent', stroke: 'transparent',
    'data-room-id': room.id,
    'data-door-id': d.id,
  }, layers.walls);
}

function drawNoGo() {
  clear(layers.nogo);
  for (const room of state.rooms) {
    for (const z of room.noGoZones || []) {
      svg('rect', {
        x: z.x, y: z.y, width: z.w, height: z.h,
        class: 'nogo',
        'data-room-id': room.id,
        'data-nogo-id': z.id,
      }, layers.nogo);
      svg('text', {
        x: z.x + z.w / 2, y: z.y + z.h / 2 + 30,
        class: 'nogo-label',
      }, layers.nogo).textContent = '✕';
    }
  }
}

function drawManifold() {
  clear(layers.manifold);
  if (!state.manifold) return;
  const m = state.manifold;
  const size = 600;
  // Halo: a soft red disc behind the manifold marker so it stands out at any
  // zoom — especially when the user is fitted to the whole 32 m bounded view.
  svg('circle', {
    cx: m.x, cy: m.y, r: size,
    class: 'manifold-halo',
  }, layers.manifold);
  svg('rect', {
    x: m.x - size / 2, y: m.y - size / 2,
    width: size, height: size,
    class: 'manifold',
    rx: 50,
  }, layers.manifold);
  svg('text', {
    x: m.x, y: m.y + 100,
    class: 'manifold-label-inside',
    'font-size': 320,
  }, layers.manifold).textContent = 'M';
}

function drawPipes() {
  clear(layers.pipes);
  clear(layers.tails);
  for (const loop of state.loops) {
    const cls = `pipe c${loop.colour}`;
    const d = pointsToSmoothPath(loop.path, state.config.minBendRadius);
    svg('path', { d, class: cls }, layers.pipes);

    // Tails — straight lines for MVP. A real router would follow walls.
    if (loop.flowTail && loop.flowTail.length >= 2) {
      const dt = pointsToSmoothPath(loop.flowTail, state.config.minBendRadius);
      svg('path', { d: dt, class: `pipe-tail c${loop.colour}` }, layers.tails);
    }
    if (loop.returnTail && loop.returnTail.length >= 2) {
      const dt = pointsToSmoothPath(loop.returnTail, state.config.minBendRadius);
      svg('path', { d: dt, class: `pipe-tail c${loop.colour}` }, layers.tails);
    }
  }
}

function drawLoopLabels() {
  clear(layers.labels);
  for (const loop of state.loops) {
    const cx = loop.bbox.cx;
    const cy = loop.bbox.cy;
    const text = loop.label;
    const fontSize = 110;
    const padding = 30;
    const approxWidth = text.length * fontSize * 0.55;
    svg('rect', {
      x: cx - approxWidth / 2 - padding,
      y: cy - fontSize / 2 - padding,
      width: approxWidth + padding * 2,
      height: fontSize + padding * 2,
      class: 'loop-label-bg',
      rx: 30,
    }, layers.labels);
    svg('text', {
      x: cx, y: cy + fontSize * 0.35,
      class: 'loop-label',
      'font-size': fontSize,
    }, layers.labels).textContent = text;
  }
}

function drawTitleBlock() {
  clear(layers['title-block']);
  if (state.rooms.length === 0) return;

  const allPts = [];
  for (const r of state.rooms) {
    allPts.push({ x: r.x, y: r.y });
    allPts.push({ x: r.x + r.w, y: r.y + r.h });
  }
  const b = bbox(allPts);
  const tbW = b.w;
  const tbH = 1200;
  const tbX = b.x;
  const tbY = b.y + b.h + 600;

  svg('rect', { x: tbX, y: tbY, width: tbW, height: tbH, class: 'title-block' }, layers['title-block']);

  // Subdivide the title block.
  const cellW = tbW / 4;
  for (let i = 1; i < 4; i++) {
    svg('line', {
      x1: tbX + cellW * i, y1: tbY, x2: tbX + cellW * i, y2: tbY + tbH,
      class: 'title-block', 'stroke-width': 20,
    }, layers['title-block']);
  }
  const fields = [
    ['PROJECT', state.project.title],
    ['CLIENT', state.project.client || '—'],
    ['PROJECT No.', state.project.projectNumber],
    ['SCALE / DATE', `1:${state.project.scale}  ${state.project.date}`],
  ];
  fields.forEach(([k, v], i) => {
    svg('text', {
      x: tbX + cellW * i + 50, y: tbY + 220,
      class: 'title-block-text',
      'font-size': 130, 'font-weight': 700, fill: '#5a6477',
    }, layers['title-block']).textContent = k;
    svg('text', {
      x: tbX + cellW * i + 50, y: tbY + 460,
      class: 'title-block-text',
      'font-size': 220, 'font-weight': 700,
    }, layers['title-block']).textContent = v;
  });

  // Notes row at the bottom of the title block.
  svg('text', {
    x: tbX + 50, y: tbY + 800,
    class: 'title-block-text',
    'font-size': 140, fill: '#5a6477',
  }, layers['title-block']).textContent = 'DRAWING — UFH SETTING-OUT LAYOUT';
  svg('text', {
    x: tbX + 50, y: tbY + 1050,
    class: 'title-block-text',
    'font-size': 110, fill: '#8a93a4',
  }, layers['title-block']).textContent = 'DO NOT SCALE FROM THIS DRAWING — ALL DIMENSIONS TO BE CHECKED ON SITE';
}

// Preview helpers used by the editor while dragging.
export function showPreviewRect(rect) {
  clear(layers.preview);
  if (!rect) return;
  svg('rect', {
    x: Math.min(rect.x, rect.x + rect.w),
    y: Math.min(rect.y, rect.y + rect.h),
    width: Math.abs(rect.w),
    height: Math.abs(rect.h),
    class: 'preview',
  }, layers.preview);
}

export function clearPreview() { clear(layers.preview); }

export function getCanvas() { return canvas; }
