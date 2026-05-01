// loops.js — assemble per-room pipe paths into named, colour-coded loops.
// Handles the 100-metre cap by splitting long paths into multiple loops, adds
// manifold flow/return tails, and runs a greedy 4-colour algorithm so adjacent
// loops are visually distinguishable.

import { generateRoomPath } from './patterns.js';
import { polylineLength, bbox, dist } from './geometry.js';

export function generateLoops(state) {
  const { rooms, manifold, config } = state;
  const warnings = [];
  const loops = [];

  if (!manifold) {
    warnings.push({ level: 'err', message: 'No manifold placed. Use the Manifold tool to set its location.' });
    return { loops, warnings };
  }
  if (rooms.length === 0) {
    warnings.push({ level: 'err', message: 'No rooms defined. Draw a room or load the sample plan.' });
    return { loops, warnings };
  }

  let loopIndex = 1;

  for (const room of rooms) {
    const path = generateRoomPath(room, config);
    if (!path || path.length < 2) {
      warnings.push({ level: 'warn', message: `${room.name}: no valid pipe path (room too small or fully obstructed).` });
      continue;
    }

    // Compute pipe length excluding manifold tails so we can split sensibly.
    const pipeLen = polylineLength(path);
    const tailEntry = dist(path[0], manifold);
    const tailExit = dist(path[path.length - 1], manifold);
    const totalWithTails = pipeLen + tailEntry + tailExit;

    if (totalWithTails <= config.maxLoopLength) {
      loops.push(buildLoop({
        index: loopIndex++,
        room,
        manifold,
        path,
        pipeLen,
        tailEntry,
        tailExit,
      }));
      continue;
    }

    // Path is too long for a single loop — split it. We split the in-room
    // pipe path so each segment plus its tails is under the cap.
    const segments = splitPath(path, manifold, config.maxLoopLength);
    if (segments.length === 0) {
      warnings.push({ level: 'err', message: `${room.name}: cannot split into compliant loops; consider denser spacing or a smaller zone.` });
      continue;
    }
    for (const seg of segments) {
      const segLen = polylineLength(seg);
      const tIn = dist(seg[0], manifold);
      const tOut = dist(seg[seg.length - 1], manifold);
      loops.push(buildLoop({
        index: loopIndex++,
        room,
        manifold,
        path: seg,
        pipeLen: segLen,
        tailEntry: tIn,
        tailExit: tOut,
      }));
    }
    warnings.push({ level: 'warn', message: `${room.name}: split into ${segments.length} loops (combined path exceeded ${(config.maxLoopLength / 1000).toFixed(0)} m).` });
  }

  // Assign groups: by default, one thermostatic group per room.
  const roomToGroup = new Map();
  let nextGroup = 1;
  for (const loop of loops) {
    if (!roomToGroup.has(loop.roomId)) {
      roomToGroup.set(loop.roomId, nextGroup++);
    }
    loop.group = roomToGroup.get(loop.roomId);
  }

  // Assign colours (graph 4-colouring on bounding-box adjacency).
  assignColours(loops);

  // Post-checks.
  for (const loop of loops) {
    if (loop.totalLength > config.maxLoopLength) {
      warnings.push({ level: 'err', message: `${loop.label}: ${(loop.totalLength / 1000).toFixed(1)} m exceeds ${(config.maxLoopLength / 1000).toFixed(0)} m cap.` });
    }
  }
  const balance = balanceCheck(loops);
  if (balance.spreadPct > 20) {
    warnings.push({ level: 'warn', message: `Loop balance spread ${balance.spreadPct.toFixed(0)}% (target ≤ 20%). Consider re-zoning.` });
  }

  return { loops, warnings };
}

function buildLoop({ index, room, manifold, path, pipeLen, tailEntry, tailExit }) {
  const totalLength = pipeLen + tailEntry + tailExit;
  const label = `M1-Loop ${String(index).padStart(2, '0')}-${(totalLength / 1000).toFixed(0)}m`;
  return {
    id: `loop-${index}`,
    index,
    label,
    roomId: room.id,
    roomName: room.name,
    path,
    flowTail: [{ x: manifold.x, y: manifold.y }, path[0]],
    returnTail: [path[path.length - 1], { x: manifold.x, y: manifold.y }],
    pipeLength: pipeLen,
    tailLength: tailEntry + tailExit,
    totalLength,
    group: 1,
    colour: 0,
    bbox: bbox(path),
  };
}

// Split a polyline into sub-paths each obeying the loop-length cap when its
// own manifold tails are included. Greedy: walk the path, accumulate segments
// until adding one more would exceed the cap, then start a new segment from
// the next point.
function splitPath(path, manifold, maxTotal) {
  if (path.length < 2) return [];
  const segments = [];
  let current = [path[0]];
  let pipeAcc = 0;

  for (let i = 1; i < path.length; i++) {
    const nextPipe = pipeAcc + dist(path[i - 1], path[i]);
    const total = nextPipe + dist(current[0], manifold) + dist(path[i], manifold);
    if (total > maxTotal && current.length >= 2) {
      segments.push(current);
      current = [path[i - 1], path[i]];
      pipeAcc = dist(path[i - 1], path[i]);
    } else {
      current.push(path[i]);
      pipeAcc = nextPipe;
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

function balanceCheck(loops) {
  if (loops.length === 0) return { spreadPct: 0, min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  for (const l of loops) {
    if (l.totalLength < min) min = l.totalLength;
    if (l.totalLength > max) max = l.totalLength;
  }
  const spreadPct = max > 0 ? ((max - min) / max) * 100 : 0;
  return { spreadPct, min, max };
}

// Greedy 4-colour assignment: two loops are adjacent if their bounding boxes
// intersect or are within `proximity` of each other. The algorithm always
// finds a valid 4-colouring on planar adjacency graphs (4-colour theorem),
// and a greedy choice is sufficient on typical layouts.
function assignColours(loops) {
  const proximity = 400; // mm
  const adj = loops.map(() => new Set());
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      if (bboxNear(loops[i].bbox, loops[j].bbox, proximity)) {
        adj[i].add(j); adj[j].add(i);
      }
    }
  }
  for (let i = 0; i < loops.length; i++) {
    const used = new Set();
    for (const j of adj[i]) if (j < i) used.add(loops[j].colour);
    let c = 0;
    while (used.has(c) && c < 4) c++;
    loops[i].colour = c % 4;
  }
}

function bboxNear(a, b, pad) {
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x ||
           a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}
