// patterns.js — pipe-path generators for the three supported layouts.
// Each generator returns an array of {x, y} points in millimetres. The
// returned polyline is later smoothed at corners for rendering and length.

import { insetRect, longestExternalWall, segmentHitsNoGo } from './geometry.js';

// Public entry point. Picks the generator based on room.pattern.
export function generateRoomPath(room, config) {
  const pattern = room.pattern || 'serpentine';
  if (pattern === 'bifilar') return generateBifilar(room, config);
  if (pattern === 'hybrid') return generateHybrid(room, config);
  return generateSerpentine(room, config);
}

// -----------------------------------------------------------------------------
// Serpentine (meander)
// -----------------------------------------------------------------------------

function generateSerpentine(room, config) {
  const { wallSetback, edgeSpacing, pipeSpacing, edgeZoneWidth } = config;
  const ext = longestExternalWall(room);
  if (!ext) return [];

  const inner = insetRect({ x: room.x, y: room.y, w: room.w, h: room.h }, wallSetback);
  if (inner.w <= 0 || inner.h <= 0) return [];

  const horizontalSpine = ext.side === 'n' || ext.side === 's';
  const opposite = ext.side === 'n' ? 's' : ext.side === 's' ? 'n' : ext.side === 'e' ? 'w' : 'e';
  const oppExternal = room.walls[opposite] === 'external';

  // Lateral bounds (where each row starts and ends).
  const rowStart = horizontalSpine ? inner.x : inner.y;
  const rowEnd = horizontalSpine ? inner.x + inner.w : inner.y + inner.h;

  // Stacking bounds (perpendicular to row direction).
  const stackMin = horizontalSpine ? inner.y : inner.x;
  const stackMax = horizontalSpine ? inner.y + inner.h : inner.x + inner.w;
  const stackLen = stackMax - stackMin;
  if (stackLen <= 0) return [];

  // Distance offsets (from spine wall) at which to place each row.
  const offsets = [];
  let off = edgeSpacing / 2; // first row sits half edge-spacing from the inner boundary
  while (off < stackLen) {
    offsets.push(off);
    const distToSpine = off;
    const distToOpposite = stackLen - off;
    const distToNearestExt = Math.min(
      distToSpine,
      oppExternal ? distToOpposite : Infinity
    );
    const inEdgeZone = distToNearestExt < edgeZoneWidth;
    const step = inEdgeZone ? edgeSpacing : pipeSpacing;
    off += step;
  }
  if (offsets.length === 0) return [];

  // Determine the geometric position of each row in absolute coordinates.
  const spineAtMin = ext.side === 'n' || ext.side === 'w';
  const positions = offsets.map(o => spineAtMin ? stackMin + o : stackMax - o);

  // Build the polyline: rows alternate direction; each row segment may be
  // truncated or skipped to avoid no-go zones.
  const points = [];
  let direction = 1; // 1 = forward, -1 = reverse
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const row = buildRow(room, horizontalSpine, pos, rowStart, rowEnd, direction);
    if (!row) continue;
    if (points.length === 0) {
      points.push(row.start, row.end);
    } else {
      // Add the connecting point (jog to new row at the same x/y as previous end)
      // and then the new row's two endpoints. Smoothing creates the U-bend.
      const prev = points[points.length - 1];
      const jog = horizontalSpine
        ? { x: prev.x, y: pos }
        : { x: pos, y: prev.y };
      points.push(jog, row.end);
    }
    direction *= -1;
  }
  return points;
}

// Build a single row at the given perpendicular position, truncated to avoid
// no-go zones. Returns { start, end } in absolute coords, or null if no
// usable segment remains.
function buildRow(room, horizontalSpine, pos, lateralStart, lateralEnd, direction) {
  const noGo = room.noGoZones || [];
  const a = horizontalSpine ? { x: lateralStart, y: pos } : { x: pos, y: lateralStart };
  const b = horizontalSpine ? { x: lateralEnd, y: pos } : { x: pos, y: lateralEnd };

  // Find sub-segments of [a,b] that avoid no-go zones. We sample at fine
  // granularity since rooms are not large and no-go rectangles are axis-aligned.
  const segments = subtractNoGo(a, b, horizontalSpine, noGo);
  if (segments.length === 0) return null;

  // Use the longest available sub-segment — this approximates the spec rule
  // that we keep the row as long as possible while avoiding obstructions.
  let best = segments[0], bestLen = segLen(best);
  for (const s of segments) {
    const l = segLen(s);
    if (l > bestLen) { best = s; bestLen = l; }
  }
  if (direction < 0) {
    return { start: best.b, end: best.a };
  }
  return { start: best.a, end: best.b };
}

function segLen(s) {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Subtract no-go rectangles from a single axis-aligned segment, returning a
// list of remaining sub-segments.
function subtractNoGo(a, b, horizontal, noGo) {
  if (!noGo || noGo.length === 0) return [{ a, b }];
  // Project onto the parametric axis: t = 0 at a, t = 1 at b.
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
    // Subtract [t0, t1] from each interval.
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
    .filter(iv => iv.t1 - iv.t0 > 0.01) // discard slivers
    .map(iv => ({
      a: { x: a.x + (b.x - a.x) * iv.t0, y: a.y + (b.y - a.y) * iv.t0 },
      b: { x: a.x + (b.x - a.x) * iv.t1, y: a.y + (b.y - a.y) * iv.t1 },
    }));
}

// -----------------------------------------------------------------------------
// Bifilar (counterflow spiral)
// -----------------------------------------------------------------------------

function generateBifilar(room, config) {
  const { wallSetback, edgeSpacing, pipeSpacing } = config;
  const inner = insetRect({ x: room.x, y: room.y, w: room.w, h: room.h }, wallSetback);
  if (inner.w <= 4 * pipeSpacing || inner.h <= 4 * pipeSpacing) {
    // Room is too tight for a meaningful bifilar — fall back to serpentine.
    return generateSerpentine(room, config);
  }
  // Pair-spacing: inward and outward runs are interleaved at `pipeSpacing`,
  // so each spiral turn steps inward by 2 * pipeSpacing.
  const startOffset = edgeSpacing / 2;
  const inward = rectSpiral(inner, startOffset, 2 * pipeSpacing);
  const outward = rectSpiral(inner, startOffset + pipeSpacing, 2 * pipeSpacing).reverse();
  // Connect at the centre with a short jog; the smoother turns it into a tight U-bend.
  return [...inward, ...outward];
}

// Generate a clockwise rectangular spiral inward from the boundary defined by
// `startOffset` inside `rect`, stepping inward by `step` per turn. Returns a
// polyline that ends near the centre.
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
    pts.push({ x: right, y: top });          // top edge, left → right
    pts.push({ x: right, y: bottom });       // right edge, top → bottom
    pts.push({ x: left, y: bottom });        // bottom edge, right → left
    top += step;
    pts.push({ x: left, y: top });           // partial left edge, stops one step short
    left += step;
    pts.push({ x: left, y: top });           // step inward along the top
    right -= step;
    bottom -= step;
  }
  // Close to the centre with a short final stroke.
  if (right - left > 1) pts.push({ x: right, y: top });
  if (bottom - top > 1) pts.push({ x: right, y: bottom });
  return pts;
}

// -----------------------------------------------------------------------------
// Hybrid (routed)
// -----------------------------------------------------------------------------
// For the MVP the hybrid pattern is a serpentine that skips obstructed rows
// and tolerates skipped coverage. Real production code would do skeleton-based
// pathfinding around obstacles; the spec explicitly notes hybrid layouts may be
// less geometrically regular.

function generateHybrid(room, config) {
  return generateSerpentine(room, config);
}
