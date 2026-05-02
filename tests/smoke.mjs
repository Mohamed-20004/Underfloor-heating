// Headless smoke test for the engine layers (geometry, patterns, loops, calc).
// Avoids any DOM-dependent module.

import { state, loadSample, addCustomRoom, addFreeWall, addFreeWallDoor,
  setManifold, hideRoomEdge, clearAll } from '../src/state.js';
import { generateRoomPath } from '../src/patterns.js';
import { generateLoops, findMergedGroups } from '../src/loops.js';
import { summarise } from '../src/calc.js';
import { polylineLength, pointsToSmoothPath, polygonArea, clipHorizontalLine } from '../src/geometry.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures++;
  }
}

console.log('# Sample plan loads');
loadSample();
assert(state.rooms.length === 5, 'sample plan creates 5 rooms');
assert(!!state.manifold, 'manifold placed by sample loader');
assert(state.rooms.every(r => Array.isArray(r.doors)), 'every room has a doors array');
assert(state.rooms.find(r => r.name === 'LIVING').zoneCount === 2, 'living room has 2 zones');

console.log('# Per-room pattern generation');
for (const room of state.rooms) {
  const path = generateRoomPath(room, state.config);
  const len = path.length >= 2 ? polylineLength(path) : 0;
  assert(path.length >= 2, `${room.name} pattern=${room.pattern} produces a polyline (points=${path.length})`);
  assert(len > 0, `${room.name} polyline length > 0 (${(len / 1000).toFixed(1)} m)`);
  // Smooth-path string sanity.
  const d = pointsToSmoothPath(path, state.config.minBendRadius);
  assert(d.startsWith('M '), `${room.name} smooth path starts with M`);
  assert(d.includes('A '), `${room.name} smooth path contains arc commands`);
}

console.log('# Loop assembly');
const { loops, warnings } = generateLoops(state);
assert(loops.length >= 6, `at least one loop per zone (got ${loops.length})`);
for (const l of loops) {
  assert(l.totalLength <= state.config.maxLoopLength, `${l.label} respects max loop length`);
  assert(l.path.length >= 2, `${l.label} has polyline points`);
  assert(typeof l.colour === 'number' && l.colour >= 0 && l.colour <= 3, `${l.label} colour in [0,3]`);
}

console.log('# Multi-zone splitting');
const livingLoops = loops.filter(l => l.parentRoomName === 'LIVING');
assert(livingLoops.length >= 2, `LIVING room produces multiple loops via 2-zone split (got ${livingLoops.length})`);
const livingGroups = new Set(livingLoops.map(l => l.group));
assert(livingGroups.size >= 2, `LIVING zones get distinct group numbers (got ${livingGroups.size})`);

console.log('# Door-routed tails (graph routing — variable point count)');
for (const l of loops) {
  // After Stage 2, tails route via the navigation graph: at minimum the
  // polyline starts at the manifold and ends at the loop's first/last
  // pipe point, with door waypoints in between.
  assert(l.flowTail.length >= 2, `${l.label} flow tail has manifold→target polyline (got ${l.flowTail.length} points)`);
  assert(l.returnTail.length >= 2, `${l.label} return tail has manifold→target polyline (got ${l.returnTail.length} points)`);
}

console.log('# Adjacent loops differ in colour (truly overlapping bboxes)');
// We only enforce the no-shared-colour rule on truly overlapping bounding
// boxes. Loops that are merely "within 400 mm" can occasionally share a
// colour on dense plans because the proximity graph may contain K5 — which
// the four-colour theorem does not cover. Visually, loops that don't overlap
// remain readable when they share a colour.
let conflicts = 0;
for (let i = 0; i < loops.length; i++) {
  for (let j = i + 1; j < loops.length; j++) {
    const a = loops[i].bbox, b = loops[j].bbox;
    const overlap = !(a.x + a.w < b.x || b.x + b.w < a.x ||
                      a.y + a.h < b.y || b.y + b.h < a.y);
    if (overlap && loops[i].colour === loops[j].colour) conflicts++;
  }
}
assert(conflicts === 0, `colour graph has no overlap conflicts (found ${conflicts})`);

console.log('# Calculations');
state.loops = loops;
state.warnings = warnings;
const s = summarise(state);
assert(s.loopCount === loops.length, 'summary loop count matches');
assert(s.totalArea > 0, 'summary total area > 0');
assert(s.totalPipe > 0, 'summary total pipe > 0');
assert(s.orderQty > s.totalPipe, 'order qty includes wastage');

console.log('# Loop-length cap stress test');
// Force a very long path via a single big rectangular polygon room.
state.rooms = [{
  id: 'big', name: 'BIG',
  vertices: [
    { x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 6000 }, { x: 0, y: 6000 },
  ],
  edgeKinds: ['external', 'external', 'external', 'external'],
  noGoZones: [], doors: [{ id: 'door-big-1', edgeIndex: 0, center: 0.5, width: 900 }],
  pattern: 'serpentine', finish: 'tile', zoneCount: 1,
}];
state.manifold = { x: 4000, y: 0 };
state.config.pipeSpacing = 100;
state.config.edgeSpacing = 100;
const stressed = generateLoops(state);
const tooLong = stressed.loops.find(l => l.totalLength > state.config.maxLoopLength);
assert(!tooLong, `big room is split so no loop exceeds the cap (loops=${stressed.loops.length})`);
assert(stressed.loops.length >= 2, 'big room produces multiple loops via splitting');

console.log('# Custom polygon (L-shaped) room');
// Rebuild state for a clean L-shape test.
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
const lShape = [
  { x: 0, y: 0 },
  { x: 5000, y: 0 },
  { x: 5000, y: 3000 },
  { x: 3000, y: 3000 },
  { x: 3000, y: 5000 },
  { x: 0, y: 5000 },
];
const lRoom = addCustomRoom(lShape);
assert(!!lRoom, 'addCustomRoom returns a room');
assert(lRoom.vertices.length === 6, 'L-shape has 6 vertices');
const lArea = polygonArea(lShape);
const expectedArea = 5000 * 3000 + 3000 * 2000; // mm²
assert(Math.abs(lArea - expectedArea) < 1, `L-shape area is ${expectedArea} mm² (got ${lArea})`);
// The scanline at y=4000 should give exactly one interior interval [0, 3000].
const slice = clipHorizontalLine(4000, lShape);
assert(slice.length === 1 && slice[0][1] === 3000, `scanline at y=4000 of L-shape returns one interval ending at 3000 (got ${JSON.stringify(slice)})`);
// And the path generation works.
const lPath = generateRoomPath(lRoom, state.config);
assert(lPath.length >= 2, `L-shape path has points (got ${lPath.length})`);
assert(polylineLength(lPath) > 50000, `L-shape path is meaningful (>50 m of pipe; got ${(polylineLength(lPath)/1000).toFixed(1)} m)`);
setManifold({ x: 5000, y: 0 });
const lLoops = generateLoops(state);
assert(lLoops.loops.length >= 1, `L-shape produces at least one loop (got ${lLoops.loops.length})`);

console.log('# Free wall blocks pipe rows (with a door letting one row through)');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
const room = addCustomRoom([
  { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 },
]);
setManifold({ x: 0, y: 0 });
// Baseline pipe length without any wall.
const lenBaseline = polylineLength(generateRoomPath(room, state.config, []));
// Now drop a vertical free wall straight through the middle of the room.
const w = addFreeWall({ x: 3000, y: 500 }, { x: 3000, y: 3500 });
const lenWithWall = polylineLength(generateRoomPath(room, state.config, state.walls));
assert(lenWithWall < lenBaseline, `path is shorter once a wall blocks rows (${(lenBaseline/1000).toFixed(1)} m → ${(lenWithWall/1000).toFixed(1)} m)`);
// A door in the wall should let some pipe back through.
addFreeWallDoor(w.id, 0.5, 1200);
const lenWithDoor = polylineLength(generateRoomPath(room, state.config, state.walls));
assert(lenWithDoor > lenWithWall, `door restores some pipe through the wall (${(lenWithWall/1000).toFixed(1)} m → ${(lenWithDoor/1000).toFixed(1)} m)`);

console.log('# Auto-connect: adjacent zones route via an implicit doorway, no explicit wall/door needed');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
const utilA = addCustomRoom([
  { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { x: 0, y: 3000 },
]);
const heatA = addCustomRoom([
  { x: 2000, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 2000, y: 3000 },
]);
// No walls drawn between them — they just share the boundary at x=2000.
setManifold({ x: 1000, y: 1500 });
const outAuto = generateLoops(state);
const heatAutoLoop = outAuto.loops.find(l => l.parentRoomName === heatA.name);
assert(!!heatAutoLoop, 'heated room produces a loop');
// Tail should pass through the implicit doorway at the midpoint of the
// shared boundary, around (2000, 1500).
const passesShared = heatAutoLoop.flowTail.some(p =>
  Math.abs(p.x - 2000) < 50 && Math.abs(p.y - 1500) < 200,
);
assert(passesShared, 'flow tail passes through the implicit doorway at the shared edge midpoint');

console.log('# Stage 5: bundled parallel tails through a shared corridor');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
state.config.bundleSpacing = 50;
// Layout: utility on the left, a transit corridor running across the top,
// and two heated rooms BELOW the corridor side-by-side. Both heated rooms
// have doors on the corridor's south wall, so both flow tails route via
// the same SW corner and share both the west and south walls of the
// corridor — the situation Stage 5 should bundle.
const util3 = addCustomRoom([
  { x: 0, y: 500 }, { x: 2000, y: 500 }, { x: 2000, y: 1500 }, { x: 0, y: 1500 },
]);
const corridor3 = addCustomRoom([
  { x: 2000, y: 500 }, { x: 8000, y: 500 }, { x: 8000, y: 1500 }, { x: 2000, y: 1500 },
]);
corridor3.kind = 'transit';
const r1 = addCustomRoom([
  { x: 3000, y: 1500 }, { x: 5000, y: 1500 }, { x: 5000, y: 3500 }, { x: 3000, y: 3500 },
]);
const r2 = addCustomRoom([
  { x: 5000, y: 1500 }, { x: 7000, y: 1500 }, { x: 7000, y: 3500 }, { x: 5000, y: 3500 },
]);
const wWest = addFreeWall({ x: 2000, y: 500 }, { x: 2000, y: 1500 });
addFreeWallDoor(wWest.id, 0.5, 800);
const wDown1 = addFreeWall({ x: 3000, y: 1500 }, { x: 5000, y: 1500 });
addFreeWallDoor(wDown1.id, 0.5, 800);
const wDown2 = addFreeWall({ x: 5000, y: 1500 }, { x: 7000, y: 1500 });
addFreeWallDoor(wDown2.id, 0.5, 800);
setManifold({ x: 1000, y: 1000 });
const out5 = generateLoops(state);
const lp1 = out5.loops.find(l => l.parentRoomName === r1.name);
const lp2 = out5.loops.find(l => l.parentRoomName === r2.name);
assert(!!lp1 && !!lp2, 'both heated rooms produce loops');
// Both tails should hug the corridor's south wall (the wall closest to the
// destination doors). Compare the y-coordinate at any corridor-interior
// point for each loop — they should differ by ~bundleSpacing.
function southWallY(loop) {
  // The south-wall hug point has the maximum y among corridor-interior
  // points (those with x strictly inside the corridor and y inside it too).
  const interior = loop.flowTail.filter(p =>
    p.x > 2100 && p.x < 7900 && p.y > 600 && p.y < 1500,
  );
  return interior.length ? Math.max(...interior.map(p => p.y)) : null;
}
const y1 = southWallY(lp1);
const y2 = southWallY(lp2);
assert(y1 !== null && y2 !== null, `both tails enter the corridor (y1=${y1}, y2=${y2})`);
const d = Math.abs(y1 - y2);
assert(d > 30 && d < 80, `corridor south-wall y values offset by ~${state.config.bundleSpacing} mm (got |${y1}-${y2}|=${d})`);

console.log('# Stage 4: serpentine starts at the entry doorway side');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
// Heated rectangle 6 m × 4 m. Manifold sits to the EAST through a wall +
// door at the EAST side. The serpentine should start at the east end of the
// first row, not the (default) west end.
const heated2 = addCustomRoom([
  { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 },
]);
const eastWall = addFreeWall({ x: 6000, y: 0 }, { x: 6000, y: 4000 });
addFreeWallDoor(eastWall.id, 0.5, 800);
setManifold({ x: 7000, y: 2000 });
const out4 = generateLoops(state);
const heatedLoop = out4.loops[0];
assert(!!heatedLoop, 'heated loop generated');
// First pipe point's x-coord should be on the EAST half of the room.
const firstX = heatedLoop.path[0].x;
assert(firstX > 3000, `serpentine path[0] starts on east half (got x=${firstX.toFixed(0)})`);

console.log('# Stage 3: tail hugs wall through a transit corridor');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
// Manifold room (small utility) on the left, a long transit corridor in the
// middle, heated kitchen on the right. The path should enter the corridor,
// hug one of its long walls (not cut diagonally across), and exit into the
// kitchen.
const utilityZ = addCustomRoom([
  { x: 0, y: 1500 }, { x: 2000, y: 1500 }, { x: 2000, y: 2500 }, { x: 0, y: 2500 },
]);
const corridorZ = addCustomRoom([
  { x: 2000, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 4000 }, { x: 2000, y: 4000 },
]);
corridorZ.kind = 'transit';
const kitchenZ = addCustomRoom([
  { x: 8000, y: 1500 }, { x: 11000, y: 1500 }, { x: 11000, y: 2500 }, { x: 8000, y: 2500 },
]);
// Walls separating the rooms with doors in each.
const wL = addFreeWall({ x: 2000, y: 1500 }, { x: 2000, y: 2500 });
addFreeWallDoor(wL.id, 0.5, 800);
const wR = addFreeWall({ x: 8000, y: 1500 }, { x: 8000, y: 2500 });
addFreeWallDoor(wR.id, 0.5, 800);
setManifold({ x: 1000, y: 2000 });
const out3 = generateLoops(state);
const kLoop = out3.loops.find(l => l.parentRoomName === kitchenZ.name);
assert(!!kLoop, 'kitchen loop generated');
// Through the corridor, the tail should pass within 200 mm of either the
// north (y≈100) or south (y≈3900) inset wall — meaning we hug a wall rather
// than straight-line through y=2000.
const corridorPoints = kLoop.flowTail.filter(p => p.x > 2000 && p.x < 8000);
const huggedWall = corridorPoints.some(p => p.y < 300 || p.y > 3700);
assert(huggedWall, `tail hugs a corridor wall (north or south) — sample y values: ${corridorPoints.map(p => p.y.toFixed(0)).join(', ')}`);
// And the return tail uses the same path (its non-target points should match
// flow's non-target points).
const flowMids = kLoop.flowTail.slice(0, -1).map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`);
const returnMids = [...kLoop.returnTail].reverse().slice(0, -1).map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`);
assert(flowMids.join('|') === returnMids.join('|'), 'return tail mirrors flow path');

console.log('# Manifold tail routes through doorways, not crow-flies');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
// Two zones side-by-side: a small "utility" on the left containing the
// manifold, and a heated "kitchen" on the right. A wall sits between them
// with a door at its centre. The kitchen's tail must route via that door,
// not draw a straight line from the manifold across the wall.
const utility = addCustomRoom([
  { x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 4000 }, { x: 0, y: 4000 },
]);
const kitchen = addCustomRoom([
  { x: 3000, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 4000 }, { x: 3000, y: 4000 },
]);
// Wall along the shared boundary x=3000 with a door in the middle.
const wall = addFreeWall({ x: 3000, y: 0 }, { x: 3000, y: 4000 });
addFreeWallDoor(wall.id, 0.5, 900);
setManifold({ x: 1500, y: 200 }); // inside the utility room near its top wall
const out2 = generateLoops(state);
const kitchenLoop = out2.loops.find(l => l.parentRoomName === kitchen.name);
assert(!!kitchenLoop, 'kitchen loop generated');
// The flow tail should have at least 3 points: manifold, door, room entry.
assert(kitchenLoop.flowTail.length >= 3, `flow tail routes through ≥1 door (got ${kitchenLoop.flowTail.length} points)`);
// One of those points should be near the door centre (3000, 2000).
const passesNearDoor = kitchenLoop.flowTail.some(p =>
  Math.abs(p.x - 3000) < 50 && Math.abs(p.y - 2000) < 200,
);
assert(passesNearDoor, 'flow tail passes through the door at (3000, 2000)');

console.log('# Transit-corridor zones do not produce a loop');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
const heated = addCustomRoom([
  { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 },
]);
const transit = addCustomRoom([
  { x: 5000, y: 0 }, { x: 7000, y: 0 }, { x: 7000, y: 3000 }, { x: 5000, y: 3000 },
]);
transit.kind = 'transit';
setManifold({ x: 0, y: 0 });
const out = generateLoops(state);
const heatedLoops = out.loops.filter(l => l.parentRoomName === heated.name);
const transitLoops = out.loops.filter(l => l.parentRoomName === transit.name);
assert(heatedLoops.length >= 1, `heated zone produces at least 1 loop (got ${heatedLoops.length})`);
assert(transitLoops.length === 0, `transit zone produces no loops (got ${transitLoops.length})`);
assert(out.warnings.some(w => w.message.includes('transit corridor')), 'transit warning emitted');

console.log('# Two rooms merge into one continuous loop when their shared wall is deleted');
clearAll();
state.config.pipeSpacing = 200;
state.config.edgeSpacing = 100;
state.config.wallSetback = 100;
const roomA = addCustomRoom([
  { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 },
]);
const roomB = addCustomRoom([
  { x: 4000, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 3000 }, { x: 4000, y: 3000 },
]);
setManifold({ x: 0, y: 0 });
// Pre-merge: two separate groups.
const beforeGroups = findMergedGroups(state.rooms);
assert(beforeGroups.length === 2, `before deletion: 2 separate groups (got ${beforeGroups.length})`);
// Delete the wall between the rooms (room A's east edge).
// Room A vertices in CW order: 0=NW, 1=NE, 2=SE, 3=SW. East edge is index 1.
hideRoomEdge(roomA.id, 1);
const afterGroups = findMergedGroups(state.rooms);
assert(afterGroups.length === 1 && afterGroups[0].length === 2, `after deletion: rooms merged into one group (got ${afterGroups.length} group(s))`);
// Pipe gen: only one loop should cover both rooms.
const merged = generateLoops(state);
const loopRoomNames = new Set(merged.loops.map(l => l.parentRoomName));
assert(loopRoomNames.size === 1, `merged group produces a single primary room loop set (got ${[...loopRoomNames].join(', ')})`);
// The combined pipe length should be roughly the sum of two separate runs;
// at minimum, it should be substantially more than one room alone.
const totalPipe = merged.loops.reduce((s, l) => s + l.pipeLength, 0);
// One room alone (12 m²) at 200 mm spacing produces roughly 70–80 m. Two
// rooms merged should be clearly more than that.
assert(totalPipe > 130000, `merged pipe coverage spans both rooms (got ${(totalPipe/1000).toFixed(1)} m)`);

if (failures === 0) {
  console.log(`\nAll smoke tests passed (${failures} failures).`);
  process.exit(0);
} else {
  console.log(`\n${failures} failure(s).`);
  process.exit(1);
}
