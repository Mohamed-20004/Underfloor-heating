// state.js — central application state and small pub/sub.
// Coordinates and dimensions are in millimetres throughout.

const listeners = new Set();

export const state = {
  project: {
    title: 'Untitled Project',
    client: '',
    projectNumber: 'UFH-001',
    date: new Date().toISOString().slice(0, 10),
    scale: 50,
  },
  config: {
    pipeSpacing: 200,
    edgeSpacing: 100,
    wallSetback: 100,
    edgeZoneWidth: 1000,
    maxLoopLength: 100000,
    minBendRadius: 80,
    pipeOD: 16,
    wastageFactor: 1.08,
  },
  rooms: [],
  manifold: null,
  loops: [],
  warnings: [],
  selection: { type: null, id: null },
  mode: 'select',
  view: { zoom: 0.08, panX: 60, panY: 60 },
  // Tracing image (a floor-plan photo or PDF page rasterised) shown beneath
  // the rooms layer at user-set opacity and size, used to draw the plan over
  // it. Set via setTracingImage; null when none is loaded.
  tracingImage: null,
};

let nextId = 1;
export function newId(prefix) { return `${prefix}-${nextId++}`; }

// Undo history. We snapshot only the data the user is editing — rooms,
// manifold, tracing image — not derived state like loops or warnings.
const HISTORY_LIMIT = 50;
const history = [];

function snapshot() {
  return {
    rooms: structuredClone(state.rooms),
    manifold: state.manifold ? { ...state.manifold } : null,
    tracingImage: state.tracingImage ? { ...state.tracingImage } : null,
  };
}

// Call this at the start of every mutating action (before the change). The
// snapshot represents the state to roll back to when the user hits Undo.
export function pushUndo() {
  history.push(snapshot());
  if (history.length > HISTORY_LIMIT) history.shift();
}

export function undo() {
  if (history.length === 0) return false;
  const last = history.pop();
  state.rooms = last.rooms;
  state.manifold = last.manifold;
  state.tracingImage = last.tracingImage;
  state.loops = [];
  state.warnings = [];
  state.selection = { type: null, id: null };
  emit();
  return true;
}

export function canUndo() { return history.length > 0; }

export function clearHistory() { history.length = 0; }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { for (const fn of listeners) fn(state); }

export function setMode(mode) {
  state.mode = mode;
  emit();
}

export function selectRoom(id) {
  state.selection = { type: 'room', id };
  emit();
}
export function clearSelection() {
  state.selection = { type: null, id: null };
  emit();
}

// Build a polygon room. `vertices` is a closed clockwise polygon (last point
// not repeated). `edgeKinds` is an array of 'external' | 'internal' parallel
// to vertices: edgeKinds[i] is the wall type of the edge from vertices[i] to
// vertices[(i+1) % N].
export function addRoom(rect) {
  pushUndo();
  const vertices = [
    { x: Math.round(rect.x), y: Math.round(rect.y) },
    { x: Math.round(rect.x + rect.w), y: Math.round(rect.y) },
    { x: Math.round(rect.x + rect.w), y: Math.round(rect.y + rect.h) },
    { x: Math.round(rect.x), y: Math.round(rect.y + rect.h) },
  ];
  return addRoomFromVertices(vertices, ['external', 'internal', 'internal', 'external']);
}

export function addCustomRoom(vertices) {
  if (!vertices || vertices.length < 3) return null;
  pushUndo();
  return addRoomFromVertices(vertices, vertices.map(() => 'external'));
}

function addRoomFromVertices(vertices, edgeKinds) {
  const room = {
    id: newId('room'),
    name: `ROOM ${state.rooms.length + 1}`,
    vertices: vertices.map(v => ({ x: Math.round(v.x), y: Math.round(v.y) })),
    edgeKinds: edgeKinds.slice(),
    noGoZones: [],
    doors: [],
    pattern: 'serpentine',
    finish: 'tile',
    zoneCount: 1,
  };
  state.rooms.push(room);
  state.selection = { type: 'room', id: room.id };
  emit();
  return room;
}

export function updateRoom(id, patch) {
  const r = state.rooms.find(r => r.id === id);
  if (!r) return;
  pushUndo();
  Object.assign(r, patch);
  emit();
}

export function deleteRoom(id) {
  const idx = state.rooms.findIndex(r => r.id === id);
  if (idx < 0) return;
  pushUndo();
  state.rooms.splice(idx, 1);
  if (state.selection.id === id) clearSelection();
  emit();
}

export function toggleWall(roomId, edgeIndex) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r) return;
  const i = Number(edgeIndex);
  if (Number.isNaN(i) || i < 0 || i >= r.edgeKinds.length) return;
  pushUndo();
  r.edgeKinds[i] = r.edgeKinds[i] === 'external' ? 'internal' : 'external';
  emit();
}

export function addNoGo(roomId, rect) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r) return;
  pushUndo();
  r.noGoZones.push({
    id: newId('nogo'),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  });
  emit();
}

export function deleteNoGo(roomId, nogoId) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r) return;
  pushUndo();
  r.noGoZones = r.noGoZones.filter(z => z.id !== nogoId);
  emit();
}

// Doors live on a polygon edge identified by edgeIndex (0..vertices.length-1)
// at fractional centre `center` (0..1) along the edge, with a width in mm.
export function addDoor(roomId, edgeIndex, center, width = 800) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r) return;
  if (!r.doors) r.doors = [];
  const c = Math.max(0.05, Math.min(0.95, center));
  pushUndo();
  r.doors.push({
    id: newId('door'),
    edgeIndex: Number(edgeIndex),
    center: c,
    width,
  });
  emit();
}

export function deleteDoor(roomId, doorId) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r || !r.doors) return;
  pushUndo();
  r.doors = r.doors.filter(d => d.id !== doorId);
  emit();
}

// Remove a vertex from a polygon room. Adjacent edges merge; edge kinds are
// preserved for the surviving edge by inheriting from the previous edge.
// Refuses to drop below 3 vertices (a polygon cannot be smaller).
export function deleteVertex(roomId, vertexIndex) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r || !r.vertices || r.vertices.length <= 3) return;
  const i = Number(vertexIndex);
  if (Number.isNaN(i) || i < 0 || i >= r.vertices.length) return;
  pushUndo();
  const prevEdge = (i - 1 + r.edgeKinds.length) % r.edgeKinds.length;
  r.vertices.splice(i, 1);
  // Remove the outgoing edge of the deleted vertex; the incoming edge survives.
  r.edgeKinds.splice(i, 1);
  // Doors that lived on the removed edge are dropped; doors on later edges
  // shift down by one index. Doors on the surviving (previous) edge are kept
  // but their `center` is invalid because the edge length changed; re-clamp.
  if (r.doors && r.doors.length > 0) {
    r.doors = r.doors.flatMap(d => {
      if (d.edgeIndex === i) return []; // door on removed edge
      const newIdx = d.edgeIndex > i ? d.edgeIndex - 1 : d.edgeIndex;
      return [{ ...d, edgeIndex: newIdx, center: Math.max(0.05, Math.min(0.95, d.center)) }];
    });
  }
  emit();
}

export function setManifold(point) {
  pushUndo();
  state.manifold = { x: Math.round(point.x), y: Math.round(point.y) };
  emit();
}

// Tracing image actions. The image is stored as a data URL so it persists in
// memory across edits but is not written to localStorage (data URLs of typical
// floor-plan photos can exceed the 5 MB localStorage cap).
export function setTracingImage({ src, naturalWidth, naturalHeight, widthMM = 10000 }) {
  pushUndo();
  const ar = naturalHeight / naturalWidth || 1;
  state.tracingImage = {
    src,
    naturalWidth,
    naturalHeight,
    x: 0,
    y: 0,
    w: widthMM,
    h: widthMM * ar,
    opacity: 0.5,
  };
  emit();
}

let lastTraceUpdateAt = 0;
export function updateTracingImage(patch) {
  if (!state.tracingImage) return;
  // Coalesce rapid-fire calls (drag, slider) into one undo entry per gesture.
  const now = Date.now();
  if (now - lastTraceUpdateAt > 500) pushUndo();
  lastTraceUpdateAt = now;
  Object.assign(state.tracingImage, patch);
  if (patch.w !== undefined) {
    const ar = state.tracingImage.naturalHeight / state.tracingImage.naturalWidth || 1;
    state.tracingImage.h = state.tracingImage.w * ar;
  }
  emit();
}

export function removeTracingImage() {
  pushUndo();
  state.tracingImage = null;
  emit();
}

export function setLoops(loops, warnings) {
  state.loops = loops;
  state.warnings = warnings || [];
  emit();
}

export function clearLoops() {
  state.loops = [];
  state.warnings = [];
  emit();
}

export function clearAll() {
  pushUndo();
  state.rooms = [];
  state.manifold = null;
  state.loops = [];
  state.warnings = [];
  state.selection = { type: null, id: null };
  emit();
}

// Edge indices for rectangle-shaped polygons (clockwise from top-left):
// 0 = north (top), 1 = east (right), 2 = south (bottom), 3 = west (left).
const SIDE = { n: 0, e: 1, s: 2, w: 3 };

function rectRoom({ name, x, y, w, h, walls, doors = [], noGoZones = [], pattern = 'serpentine', finish = 'tile', zoneCount = 1 }) {
  return {
    id: newId('room'),
    name,
    vertices: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    edgeKinds: [walls.n || 'internal', walls.e || 'internal', walls.s || 'internal', walls.w || 'internal'],
    noGoZones,
    doors: doors.map(d => ({
      id: newId('door'),
      edgeIndex: SIDE[d.side],
      center: d.center,
      width: d.width,
    })),
    pattern, finish, zoneCount,
  };
}

export function loadSample() {
  pushUndo();
  state.rooms = [];
  state.loops = [];
  state.warnings = [];
  // A modest cottage-style ground floor: kitchen, dining, living, hall, WC.
  // Coordinates in millimetres.
  state.rooms.push(rectRoom({
    name: 'KITCHEN',
    x: 0, y: 0, w: 4500, h: 3500,
    walls: { n: 'external', e: 'internal', s: 'internal', w: 'external' },
    noGoZones: [
      { id: newId('nogo'), x: 0, y: 0, w: 4500, h: 600 },           // run of units along north wall
      { id: newId('nogo'), x: 0, y: 600, w: 600, h: 1800 },          // tall units against west wall
    ],
    doors: [{ side: 's', center: 0.85, width: 800 }],
    pattern: 'serpentine', finish: 'tile',
  }));
  state.rooms.push(rectRoom({
    name: 'DINING',
    x: 4500, y: 0, w: 3500, h: 3500,
    walls: { n: 'external', e: 'external', s: 'internal', w: 'internal' },
    doors: [{ side: 's', center: 0.2, width: 900 }],
    pattern: 'serpentine', finish: 'engineered',
  }));
  state.rooms.push(rectRoom({
    name: 'LIVING',
    x: 0, y: 3500, w: 5500, h: 4500,
    walls: { s: 'external', w: 'external', n: 'internal', e: 'internal' },
    noGoZones: [
      { id: newId('nogo'), x: 1800, y: 3500, w: 1400, h: 400 },       // fireplace hearth
    ],
    doors: [{ side: 'e', center: 0.05, width: 900 }],
    pattern: 'bifilar', finish: 'carpet', zoneCount: 2,
  }));
  state.rooms.push(rectRoom({
    name: 'HALL',
    x: 5500, y: 3500, w: 1800, h: 4500,
    walls: { s: 'external', n: 'internal', e: 'internal', w: 'internal' },
    noGoZones: [
      { id: newId('nogo'), x: 5500, y: 5800, w: 1800, h: 1500 },     // stairs
    ],
    doors: [
      { side: 'n', center: 0.5, width: 900 },
      { side: 'w', center: 0.05, width: 900 },
    ],
    pattern: 'hybrid', finish: 'tile',
  }));
  state.rooms.push(rectRoom({
    name: 'WC',
    x: 7300, y: 3500, w: 700, h: 1800,
    walls: { e: 'external', n: 'internal', s: 'internal', w: 'internal' },
    noGoZones: [
      { id: newId('nogo'), x: 7400, y: 3550, w: 500, h: 700 },        // WC pan + cistern
    ],
    doors: [{ side: 'w', center: 0.85, width: 700 }],
    pattern: 'serpentine', finish: 'tile',
  }));
  state.manifold = { x: 5500, y: 3450 };
  state.selection = { type: null, id: null };
  emit();
}
