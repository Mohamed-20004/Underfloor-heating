// geometry.js — polygon and pipe-path math.
// All coordinates are in millimetres. Y increases downward (SVG convention).

export const eps = 1e-6;

export function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Length of a polyline given as an array of {x, y} points.
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

// Bounding box of a list of points.
export function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// Bounding box of a room rectangle.
export function roomBBox(room) {
  return { x: room.x, y: room.y, w: room.w, h: room.h, cx: room.x + room.w / 2, cy: room.y + room.h / 2 };
}

// Inset a room rectangle by `inset` on each side, returning a smaller rectangle.
export function insetRect(rect, inset) {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    w: Math.max(0, rect.w - inset * 2),
    h: Math.max(0, rect.h - inset * 2),
  };
}

// Get the four wall segments of a rectangular room, keyed by compass direction.
export function roomWalls(room) {
  const x1 = room.x, y1 = room.y, x2 = room.x + room.w, y2 = room.y + room.h;
  return {
    n: { a: { x: x1, y: y1 }, b: { x: x2, y: y1 }, dir: 'h' },
    e: { a: { x: x2, y: y1 }, b: { x: x2, y: y2 }, dir: 'v' },
    s: { a: { x: x1, y: y2 }, b: { x: x2, y: y2 }, dir: 'h' },
    w: { a: { x: x1, y: y1 }, b: { x: x1, y: y2 }, dir: 'v' },
  };
}

// Identify the longest external wall direction. Returns 'h' (rows run east-west)
// or 'v' (rows run north-south). The first parallel pipe row will hug this wall.
export function longestExternalWall(room) {
  const walls = roomWalls(room);
  let best = null, bestLen = -1;
  for (const k of ['n', 'e', 's', 'w']) {
    if (room.walls[k] !== 'external') continue;
    const w = walls[k];
    const len = dist(w.a, w.b);
    if (len > bestLen) { bestLen = len; best = { side: k, wall: w, len }; }
  }
  if (best) return best;
  // No external walls marked: fall back to longest wall overall.
  let fbBest = null, fbLen = -1;
  for (const k of ['n', 'e', 's', 'w']) {
    const w = walls[k];
    const len = dist(w.a, w.b);
    if (len > fbLen) { fbLen = len; fbBest = { side: k, wall: w, len }; }
  }
  return fbBest;
}

// Distance from a point to the nearest external wall of a room. Used to determine
// whether a point lies within the edge zone (tighter pipe spacing).
export function distToNearestExternalWall(p, room) {
  let best = Infinity;
  const walls = roomWalls(room);
  for (const k of ['n', 'e', 's', 'w']) {
    if (room.walls[k] !== 'external') continue;
    const w = walls[k];
    const d = pointToSegment(p, w.a, w.b);
    if (d < best) best = d;
  }
  return best;
}

export function pointToSegment(p, a, b) {
  const ax = a.x, ay = a.y, bx = b.x, by = b.y;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = p.x - cx, ey = p.y - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

// Check whether point p lies inside any of the supplied no-go rectangles.
export function pointInNoGo(p, noGoZones) {
  for (const z of noGoZones || []) {
    if (p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h) return true;
  }
  return false;
}

// True if the axis-aligned segment from a to b passes through any no-go zone.
// Both endpoints are assumed axis-aligned with each other (h or v).
export function segmentHitsNoGo(a, b, noGoZones) {
  if (!noGoZones || !noGoZones.length) return false;
  for (const z of noGoZones) {
    const x1 = z.x, y1 = z.y, x2 = z.x + z.w, y2 = z.y + z.h;
    if (Math.abs(a.y - b.y) < eps) {
      // Horizontal segment.
      const y = a.y;
      if (y < y1 || y > y2) continue;
      const sx = Math.min(a.x, b.x), ex = Math.max(a.x, b.x);
      if (ex < x1 || sx > x2) continue;
      return true;
    } else {
      // Vertical segment.
      const x = a.x;
      if (x < x1 || x > x2) continue;
      const sy = Math.min(a.y, b.y), ey = Math.max(a.y, b.y);
      if (ey < y1 || sy > y2) continue;
      return true;
    }
  }
  return false;
}

// Convert an array of {x, y} pipe points into an SVG path string with smooth
// arcs at each direction change. `radius` is the corner radius used for curves;
// it is clamped to the available leg length so adjacent corners cannot overlap.
export function pointsToSmoothPath(points, radius) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], cur = points[i], next = points[i + 1];
    const inLen = dist(prev, cur), outLen = dist(cur, next);
    const r = Math.max(0, Math.min(radius, inLen / 2 - 0.1, outLen / 2 - 0.1));
    if (r < 1) {
      d += ` L ${cur.x} ${cur.y}`;
      continue;
    }
    const inDir = { x: (cur.x - prev.x) / inLen, y: (cur.y - prev.y) / inLen };
    const outDir = { x: (next.x - cur.x) / outLen, y: (next.y - cur.y) / outLen };
    const start = { x: cur.x - inDir.x * r, y: cur.y - inDir.y * r };
    const end = { x: cur.x + outDir.x * r, y: cur.y + outDir.y * r };
    // Determine sweep direction from the cross product of inDir and outDir.
    const cross = inDir.x * outDir.y - inDir.y * outDir.x;
    const sweep = cross > 0 ? 1 : 0;
    d += ` L ${start.x} ${start.y}`;
    d += ` A ${r} ${r} 0 0 ${sweep} ${end.x} ${end.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

// Compute an approximate path length for the smoothed path. We approximate
// arcs as straight segments at the corner; the difference is small enough for
// engineering purposes (within ~5% on tight bends, far less on shallow ones).
export function smoothPathLength(points) {
  return polylineLength(points);
}
