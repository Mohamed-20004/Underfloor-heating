// Focused door-behaviour smoke tests.
// Exercises:
//   1. Add / delete free-wall doors
//   2. Slide a door along its wall
//   3. Without a door, a wall blocks pipes; adding one creates a gap
//   4. The navigation graph includes doors and routes through them
//   5. Two doors on the same wall both work
//   6. Door positions are correctly identified between two adjacent rooms
//   7. Manifold tails reach a heated room via the chosen door

import { state, clearAll, addCustomRoom, addFreeWall, addFreeWallDoor,
  deleteFreeWallDoor, setFreeWallDoorCenter, setManifold } from '../src/state.js';
import { generateRoomPath } from '../src/patterns.js';
import { generateLoops } from '../src/loops.js';
import { buildNavGraph, shortestPath, findEntryDoor, transitRoomsToReach } from '../src/routing.js';
import { polylineLength } from '../src/geometry.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
}

function reset() {
  clearAll();
  state.config.pipeSpacing = 200;
  state.config.edgeSpacing = 100;
  state.config.wallSetback = 100;
  state.config.bundleSpacing = 50;
}

console.log('# 1. Add / delete a door on a free wall');
reset();
const w = addFreeWall({ x: 0, y: 0 }, { x: 4000, y: 0 });
const d = addFreeWallDoor(w.id, 0.5, 800);
assert(!!d && typeof d.id === 'string', 'addFreeWallDoor returns a door object with an id');
assert(w.doors.length === 1, 'door is stored on the parent wall');
assert(w.doors[0].center === 0.5, 'door centre is recorded');
assert(w.doors[0].width === 800, 'door width is recorded');

deleteFreeWallDoor(w.id, d.id);
assert(w.doors.length === 0, 'deleteFreeWallDoor removes the door');

console.log('# 2. Slide a door along its wall');
reset();
const w2 = addFreeWall({ x: 0, y: 0 }, { x: 4000, y: 0 });
const d2 = addFreeWallDoor(w2.id, 0.3, 800);
setFreeWallDoorCenter(w2.id, d2.id, 0.7);
assert(w2.doors[0].center === 0.7, 'setFreeWallDoorCenter updates the centre');
// Out-of-range values are clamped.
setFreeWallDoorCenter(w2.id, d2.id, 1.5);
assert(w2.doors[0].center === 0.95, 'centre is clamped to 0.95 max');
setFreeWallDoorCenter(w2.id, d2.id, -0.2);
assert(w2.doors[0].center === 0.05, 'centre is clamped to 0.05 min');

console.log('# 3. Wall blocks pipes; door creates a gap');
reset();
const room = addCustomRoom([
  { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 },
]);
const baselineLen = polylineLength(generateRoomPath(room, state.config, []));
// Drop a vertical wall straight through the middle.
const blockingWall = addFreeWall({ x: 3000, y: 500 }, { x: 3000, y: 3500 });
const blockedLen = polylineLength(generateRoomPath(room, state.config, state.walls));
assert(blockedLen < baselineLen, `wall reduces pipe coverage (${(baselineLen/1000).toFixed(0)}m → ${(blockedLen/1000).toFixed(0)}m)`);
// Now add a wide door — pipe should pass through.
const gapDoor = addFreeWallDoor(blockingWall.id, 0.5, 1200);
const withDoorLen = polylineLength(generateRoomPath(room, state.config, state.walls));
assert(withDoorLen > blockedLen, `door restores some pipe coverage (${(blockedLen/1000).toFixed(0)}m → ${(withDoorLen/1000).toFixed(0)}m)`);
// Removing the door restores blocked behaviour.
deleteFreeWallDoor(blockingWall.id, gapDoor.id);
const reBlockedLen = polylineLength(generateRoomPath(room, state.config, state.walls));
assert(Math.abs(reBlockedLen - blockedLen) < 50, 'removing the door re-blocks the wall');

console.log('# 4. Navigation graph includes door nodes');
reset();
const utility = addCustomRoom([
  { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { x: 0, y: 3000 },
]);
const heated = addCustomRoom([
  { x: 2000, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 2000, y: 3000 },
]);
const wB = addFreeWall({ x: 2000, y: 0 }, { x: 2000, y: 3000 });
const dB = addFreeWallDoor(wB.id, 0.5, 800);
setManifold({ x: 1000, y: 1500 });
const graph = buildNavGraph(state);
const doorNodes = graph.nodes.filter(n => n.type === 'door');
// Auto-connect adds an implicit doorway at the shared boundary, plus the
// explicit door on the wall — so we get two door nodes, both connecting
// utility ↔ heated.
assert(doorNodes.length >= 1, `graph has at least one door node (got ${doorNodes.length})`);
const linksUtilityAndHeated = doorNodes.some(n =>
  (n.roomA === utility.id || n.roomB === utility.id) &&
  (n.roomA === heated.id || n.roomB === heated.id),
);
assert(linksUtilityAndHeated, 'at least one door node links utility ↔ heated');

console.log('# 5. Two doors on one wall both register as separate nodes');
reset();
const sharedWall = addFreeWall({ x: 0, y: 0 }, { x: 6000, y: 0 });
const dA = addFreeWallDoor(sharedWall.id, 0.25, 800);
const dC = addFreeWallDoor(sharedWall.id, 0.75, 800);
assert(sharedWall.doors.length === 2, '2 doors stored on the wall');
assert(dA.id !== dC.id, 'each door has a unique id');
const g2 = buildNavGraph(state);
const wallDoors = g2.nodes.filter(n => n.type === 'door');
assert(wallDoors.length === 2, `graph has 2 door nodes (got ${wallDoors.length})`);

console.log('# 6. Manifold tail routes through the chosen door');
reset();
const utility2 = addCustomRoom([
  { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { x: 0, y: 3000 },
]);
const heated2 = addCustomRoom([
  { x: 2000, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 2000, y: 3000 },
]);
const wMid = addFreeWall({ x: 2000, y: 0 }, { x: 2000, y: 3000 });
const door = addFreeWallDoor(wMid.id, 0.5, 800);
setManifold({ x: 1000, y: 1500 });
const out = generateLoops(state);
const loop = out.loops.find(l => l.parentRoomName === heated2.name);
assert(!!loop, 'heated room produces a loop');
const passesNearDoor = loop.flowTail.some(p =>
  Math.abs(p.x - 2000) < 50 && Math.abs(p.y - 1500) < 200,
);
assert(passesNearDoor, 'flow tail passes within 200 mm of the door at (2000, 1500)');

console.log('# 7. findEntryDoor returns the door used by the routing');
const entryPos = findEntryDoor(state, heated2);
assert(!!entryPos, 'findEntryDoor returns a position');
assert(Math.abs(entryPos.x - 2000) < 1 && Math.abs(entryPos.y - 1500) < 1,
  `entry door is at (2000, 1500) — got (${entryPos.x.toFixed(0)}, ${entryPos.y.toFixed(0)})`);

console.log('# 8. With non-adjacent rooms, removing the only door cuts the route');
reset();
// Rooms separated by a small gap so there's NO shared boundary (no
// implicit doorway). The wall sits in the gap close enough that its door
// side anchors fall inside both rooms — so the door IS a viable routing
// node before deletion. Deleting it removes the only path.
const u3 = addCustomRoom([
  { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { x: 0, y: 3000 },
]);
const h3 = addCustomRoom([
  { x: 2100, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 3000 }, { x: 2100, y: 3000 },
]);
const wIso = addFreeWall({ x: 2050, y: 0 }, { x: 2050, y: 3000 });
const dIso = addFreeWallDoor(wIso.id, 0.5, 800);
setManifold({ x: 1000, y: 1500 });
const beforeOut = generateLoops(state);
const beforeLoop = beforeOut.loops.find(l => l.parentRoomName === h3.name);
const beforeFlowLen = beforeLoop.flowTail.length;
deleteFreeWallDoor(wIso.id, dIso.id);
const afterOut = generateLoops(state);
const afterLoop = afterOut.loops.find(l => l.parentRoomName === h3.name);
// With no door and no shared boundary, the graph has no path; the tail
// falls back to a straight line (2 points: manifold → first pipe point).
assert(afterLoop.flowTail.length === 2,
  `flow tail collapses to straight-line fallback when fully isolated (got ${afterLoop.flowTail.length} points)`);
assert(afterLoop.flowTail.length < beforeFlowLen,
  `tail is shorter after deleting the only door (was ${beforeFlowLen}, now ${afterLoop.flowTail.length})`);

console.log('# 9. Door on a wall between two heated rooms — both rooms route through it');
reset();
// Place manifold in left room, two heated rooms.
const left = addCustomRoom([
  { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, { x: 0, y: 3000 },
]);
const middle = addCustomRoom([
  { x: 2000, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 3000 }, { x: 2000, y: 3000 },
]);
const right = addCustomRoom([
  { x: 5000, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 3000 }, { x: 5000, y: 3000 },
]);
middle.kind = 'transit';
const wLM = addFreeWall({ x: 2000, y: 0 }, { x: 2000, y: 3000 });
addFreeWallDoor(wLM.id, 0.5, 800);
const wMR = addFreeWall({ x: 5000, y: 0 }, { x: 5000, y: 3000 });
addFreeWallDoor(wMR.id, 0.5, 800);
setManifold({ x: 1000, y: 1500 });
const out9 = generateLoops(state);
const rightLoop = out9.loops.find(l => l.parentRoomName === right.name);
assert(!!rightLoop, 'right room produces a loop via the transit middle room');
// Confirm the transit middle room appears in the routing
const transits = transitRoomsToReach(state, right);
assert(transits.includes(middle.id),
  `transitRoomsToReach lists the middle room (got [${transits.join(', ')}])`);

if (failures === 0) {
  console.log(`\nAll door tests passed (${failures} failures).`);
  process.exit(0);
} else {
  console.log(`\n${failures} failure(s).`);
  process.exit(1);
}
