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
};

let nextId = 1;
export function newId(prefix) { return `${prefix}-${nextId++}`; }

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

export function addRoom(rect) {
  const room = {
    id: newId('room'),
    name: `ROOM ${state.rooms.length + 1}`,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
    walls: { n: 'external', e: 'internal', s: 'internal', w: 'external' },
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
  Object.assign(r, patch);
  emit();
}

export function deleteRoom(id) {
  const idx = state.rooms.findIndex(r => r.id === id);
  if (idx >= 0) state.rooms.splice(idx, 1);
  if (state.selection.id === id) clearSelection();
  emit();
}

export function toggleWall(roomId, side) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r) return;
  r.walls[side] = r.walls[side] === 'external' ? 'internal' : 'external';
  emit();
}

export function addNoGo(roomId, rect) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r) return;
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
  r.noGoZones = r.noGoZones.filter(z => z.id !== nogoId);
  emit();
}

// Doors live as openings on a specific wall side, parameterised by the
// fractional centre position (0..1 along the wall) and a width in millimetres.
// Walls render with a gap at each door, and pipe tails route through them.
export function addDoor(roomId, side, center, width = 800) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r) return;
  if (!r.doors) r.doors = [];
  const c = Math.max(0.05, Math.min(0.95, center));
  r.doors.push({
    id: newId('door'),
    side,
    center: c,
    width,
  });
  emit();
}

export function deleteDoor(roomId, doorId) {
  const r = state.rooms.find(r => r.id === roomId);
  if (!r || !r.doors) return;
  r.doors = r.doors.filter(d => d.id !== doorId);
  emit();
}

export function setManifold(point) {
  state.manifold = { x: Math.round(point.x), y: Math.round(point.y) };
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
  state.rooms = [];
  state.manifold = null;
  state.loops = [];
  state.warnings = [];
  state.selection = { type: null, id: null };
  emit();
}

export function loadSample() {
  state.rooms = [];
  state.loops = [];
  state.warnings = [];
  // A modest cottage-style ground floor: kitchen, dining, living, hall, WC.
  // Coordinates in millimetres.
  state.rooms.push({
    id: newId('room'), name: 'KITCHEN',
    x: 0, y: 0, w: 4500, h: 3500,
    walls: { n: 'external', e: 'internal', s: 'internal', w: 'external' },
    noGoZones: [
      { id: newId('nogo'), x: 0, y: 0, w: 4500, h: 600 },           // run of units along north wall
      { id: newId('nogo'), x: 0, y: 600, w: 600, h: 1800 },          // tall units against west wall
    ],
    doors: [{ id: newId('door'), side: 's', center: 0.85, width: 800 }],
    pattern: 'serpentine', finish: 'tile', zoneCount: 1,
  });
  state.rooms.push({
    id: newId('room'), name: 'DINING',
    x: 4500, y: 0, w: 3500, h: 3500,
    walls: { n: 'external', e: 'external', s: 'internal', w: 'internal' },
    noGoZones: [],
    doors: [{ id: newId('door'), side: 's', center: 0.2, width: 900 }],
    pattern: 'serpentine', finish: 'engineered', zoneCount: 1,
  });
  state.rooms.push({
    id: newId('room'), name: 'LIVING',
    x: 0, y: 3500, w: 5500, h: 4500,
    walls: { s: 'external', w: 'external', n: 'internal', e: 'internal' },
    noGoZones: [
      { id: newId('nogo'), x: 1800, y: 3500, w: 1400, h: 400 },       // fireplace hearth
    ],
    doors: [{ id: newId('door'), side: 'e', center: 0.05, width: 900 }],
    pattern: 'bifilar', finish: 'carpet', zoneCount: 2,
  });
  state.rooms.push({
    id: newId('room'), name: 'HALL',
    x: 5500, y: 3500, w: 1800, h: 4500,
    walls: { s: 'external', n: 'internal', e: 'internal', w: 'internal' },
    noGoZones: [
      { id: newId('nogo'), x: 5500, y: 5800, w: 1800, h: 1500 },     // stairs
    ],
    doors: [
      { id: newId('door'), side: 'n', center: 0.5, width: 900 },
      { id: newId('door'), side: 'w', center: 0.05, width: 900 },
    ],
    pattern: 'hybrid', finish: 'tile', zoneCount: 1,
  });
  state.rooms.push({
    id: newId('room'), name: 'WC',
    x: 7300, y: 3500, w: 700, h: 1800,
    walls: { e: 'external', n: 'internal', s: 'internal', w: 'internal' },
    noGoZones: [
      { id: newId('nogo'), x: 7400, y: 3550, w: 500, h: 700 },        // WC pan + cistern
    ],
    doors: [{ id: newId('door'), side: 'w', center: 0.85, width: 700 }],
    pattern: 'serpentine', finish: 'tile', zoneCount: 1,
  });
  state.manifold = { x: 5500, y: 3450 };
  state.selection = { type: null, id: null };
  emit();
}
