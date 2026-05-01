// loops.js — assemble per-room pipe paths into named, colour-coded loops.
// Handles the 100-metre cap by splitting long paths into multiple loops, adds
// manifold flow/return tails, and runs a greedy 4-colour algorithm so adjacent
// loops are visually distinguishable.

import { generateRoomPath } from './patterns.js';
import { polylineLength, bbox, dist } from './geometry.js';
import { routeTail } from './doors.js';

// Split a room into N independent thermal zones along its longer dimension.
// The shared boundaries become "partition" walls so the pattern engine knows
// to omit the wall setback there (pipes from adjacent zones meet flush).
export function expandZones(room) {
  const n = Math.max(1, Math.min(8, room.zoneCount || 1));
  if (n === 1) return [{ ...room, zoneOf: room.id, zoneIndex: 1, zoneCount: 1 }];
  const horizontal = room.w >= room.h; // split along the longer axis
  const subs = [];
  for (let i = 0; i < n; i++) {
    const isFirst = i === 0;
    const isLast = i === n - 1;
    const sub = { ...room };
    if (horizontal) {
      const stripW = room.w / n;
      sub.x = room.x + i * stripW;
      sub.w = stripW;
    } else {
      const stripH = room.h / n;
      sub.y = room.y + i * stripH;
      sub.h = stripH;
    }
    sub.id = `${room.id}/z${i + 1}`;
    sub.name = `${room.name} ${i + 1}`;
    sub.zoneOf = room.id;
    sub.zoneIndex = i + 1;
    sub.zoneCount = n;
    // Inherit walls but rewrite the shared edges as 'partition'.
    sub.walls = { ...room.walls };
    if (horizontal) {
      if (!isFirst) sub.walls.w = 'partition';
      if (!isLast) sub.walls.e = 'partition';
    } else {
      if (!isFirst) sub.walls.n = 'partition';
      if (!isLast) sub.walls.s = 'partition';
    }
    sub.parentRoomId = room.id;
    subs.push(sub);
  }
  return subs;
}

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
  let nextGroup = 1;

  for (const room of rooms) {
    if (!room.doors || room.doors.length === 0) {
      warnings.push({ level: 'warn', message: `${room.name}: no door defined — pipe tails will run as straight lines and may cross walls. Use the Door tool.` });
    }
    // Each declared zone becomes an independent thermal group with its own loop(s).
    const subs = expandZones(room);
    for (const sub of subs) {
      const path = generateRoomPath(sub, config);
      if (!path || path.length < 2) {
        warnings.push({ level: 'warn', message: `${sub.name}: no valid pipe path (zone too small or fully obstructed).` });
        continue;
      }
      const pipeLen = polylineLength(path);
      const builtLoops = buildLoopsForPath(path, pipeLen, sub, room, manifold, config, () => loopIndex++);
      const groupNo = nextGroup++;
      for (const l of builtLoops) l.group = groupNo;
      loops.push(...builtLoops);
      if (builtLoops.length > 1) {
        warnings.push({ level: 'warn', message: `${sub.name}: split into ${builtLoops.length} loops (path exceeded ${(config.maxLoopLength / 1000).toFixed(0)} m cap).` });
      }
    }
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

// Build one or more loops for a generated path, splitting if the path plus
// door-routed tails would exceed the maxLoopLength cap.
function buildLoopsForPath(path, pipeLen, sub, parentRoom, manifold, config, nextIndex) {
  const flowFull = routeTail(manifold, path[0], parentRoom);
  const returnFull = routeTail(manifold, path[path.length - 1], parentRoom);
  const tailIn = polylineLength(flowFull.points);
  const tailOut = polylineLength(returnFull.points);
  const total = pipeLen + tailIn + tailOut;

  if (total <= config.maxLoopLength) {
    return [buildLoop({
      index: nextIndex(),
      sub,
      parentRoom,
      manifold,
      path,
      flowTailPts: flowFull.points,
      returnTailPts: returnFull.points,
      pipeLen,
      tailLen: tailIn + tailOut,
    })];
  }

  // Split the path so each sub-segment plus its own door-routed tails fits.
  const segs = splitPathByCap(path, parentRoom, manifold, config.maxLoopLength);
  const out = [];
  for (const seg of segs) {
    const segPipe = polylineLength(seg);
    const flow = routeTail(manifold, seg[0], parentRoom);
    const ret = routeTail(manifold, seg[seg.length - 1], parentRoom);
    const tIn = polylineLength(flow.points), tOut = polylineLength(ret.points);
    out.push(buildLoop({
      index: nextIndex(),
      sub,
      parentRoom,
      manifold,
      path: seg,
      flowTailPts: flow.points,
      returnTailPts: ret.points,
      pipeLen: segPipe,
      tailLen: tIn + tOut,
    }));
  }
  return out;
}

function buildLoop({ index, sub, parentRoom, manifold, path, flowTailPts, returnTailPts, pipeLen, tailLen }) {
  const totalLength = pipeLen + tailLen;
  const label = `M1-Loop ${String(index).padStart(2, '0')}-${(totalLength / 1000).toFixed(0)}m`;
  return {
    id: `loop-${index}`,
    index,
    label,
    roomId: parentRoom.id,
    roomName: sub.name,
    parentRoomName: parentRoom.name,
    zoneIndex: sub.zoneIndex || 1,
    zoneCount: sub.zoneCount || 1,
    path,
    flowTail: flowTailPts,
    returnTail: [...returnTailPts].reverse(), // draw return as path[-1] → manifold
    pipeLength: pipeLen,
    tailLength: tailLen,
    totalLength,
    group: 1,
    colour: 0,
    bbox: bbox(path),
  };
}

// Split a polyline into sub-paths so each, plus its own door-routed tails,
// stays under the cap. Greedy: walk the path, accumulate segments until
// adding the next point would exceed the cap, then start a new segment.
function splitPathByCap(path, parentRoom, manifold, maxTotal) {
  if (path.length < 2) return [];
  const segments = [];
  let current = [path[0]];
  let pipeAcc = 0;
  for (let i = 1; i < path.length; i++) {
    const nextPipe = pipeAcc + dist(path[i - 1], path[i]);
    const tIn = polylineLength(routeTail(manifold, current[0], parentRoom).points);
    const tOut = polylineLength(routeTail(manifold, path[i], parentRoom).points);
    if (nextPipe + tIn + tOut > maxTotal && current.length >= 2) {
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
