// doors.js — door geometry and pipe-tail routing.
// A door belongs to a room and lives on one wall side at a fractional centre
// (0..1) and a width in millimetres. Walls render with a gap at each door,
// and pipe tails route through the door rather than crossing the wall.

import { dist } from './geometry.js';

// World coordinates of a door's centre, the inner-side anchor, and the outer
// anchor. The inner anchor sits just inside the room at half-width depth, so
// pipe tails enter the room cleanly without grazing the wall.
export function doorAnchors(room, door, insideOffset = 200) {
  const w = door.width;
  switch (door.side) {
    case 'n': {
      const cx = room.x + door.center * room.w;
      const y = room.y;
      return {
        side: 'n',
        outer: { x: cx, y: y - insideOffset },
        center: { x: cx, y },
        inner: { x: cx, y: y + insideOffset },
        a: { x: cx - w / 2, y },
        b: { x: cx + w / 2, y },
      };
    }
    case 's': {
      const cx = room.x + door.center * room.w;
      const y = room.y + room.h;
      return {
        side: 's',
        outer: { x: cx, y: y + insideOffset },
        center: { x: cx, y },
        inner: { x: cx, y: y - insideOffset },
        a: { x: cx - w / 2, y },
        b: { x: cx + w / 2, y },
      };
    }
    case 'w': {
      const cy = room.y + door.center * room.h;
      const x = room.x;
      return {
        side: 'w',
        outer: { x: x - insideOffset, y: cy },
        center: { x, y: cy },
        inner: { x: x + insideOffset, y: cy },
        a: { x, y: cy - w / 2 },
        b: { x, y: cy + w / 2 },
      };
    }
    case 'e':
    default: {
      const cy = room.y + door.center * room.h;
      const x = room.x + room.w;
      return {
        side: 'e',
        outer: { x: x + insideOffset, y: cy },
        center: { x, y: cy },
        inner: { x: x - insideOffset, y: cy },
        a: { x, y: cy - w / 2 },
        b: { x, y: cy + w / 2 },
      };
    }
  }
}

// Pick the door of `room` whose centre is closest to `target`. Returns null
// if the room has no doors.
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

// Build a polyline tail from `from` (typically the manifold) to `to` (a point
// inside the room), passing through the door's inner anchor.
export function routeTail(from, to, room) {
  const sel = nearestDoor(room, from);
  if (!sel) {
    // No door defined — fall back to a straight tail with a marker so the UI
    // can warn that this room is unrouted.
    return { points: [from, to], door: null };
  }
  const { outer, inner } = sel.anchors;
  return { points: [from, outer, inner, to], door: sel.door };
}
