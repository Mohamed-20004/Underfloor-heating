// patterns.js — pipe-path generators for serpentine, bifilar, and hybrid layouts.
// Rooms are axis-aligned polygons (vertices + per-edge kinds). Each generator
// returns a polyline as an array of {x, y} points in millimetres. The renderer
// later smooths corners into circular arcs.

import {
  longestExternalWall,
  bbox,
  clipHorizontalLine,
  clipVerticalLine,
  segmentHitsNoGo,
  edgeLength,
  pointInPolygon,
  eps,
} from './geometry.js';

export function generateRoomPath(room, config, walls = [], mergedWith = [], entryPoint = null) {
  const pattern = room.pattern || 'serpentine';
  // For wall filtering we need to consider the entire merged area's bbox.
  const bboxRooms = [room, ...mergedWith];
  const relevant = filterRelevantWallsForRooms(bboxRooms, walls || []);
  if (pattern === 'bifilar') return generateBifilar(room, config, relevant, mergedWith);
  if (pattern === 'hybrid') return generateHybrid(room, config, relevant, mergedWith, entryPoint);
  return generateSerpentine(room, config, relevant, mergedWith, entryPoint);
}

function filterRelevantWallsForRooms(rooms, walls) {
  if (!walls.length || !rooms.length) return [];
  const allVerts = rooms.flatMap(r => r.vertices || []);
  const b = bbox(allVerts);
  const margin = 100;
  return walls.filter(w => {
    const wxMin = Math.min(w.a.x, w.b.x), wxMax = Math.max(w.a.x, w.b.x);
    const wyMin = Math.min(w.a.y, w.b.y), wyMax = Math.max(w.a.y, w.b.y);
    return !(wxMax + margin < b.x || wxMin - margin > b.x + b.w ||
             wyMax + margin < b.y || wyMin - margin > b.y + b.h);
  });
}

function filterRelevantWalls(room, walls) {
  if (!walls.length) return [];
  const b = bbox(room.vertices || []);
  const margin = 100; // millimetres of slop
  return walls.filter(w => {
    const wxMin = Math.min(w.a.x, w.b.x), wxMax = Math.max(w.a.x, w.b.x);
    const wyMin = Math.min(w.a.y, w.b.y), wyMax = Math.max(w.a.y, w.b.y);
    return !(wxMax + margin < b.x || wxMin - margin > b.x + b.w ||
             wyMax + margin < b.y || wyMin - margin > b.y + b.h);
  });
}

// True if the polygon is an axis-aligned 4-vertex rectangle. Used to opt the
// bifilar pattern (concentric spirals) in to its fast path and to apply
// per-side wall setbacks for sub-zone partitions.
function isAxisAlignedRect(vertices) {
  if (!vertices || vertices.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = vertices[i], b = vertices[(i + 1) % 4];
    const isVertical = Math.abs(a.x - b.x) < eps;
    const isHorizontal = Math.abs(a.y - b.y) < eps;
    if (!isVertical && !isHorizontal) return false;
  }
  return true;
}

// Per-side setbacks (N/E/S/W) for a rectangular room. Partition edges (used
// at sub-zone boundaries) get zero setback so adjacent zones meet flush.
// Non-rectangular polygons get a uniform setback on every side.
function setbacksForRoom(room, wallSetback) {
  const def = { n: wallSetback, e: wallSetback, s: wallSetback, w: wallSetback };
  if (!isAxisAlignedRect(room.vertices)) return def;
  const ek = room.edgeKinds || [];
  // Partition edges (sub-zone boundaries) and hidden edges ("knock-through"
  // openings) both use zero setback so pipes meet the boundary cleanly.
  const noInset = k => k === 'partition' || k === 'hidden';
  return {
    n: noInset(ek[0]) ? 0 : wallSetback,
    e: noInset(ek[1]) ? 0 : wallSetback,
    s: noInset(ek[2]) ? 0 : wallSetback,
    w: noInset(ek[3]) ? 0 : wallSetback,
  };
}

// -----------------------------------------------------------------------------
// Serpentine (meander) — works on any axis-aligned polygon.
// -----------------------------------------------------------------------------

function generateSerpentine(room, config, walls = [], mergedWith = [], entryPoint = null) {
  const { wallSetback, edgeSpacing, pipeSpacing, edgeZoneWidth } = config;
  const ext = longestExternalWall(room);
  if (!ext) return [];
  // For merged groups, work over the union of all rooms' bounding boxes and
  // use a uniform setback at every row endpoint (per-side rectangle setbacks
  // only make sense for a single rectangular room).
  const isMerged = mergedWith.length > 0;
  const allRooms = [room, ...mergedWith];
  const b = isMerged ? bbox(allRooms.flatMap(r => r.vertices)) : bbox(room.vertices);
  const sb = isMerged
    ? { n: wallSetback, e: wallSetback, s: wallSetback, w: wallSetback }
    : setbacksForRoom(room, wallSetback);
  if (b.w <= sb.w + sb.e || b.h <= sb.n + sb.s) return [];

  // Determine row direction from the primary room's spine edge.
  const horizontalSpine = ext.axis === 'h';
  // Stack range (perpendicular to rows) uses N/S setbacks for horizontal
  // spine, W/E for vertical spine.
  const stackMin = horizontalSpine ? b.y + sb.n : b.x + sb.w;
  const stackMax = horizontalSpine ? b.y + b.h - sb.s : b.x + b.w - sb.e;
  if (stackMax <= stackMin) return [];

  const lateralStartInset = horizontalSpine ? sb.w : sb.n;
  const lateralEndInset = horizontalSpine ? sb.e : sb.s;

  // Decide whether to start from the spine side. The first row hugs the spine
  // by default; if an entry point is given (the doorway the manifold's path
  // enters through), start from whichever stack side is closer to the entry
  // so the pipe begins snaking from the wall nearest the doorway.
  const spineMidPos = horizontalSpine
    ? (ext.wall.a.y + ext.wall.b.y) / 2
    : (ext.wall.a.x + ext.wall.b.x) / 2;
  const spineAtMin = Math.abs(spineMidPos - (horizontalSpine ? b.y : b.x)) < Math.abs(spineMidPos - (horizontalSpine ? b.y + b.h : b.x + b.w));
  let startAtMin = spineAtMin;
  if (entryPoint) {
    const entryStackPos = horizontalSpine ? entryPoint.y : entryPoint.x;
    const stackCentre = (stackMin + stackMax) / 2;
    startAtMin = entryStackPos < stackCentre;
  }

  // Build the list of row stack positions, tightening spacing in the edge zone.
  const positions = [];
  let off = edgeSpacing / 2;
  const stackLen = stackMax - stackMin;
  while (off < stackLen) {
    const pos = startAtMin ? stackMin + off : stackMax - off;
    positions.push(pos);
    const inEdgeZone = Math.min(off, stackLen - off) < edgeZoneWidth;
    off += inEdgeZone ? edgeSpacing : pipeSpacing;
  }
  if (positions.length === 0) return [];

  // Initial row direction: row 0 normally starts at its low-coord end (best.a).
  // If the entry doorway sits on the high-coord lateral side, flip the
  // initial direction so the first point of the pattern is on the entry side.
  let direction = 1;
  if (entryPoint) {
    const entryLatPos = horizontalSpine ? entryPoint.x : entryPoint.y;
    const latCentre = horizontalSpine ? b.cx : b.cy;
    direction = entryLatPos < latCentre ? 1 : -1;
  }
  const points = [];
  for (let r = 0; r < positions.length; r++) {
    const pos = positions[r];
    // For merged groups, clip the row against every room's polygon and merge
    // adjacent or overlapping intervals so the row spans both rooms when
    // they share a hidden boundary.
    let intervals = [];
    for (const rm of allRooms) {
      const ri = horizontalSpine
        ? clipHorizontalLine(pos, rm.vertices)
        : clipVerticalLine(pos, rm.vertices);
      intervals.push(...ri);
    }
    if (intervals.length > 1) intervals = mergeAdjacentIntervals(intervals);
    if (!intervals.length) continue;

    // Inset each interval by per-side setbacks at the row endpoints.
    const inset = intervals
      .map(([lo, hi]) => [lo + lateralStartInset, hi - lateralEndInset])
      .filter(([lo, hi]) => hi - lo > 1);
    if (!inset.length) continue;

    // Subtract no-go zones (from any room in the merged group), then any
    // walls (free walls act as obstacles — pipes route around them, with
    // door openings letting pipes through). Pick the longest surviving
    // sub-segment.
    const allNoGo = allRooms.flatMap(rm => rm.noGoZones || []);
    const candidates = [];
    for (const [lo, hi] of inset) {
      const a = horizontalSpine ? { x: lo, y: pos } : { x: pos, y: lo };
      const c = horizontalSpine ? { x: hi, y: pos } : { x: pos, y: hi };
      const noGoSubs = subtractNoGo(a, c, horizontalSpine, allNoGo);
      for (const seg of noGoSubs) {
        const wallSubs = subtractWalls(seg.a, seg.b, horizontalSpine, walls, wallSetback);
        candidates.push(...wallSubs);
      }
    }
    if (!candidates.length) continue;
    let best = candidates[0], bestLen = segLen(best);
    for (const s of candidates) {
      const l = segLen(s);
      if (l > bestLen) { best = s; bestLen = l; }
    }

    const [start, end] = direction > 0 ? [best.a, best.b] : [best.b, best.a];
    if (points.length === 0) {
      points.push(start, end);
    } else {
      const prev = points[points.length - 1];
      const jog = horizontalSpine ? { x: prev.x, y: pos } : { x: pos, y: prev.y };
      points.push(jog, end);
    }
    direction *= -1;
  }
  return points;
}

function segLen(s) {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Merge adjacent / overlapping [lo, hi] intervals. Used when clipping a row
// across multiple rooms in a merged group: two rooms sharing a hidden edge
// produce abutting intervals that should be treated as one continuous span.
function mergeAdjacentIntervals(intervals) {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1] + 1) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      out.push(sorted[i].slice());
    }
  }
  return out;
}

// Subtract no-go rectangles from a single axis-aligned segment, returning a
// list of remaining sub-segments {a, b}.
function subtractNoGo(a, b, horizontal, noGo) {
  if (!noGo || noGo.length === 0) return [{ a, b }];
  const intervals = [{ t0: 0, t1: 1 }];
  const start = horizontal ? a.x : a.y;
  const end = horizontal ? b.x : b.y;
  const span = end - start;
  if (Math.abs(span) < 1) return [{ a, b }];

  for (const z of noGo) {
    const fixed = horizontal ? a.y : a.x;
    const zMinFixed = horizontal ? z.y : z.x;
    const zMaxFixed = zMinFixed + (horizontal ? z.h : z.w);
    if (fixed < zMinFixed || fixed > zMaxFixed) continue;
    const zMinAxis = horizontal ? z.x : z.y;
    const zMaxAxis = zMinAxis + (horizontal ? z.w : z.h);
    let t0 = (zMinAxis - start) / span;
    let t1 = (zMaxAxis - start) / span;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t1 < 0 || t0 > 1) continue;
    t0 = Math.max(0, t0);
    t1 = Math.min(1, t1);
    const next = [];
    for (const iv of intervals) {
      if (t1 <= iv.t0 || t0 >= iv.t1) { next.push(iv); continue; }
      if (t0 > iv.t0) next.push({ t0: iv.t0, t1: t0 });
      if (t1 < iv.t1) next.push({ t0: t1, t1: iv.t1 });
    }
    intervals.splice(0, intervals.length, ...next);
    if (intervals.length === 0) break;
  }

  return intervals
    .filter(iv => iv.t1 - iv.t0 > 0.01)
    .map(iv => ({
      a: { x: a.x + (b.x - a.x) * iv.t0, y: a.y + (b.y - a.y) * iv.t0 },
      b: { x: a.x + (b.x - a.x) * iv.t1, y: a.y + (b.y - a.y) * iv.t1 },
    }));
}

// Subtract axis-aligned walls from a row segment. Each wall blocks rows that
// cross it perpendicularly, leaving a clearance equal to wallSetback on each
// side so the pipe stays off the wall. Doors on the wall create gaps that
// pipes pass through (the door's width range is treated as not blocking).
function subtractWalls(a, b, isHorizontalRow, walls, clearance) {
  if (!walls || walls.length === 0) return [{ a, b }];
  const intervals = [{ t0: 0, t1: 1 }];
  const startV = isHorizontalRow ? a.x : a.y;
  const endV = isHorizontalRow ? b.x : b.y;
  const span = endV - startV;
  if (Math.abs(span) < 1) return [{ a, b }];
  const fixedV = isHorizontalRow ? a.y : a.x;

  for (const w of walls) {
    const wDx = w.b.x - w.a.x, wDy = w.b.y - w.a.y;
    const isWallH = Math.abs(wDy) < eps;
    const isWallV = Math.abs(wDx) < eps;
    // A horizontal row only crosses a vertical wall, and vice versa. A wall
    // parallel to the row never blocks it.
    if (isHorizontalRow && !isWallV) continue;
    if (!isHorizontalRow && !isWallH) continue;

    // Wall position along the row's axis, and its extent perpendicular to it.
    const wallPos = isHorizontalRow ? w.a.x : w.a.y;
    const wallMin = isHorizontalRow ? Math.min(w.a.y, w.b.y) : Math.min(w.a.x, w.b.x);
    const wallMax = isHorizontalRow ? Math.max(w.a.y, w.b.y) : Math.max(w.a.x, w.b.x);
    if (fixedV < wallMin - clearance || fixedV > wallMax + clearance) continue;

    // If a door on this wall covers the row's perpendicular position, the
    // wall doesn't block the row at this point — pipe passes through the door.
    const wallLen = Math.hypot(wDx, wDy) || 1;
    const tAtRow = isHorizontalRow
      ? (fixedV - w.a.y) / (wDy || 1)
      : (fixedV - w.a.x) / (wDx || 1);
    let throughDoor = false;
    for (const door of w.doors || []) {
      const halfFrac = (door.width / 2) / wallLen;
      if (tAtRow >= door.center - halfFrac && tAtRow <= door.center + halfFrac) {
        throughDoor = true; break;
      }
    }
    if (throughDoor) continue;

    // Block the parametric interval [wallPos - clearance, wallPos + clearance]
    // along the row.
    const tBlock0 = (wallPos - clearance - startV) / span;
    const tBlock1 = (wallPos + clearance - startV) / span;
    let t0 = Math.min(tBlock0, tBlock1);
    let t1 = Math.max(tBlock0, tBlock1);
    if (t1 < 0 || t0 > 1) continue;
    t0 = Math.max(0, t0);
    t1 = Math.min(1, t1);
    const next = [];
    for (const iv of intervals) {
      if (t1 <= iv.t0 || t0 >= iv.t1) { next.push(iv); continue; }
      if (t0 > iv.t0) next.push({ t0: iv.t0, t1: t0 });
      if (t1 < iv.t1) next.push({ t0: t1, t1: iv.t1 });
    }
    intervals.splice(0, intervals.length, ...next);
    if (intervals.length === 0) break;
  }

  return intervals
    .filter(iv => iv.t1 - iv.t0 > 0.01)
    .map(iv => ({
      a: { x: a.x + (b.x - a.x) * iv.t0, y: a.y + (b.y - a.y) * iv.t0 },
      b: { x: a.x + (b.x - a.x) * iv.t1, y: a.y + (b.y - a.y) * iv.t1 },
    }));
}

// -----------------------------------------------------------------------------
// Bifilar (counterflow spiral) — fast path for axis-aligned rectangles only.
// Non-rectangular polygons fall back to serpentine.
// -----------------------------------------------------------------------------

function generateBifilar(room, config, walls = [], mergedWith = []) {
  if (mergedWith.length > 0) return generateSerpentine(room, config, walls, mergedWith);
  if (!isAxisAlignedRect(room.vertices)) return generateSerpentine(room, config, walls, mergedWith);
  // If any free wall pierces the room's bbox, fall back to serpentine —
  // concentric spirals can't route around a wall, but serpentine can.
  if (walls.length > 0) return generateSerpentine(room, config, walls, mergedWith);
  const { wallSetback, edgeSpacing, pipeSpacing } = config;
  const b = bbox(room.vertices);
  const sb = setbacksForRoom(room, wallSetback);
  const inner = {
    x: b.x + sb.w,
    y: b.y + sb.n,
    w: b.w - sb.w - sb.e,
    h: b.h - sb.n - sb.s,
  };
  if (inner.w <= 4 * pipeSpacing || inner.h <= 4 * pipeSpacing) {
    return generateSerpentine(room, config);
  }
  const startOffset = edgeSpacing / 2;
  const inward = rectSpiral(inner, startOffset, 2 * pipeSpacing);
  const outward = rectSpiral(inner, startOffset + pipeSpacing, 2 * pipeSpacing).reverse();
  return [...inward, ...outward];
}

function rectSpiral(rect, startOffset, step) {
  const pts = [];
  let left = rect.x + startOffset;
  let right = rect.x + rect.w - startOffset;
  let top = rect.y + startOffset;
  let bottom = rect.y + rect.h - startOffset;
  if (right - left <= 0 || bottom - top <= 0) return pts;

  pts.push({ x: left, y: top });
  let safety = 0;
  while (right - left > step && bottom - top > step && safety++ < 200) {
    pts.push({ x: right, y: top });
    pts.push({ x: right, y: bottom });
    pts.push({ x: left, y: bottom });
    top += step;
    pts.push({ x: left, y: top });
    left += step;
    pts.push({ x: left, y: top });
    right -= step;
    bottom -= step;
  }
  if (right - left > 1) pts.push({ x: right, y: top });
  if (bottom - top > 1) pts.push({ x: right, y: bottom });
  return pts;
}

// -----------------------------------------------------------------------------
// Hybrid (routed) — serpentine with no-go avoidance (already built in).
// -----------------------------------------------------------------------------

function generateHybrid(room, config, walls = [], mergedWith = [], entryPoint = null) {
  return generateSerpentine(room, config, walls, mergedWith, entryPoint);
}
