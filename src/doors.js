// doors.js — door geometry and pipe-tail routing for polygon rooms.
// A door belongs to a parent room, sits on edge `edgeIndex` of that room at
// fractional centre `center` (0..1) along the edge, with width in millimetres.

import { dist, edgeOutwardNormal, edgeEndpoints } from './geometry.js';

// Compute the door's posts (a, b along the wall), centre, an outer anchor
// just outside the room (where the manifold tail enters), and an inner anchor
// just inside the room (where the tail meets the pipe path).
export function doorAnchors(room, door, insideOffset = 200) {
  const { a, b } = edgeEndpoints(room.vertices, door.edgeIndex);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len; // unit tangent along edge
  const cx = a.x + ux * len * door.center;
  const cy = a.y + uy * len * door.center;
  const halfW = door.width / 2;
  const post1 = { x: cx - ux * halfW, y: cy - uy * halfW };
  const post2 = { x: cx + ux * halfW, y: cy + uy * halfW };
  const out = edgeOutwardNormal(room.vertices, door.edgeIndex); // points outside the room
  return {
    edgeIndex: door.edgeIndex,
    a: post1, b: post2,
    center: { x: cx, y: cy },
    outer: { x: cx + out.x * insideOffset, y: cy + out.y * insideOffset },
    inner: { x: cx - out.x * insideOffset, y: cy - out.y * insideOffset },
    tangent: { x: ux, y: uy },
    normal: out,
    width: door.width,
  };
}

// Pick the door of `room` whose centre is closest to `target`.
export function nearestDoor(room, target) {
  if (!room || !room.doors || room.doors.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const d of room.doors) {
    const a = doorAnchors(room, d);
    const dd = dist(a.center, target);
    if (dd < bestDist) { bestDist = dd; best = { door: d, anchors: a, dist: dd }; }
  }
  return best;
}

// Build a polyline tail from `from` (manifold) to `to` (a point inside the
// room), passing through the door's outer + inner anchors.
export function routeTail(from, to, room) {
  const sel = nearestDoor(room, from);
  if (!sel) return { points: [from, to], door: null };
  const { outer, inner } = sel.anchors;
  return { points: [from, outer, inner, to], door: sel.door };
}
