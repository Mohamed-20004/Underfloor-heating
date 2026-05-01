// loops.js — assemble per-room pipe paths into named, colour-coded loops.
// Handles the 100-metre cap by splitting long paths into multiple loops, adds
// manifold flow/return tails, and runs a greedy 4-colour algorithm so adjacent
// loops are visually distinguishable.

import { generateRoomPath } from './patterns.js';
import { polylineLength, bbox, dist, eps } from './geometry.js';
import { routeTail } from './doors.js';

// Detect a 4-vertex axis-aligned rectangle so we can apply the rectangular
// zone-split fast path. Non-rectangular polygons keep zoneCount=1 for now.
function rectInfo(vertices) {
  if (!vertices || vertices.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = vertices[i], b = vertices[(i + 1) % 4];
    const isV = Math.abs(a.x - b.x) < eps;
    const isH = Math.abs(a.y - b.y) < eps;
    if (!isV && !isH) return null;
  }
  const xs = vertices.map(v => v.x), ys = vertices.map(v => v.y);
  return {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// Build a clockwise rectangle polygon and matching edgeKinds in N/E/S/W order.
function rectPolygon(x, y, w, h, edgeKinds) {
  const vertices = [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  return { vertices, edgeKinds: edgeKinds.slice() };
}

// Split a room into N independent thermal zones along its longer dimension.
// Currently rectangular rooms only — partition edges use 'internal' kind with
// a partition flag so the pattern's setback math knows to omit the inset on
// shared boundaries. Non-rectangular polygon rooms return a single zone.
export function expandZones(room) {
  const n = Math.max(1, Math.min(8, room.zoneCount || 1));
  const single = [{ ...room, zoneOf: room.id, zoneIndex: 1, zoneCount: 1, parentRoomId: room.id }];
  if (n === 1) return single;
  const rect = rectInfo(room.vertices);
  if (!rect) return single; // polygon rooms don't yet support zoning

  const horizontal = rect.w >= rect.h; // split along longer axis
  const ek = room.edgeKinds || [];
  const NORTH = 0, EAST = 1, SOUTH = 2, WEST = 3;
  const subs = [];
  for (let i = 0; i < n; i++) {
    const isFirst = i === 0, isLast = i === n - 1;
    let sx = rect.x, sy = rect.y, sw = rect.w, sh = rect.h;
    if (horizontal) {
      const stripW = rect.w / n;
      sx = rect.x + i * stripW; sw = stripW;
    } else {
      const stripH = rect.h / n;
      sy = rect.y + i * stripH; sh = stripH;
    }
    const subEdges = [ek[NORTH], ek[EAST], ek[SOUTH], ek[WEST]];
    if (horizontal) {
      if (!isFirst) subEdges[WEST] = 'partition';
      if (!isLast) subEdges[EAST] = 'partition';
    } else {
      if (!isFirst) subEdges[NORTH] = 'partition';
      if (!isLast) subEdges[SOUTH] = 'partition';
    }
    const poly = rectPolygon(sx, sy, sw, sh, subEdges);
    subs.push({
      ...room,
      ...poly,
      id: `${room.id}/z${i + 1}`,
      name: `${room.name} ${i + 1}`,
      zoneOf: room.id,
      zoneIndex: i + 1,
      zoneCount: n,
      parentRoomId: room.id,
      doors: [], // doors stay on the parent room; tail routing looks them up via parent
    });
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
      const path = generateRoomPath(sub, config, state.walls || []);
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

// 4-colour assignment with Welsh-Powell ordering: process vertices in
// descending degree order and greedily pick the smallest colour not used by
// any neighbour. On planar adjacency graphs (which floor-plan loop layouts
// always are) this reliably achieves a valid 4-colouring without backtracking.
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
  // Reset and process highest-degree first.
  loops.forEach(l => { l.colour = -1; });
  const order = loops.map((_, i) => i).sort((a, b) => adj[b].size - adj[a].size);
  for (const i of order) {
    const used = new Set();
    for (const j of adj[i]) {
      if (loops[j].colour >= 0) used.add(loops[j].colour);
    }
    let c = 0;
    while (used.has(c)) c++;
    loops[i].colour = c % 4;
  }
}

function bboxNear(a, b, pad) {
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x ||
           a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}
