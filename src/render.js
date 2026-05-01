// render.js — SVG rendering of the floor plan, pipes, labels, and title block.
// The SVG uses a viewBox in millimetres so vector exports are correctly scaled.

import { state } from './state.js';
import { pointsToSmoothPath, bbox } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let canvas;
let layers = {};

export function initRenderer(svgEl) {
  canvas = svgEl;
  // Build persistent layer groups so we can re-render without thrashing.
  canvas.innerHTML = '';
  for (const name of ['background', 'rooms', 'walls', 'nogo', 'pipes', 'tails', 'manifold', 'labels', 'preview', 'title-block']) {
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
  const w = canvas.clientWidth || 1200;
  const h = canvas.clientHeight || 800;
  // viewBox covers the world in mm. View pan/zoom is implemented by adjusting
  // the viewBox so the same content area is visible regardless of canvas size.
  const z = state.view.zoom; // px per mm
  const vbW = w / z;
  const vbH = h / z;
  const vbX = -state.view.panX / z;
  const vbY = -state.view.panY / z;
  canvas.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
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
    all.push({ x: r.x, y: r.y });
    all.push({ x: r.x + r.w, y: r.y + r.h });
  }
  if (state.manifold) all.push(state.manifold);
  if (all.length < 2) return;
  const b = bbox(all);
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
  drawRooms();
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
  // A subtle grid every 1 m.
  const gridSpacing = 1000;
  const w = canvas.clientWidth || 1200;
  const h = canvas.clientHeight || 800;
  const z = state.view.zoom;
  const vbW = w / z, vbH = h / z;
  const vbX = -state.view.panX / z, vbY = -state.view.panY / z;
  const startX = Math.floor(vbX / gridSpacing) * gridSpacing;
  const startY = Math.floor(vbY / gridSpacing) * gridSpacing;
  for (let x = startX; x < vbX + vbW; x += gridSpacing) {
    svg('line', { x1: x, y1: vbY, x2: x, y2: vbY + vbH, stroke: '#e8eaee', 'stroke-width': 10 }, layers.background);
  }
  for (let y = startY; y < vbY + vbH; y += gridSpacing) {
    svg('line', { x1: vbX, y1: y, x2: vbX + vbW, y2: y, stroke: '#e8eaee', 'stroke-width': 10 }, layers.background);
  }
}

function drawRooms() {
  clear(layers.rooms);
  for (const room of state.rooms) {
    const isSelected = state.selection.id === room.id;
    svg('rect', {
      x: room.x, y: room.y, width: room.w, height: room.h,
      class: 'room-rect' + (isSelected ? ' selected' : ''),
      'data-room-id': room.id,
    }, layers.rooms);
    // Room label.
    const labelSize = Math.min(room.w, room.h) * 0.10;
    const fontSize = Math.max(120, Math.min(260, labelSize));
    svg('text', {
      x: room.x + room.w / 2,
      y: room.y + room.h / 2 - fontSize * 0.1,
      class: 'room-label',
      'font-size': fontSize,
    }, layers.rooms).textContent = room.name;
    const areaSize = fontSize * 0.55;
    svg('text', {
      x: room.x + room.w / 2,
      y: room.y + room.h / 2 + areaSize * 1.4,
      class: 'room-area',
      'font-size': areaSize,
    }, layers.rooms).textContent = `${((room.w * room.h) / 1e6).toFixed(1)} m²`;
  }
}

function drawWalls() {
  clear(layers.walls);
  for (const room of state.rooms) {
    const x1 = room.x, y1 = room.y, x2 = room.x + room.w, y2 = room.y + room.h;
    const segs = {
      n: { a: { x: x1, y: y1 }, b: { x: x2, y: y1 } },
      e: { a: { x: x2, y: y1 }, b: { x: x2, y: y2 } },
      s: { a: { x: x1, y: y2 }, b: { x: x2, y: y2 } },
      w: { a: { x: x1, y: y1 }, b: { x: x1, y: y2 } },
    };
    for (const side of ['n', 'e', 's', 'w']) {
      const cls = room.walls[side] === 'external' ? 'wall external' : 'wall internal';
      svg('line', {
        x1: segs[side].a.x, y1: segs[side].a.y,
        x2: segs[side].b.x, y2: segs[side].b.y,
        class: cls,
        'data-room-id': room.id,
        'data-wall-side': side,
      }, layers.walls);
    }
  }
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
  const size = 400;
  svg('rect', {
    x: m.x - size / 2, y: m.y - size / 2,
    width: size, height: size,
    class: 'manifold',
    rx: 30,
  }, layers.manifold);
  svg('text', {
    x: m.x, y: m.y - size / 2 - 80,
    class: 'manifold-label',
    'font-size': 140,
  }, layers.manifold).textContent = 'M1';
  svg('text', {
    x: m.x, y: m.y + 50,
    class: 'manifold-label',
    'font-size': 100,
  }, layers.manifold).textContent = '◉';
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
