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

// Bounding box of a room (polygon-based; falls back to legacy rect fields).
export function roomBBox(room) {
  if (room.vertices) return bbox(room.vertices);
  return { x: room.x, y: room.y, w: room.w, h: room.h, cx: room.x + room.w / 2, cy: room.y + room.h / 2 };
}

// Signed area of a polygon (shoelace). Positive when vertices wind clockwise
// in screen coordinates (y down). Returned as absolute value in mm².
export function polygonArea(vertices) {
  let s = 0;
  for (let i = 0, n = vertices.length; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

// Length of a single polygon edge i (from vertex i to (i+1)%N).
export function edgeLength(vertices, i) {
  const a = vertices[i], b = vertices[(i + 1) % vertices.length];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Edge endpoints {a, b} and a midpoint, for a polygon.
export function edgeEndpoints(vertices, i) {
  const a = vertices[i], b = vertices[(i + 1) % vertices.length];
  return { a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

// Outward normal (unit vector) of edge i. Assumes clockwise winding so the
// polygon interior lies to the right of each edge in screen coords (y down).
export function edgeOutwardNormal(vertices, i) {
  const a = vertices[i], b = vertices[(i + 1) % vertices.length];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Right-hand perpendicular (interior on left for CCW; here we have CW so
  // outward is the LEFT-hand perpendicular).
  return { x: -dy / len, y: dx / len };
}

// Even-odd point-in-polygon test (ray cast to the right).
export function pointInPolygon(p, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const vi = vertices[i], vj = vertices[j];
    const intersect = ((vi.y > p.y) !== (vj.y > p.y)) &&
      (p.x < (vj.x - vi.x) * (p.y - vi.y) / ((vj.y - vi.y) || eps) + vi.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Intersect a horizontal line y = Y0 with an axis-aligned polygon, returning
// a list of [xStart, xEnd] interior intervals. Uses the scanline method:
// collect every vertical edge that straddles Y0, sort the resulting xs, and
// pair them up. Tangent touches (horizontal edges or vertices exactly on Y0)
// are filtered to avoid spurious empty intervals.
export function clipHorizontalLine(y, vertices) {
  const xs = [];
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    // Only count vertical edges that actually cross the line.
    if (Math.abs(a.x - b.x) < eps) {
      const yMin = Math.min(a.y, b.y), yMax = Math.max(a.y, b.y);
      if (y > yMin + eps && y < yMax - eps) xs.push(a.x);
    }
  }
  xs.sort((m, n) => m - n);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > 1) out.push([xs[i], xs[i + 1]]);
  }
  return out;
}

// Intersect a vertical line x = X0 with an axis-aligned polygon, returning
// a list of [yStart, yEnd] interior intervals.
export function clipVerticalLine(x, vertices) {
  const ys = [];
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    if (Math.abs(a.y - b.y) < eps) {
      const xMin = Math.min(a.x, b.x), xMax = Math.max(a.x, b.x);
      if (x > xMin + eps && x < xMax - eps) ys.push(a.y);
    }
  }
  ys.sort((m, n) => m - n);
  const out = [];
  for (let i = 0; i + 1 < ys.length; i += 2) {
    if (ys[i + 1] - ys[i] > 1) out.push([ys[i], ys[i + 1]]);
  }
  return out;
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

// Inset a room rectangle by per-side amounts. Sub-zone partition edges use
// zero so pipe coverage runs continuously across them.
export function insetRectPerSide(rect, insets) {
  const n = insets.n || 0, e = insets.e || 0, s = insets.s || 0, w = insets.w || 0;
  return {
    x: rect.x + w,
    y: rect.y + n,
    w: Math.max(0, rect.w - w - e),
    h: Math.max(0, rect.h - n - s),
  };
}

// Identify the longest external (or, failing that, longest overall) edge of a
// polygon room. Returns the edge index, its endpoints, length, and an axis
// flag: 'h' (horizontal edge → rows run east-west) or 'v' (vertical edge →
// rows run north-south). The first pipe row will hug this edge.
export function longestExternalWall(room) {
  const vs = room.vertices;
  if (!vs || vs.length < 3) return null;
  const kinds = room.edgeKinds || [];
  let best = null, bestLen = -1;
  let fbBest = null, fbLen = -1;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i], b = vs[(i + 1) % vs.length];
    const len = dist(a, b);
    const axis = Math.abs(a.x - b.x) < eps ? 'v' : 'h';
    const entry = { edgeIndex: i, wall: { a, b }, len, axis };
    if (kinds[i] === 'external' && len > bestLen) { bestLen = len; best = entry; }
    if (len > fbLen) { fbLen = len; fbBest = entry; }
  }
  return best || fbBest;
}

// Distance from a point to the nearest external edge of a polygon room.
export function distToNearestExternalWall(p, room) {
  if (!room.vertices) return Infinity;
  let best = Infinity;
  const kinds = room.edgeKinds || [];
  for (let i = 0; i < room.vertices.length; i++) {
    if (kinds[i] !== 'external') continue;
    const a = room.vertices[i], b = room.vertices[(i + 1) % room.vertices.length];
    const d = pointToSegment(p, a, b);
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
