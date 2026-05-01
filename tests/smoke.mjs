// Headless smoke test for the engine layers (geometry, patterns, loops, calc).
// Avoids any DOM-dependent module.

import { state, loadSample } from '../src/state.js';
import { generateRoomPath } from '../src/patterns.js';
import { generateLoops } from '../src/loops.js';
import { summarise } from '../src/calc.js';
import { polylineLength, pointsToSmoothPath } from '../src/geometry.js';

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
assert(loops.length >= 5, `at least one loop per room (got ${loops.length})`);
for (const l of loops) {
  assert(l.totalLength <= state.config.maxLoopLength, `${l.label} respects max loop length`);
  assert(l.path.length >= 2, `${l.label} has polyline points`);
  assert(typeof l.colour === 'number' && l.colour >= 0 && l.colour <= 3, `${l.label} colour in [0,3]`);
}

console.log('# Adjacent loops do not share a colour (when possible)');
let conflicts = 0;
for (let i = 0; i < loops.length; i++) {
  for (let j = i + 1; j < loops.length; j++) {
    const a = loops[i].bbox, b = loops[j].bbox;
    const overlap = !(a.x + a.w + 400 < b.x || b.x + b.w + 400 < a.x ||
                      a.y + a.h + 400 < b.y || b.y + b.h + 400 < a.y);
    if (overlap && loops[i].colour === loops[j].colour) conflicts++;
  }
}
assert(conflicts === 0, `4-colour graph has no conflicts (found ${conflicts})`);

console.log('# Calculations');
state.loops = loops;
state.warnings = warnings;
const s = summarise(state);
assert(s.loopCount === loops.length, 'summary loop count matches');
assert(s.totalArea > 0, 'summary total area > 0');
assert(s.totalPipe > 0, 'summary total pipe > 0');
assert(s.orderQty > s.totalPipe, 'order qty includes wastage');

console.log('# Loop-length cap stress test');
// Force a very long path via a single big room and tight spacing.
state.rooms = [{
  id: 'big', name: 'BIG', x: 0, y: 0, w: 8000, h: 6000,
  walls: { n: 'external', e: 'external', s: 'external', w: 'external' },
  noGoZones: [], pattern: 'serpentine', finish: 'tile',
}];
state.manifold = { x: 4000, y: 0 };
state.config.pipeSpacing = 100;
state.config.edgeSpacing = 100;
const stressed = generateLoops(state);
const tooLong = stressed.loops.find(l => l.totalLength > state.config.maxLoopLength);
assert(!tooLong, `big room is split so no loop exceeds the cap (loops=${stressed.loops.length})`);
assert(stressed.loops.length >= 2, 'big room produces multiple loops via splitting');

if (failures === 0) {
  console.log(`\nAll smoke tests passed (${failures} failures).`);
  process.exit(0);
} else {
  console.log(`\n${failures} failure(s).`);
  process.exit(1);
}
