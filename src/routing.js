// routing.js — navigation graph for manifold-tail routing.
//
// Stage 2 of the loop generation rework. Instead of drawing tails as
// crow-flies straight lines from the manifold to each loop, we build a small
// graph whose nodes are the manifold, every room centroid, and every doorway,
// then run Dijkstra to find the shortest path from the manifold to each
// heated room. The path's door waypoints become the tail polyline so pipes
// pass *through* doorways rather than under walls.

import { dist, pointInPolygon, bbox } from './geometry.js';
import { doorAnchors as roomDoorAnchors } from './doors.js';

// Position of a free-wall door's centre, plus a point a small distance to
// each side of the wall. Used to detect which rooms (if any) are on each
// side of the door. Mirrors the right-hand-perpendicular swing convention
// used in the renderer.
function freeWallDoorAnchors(wall, door, sideOffset = 200) {
  const a = wall.a, b = wall.b;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux; // right-hand perpendicular
  const cx = a.x + ux * len * door.center;
  const cy = a.y + uy * len * door.center;
  return {
    center: { x: cx, y: cy },
    sideA:  { x: cx + nx * sideOffset, y: cy + ny * sideOffset },
    sideB:  { x: cx - nx * sideOffset, y: cy - ny * sideOffset },
  };
}

function roomContainingPoint(p, rooms) {
  for (const r of rooms) {
    if (pointInPolygon(p, r.vertices || [])) return r.id;
  }
  return null;
}

// Bounding-box centre is a good-enough centroid for axis-aligned polygons —
// for highly concave shapes it can fall outside the polygon, but the graph
// only uses it as a routing waypoint, not as a real geometry point.
function polygonCentroid(vertices) {
  const b = bbox(vertices);
  return { x: b.cx, y: b.cy };
}

// Build the navigation graph. Node IDs are stable so callers can ask
// shortestPath(graph, 'manifold', `room-${roomId}`).
export function buildNavGraph(state) {
  const nodes = [];
  const nodeById = new Map();
  const addNode = n => { nodes.push(n); nodeById.set(n.id, n); return n; };

  // Pre-compute the manifold's containing room so we can store it on the
  // node — used later when perimeter-routing the manifold→first-door segment.
  let manifoldRoomId = null;
  if (state.manifold) {
    manifoldRoomId = roomContainingPoint(state.manifold, state.rooms);
    addNode({ id: 'manifold', type: 'manifold', pos: state.manifold, roomId: manifoldRoomId });
  }
  for (const r of state.rooms) {
    addNode({
      id: `room-${r.id}`,
      type: 'room',
      pos: polygonCentroid(r.vertices || []),
      roomId: r.id,
    });
  }
  // Room-edge doors (legacy — we no longer place these via the UI but the
  // sample plan and undo history may still carry them).
  for (const r of state.rooms) {
    for (const d of r.doors || []) {
      const anchors = roomDoorAnchors(r, d);
      const otherRoom = roomContainingPoint(anchors.outer, state.rooms);
      addNode({
        id: `door-${r.id}-${d.id}`,
        type: 'door',
        pos: anchors.center,
        roomA: r.id,
        roomB: otherRoom, // null if the door opens to the exterior
      });
    }
  }
  // Free-wall doors — the current default. Determine which rooms lie on each
  // side of the wall by point-in-polygon on the door's two side anchors.
  for (const w of state.walls || []) {
    for (const d of w.doors || []) {
      const anchors = freeWallDoorAnchors(w, d);
      addNode({
        id: `door-wall-${w.id}-${d.id}`,
        type: 'door',
        pos: anchors.center,
        roomA: roomContainingPoint(anchors.sideA, state.rooms),
        roomB: roomContainingPoint(anchors.sideB, state.rooms),
      });
    }
  }

  const edges = [];
  const addEdge = (a, b, weight) => { edges.push({ from: a, to: b, weight }); };

  // Manifold ↔ doors / centroid of containing room.
  const manifold = nodeById.get('manifold');
  if (manifold) {
    const manifoldRoom = manifoldRoomId; // computed when adding the node above
    if (manifoldRoom) {
      addEdge('manifold', `room-${manifoldRoom}`, dist(manifold.pos, nodeById.get(`room-${manifoldRoom}`).pos));
    }
    for (const n of nodes) {
      if (n.type !== 'door') continue;
      const touchesManifoldRoom = manifoldRoom && (n.roomA === manifoldRoom || n.roomB === manifoldRoom);
      // If the manifold is inside a room: connect to every door of that room.
      // If the manifold is outside any room (e.g. sat in a hallway not yet
      // drawn as a zone): connect to doors whose other side is also outside.
      if (touchesManifoldRoom || (!manifoldRoom && (n.roomA === null || n.roomB === null))) {
        addEdge('manifold', n.id, dist(manifold.pos, n.pos));
      }
    }
    // Last-ditch fallback: if the manifold has no edges (isolated placement),
    // connect it to the nearest door so routing still has *some* answer.
    if (!edges.some(e => e.from === 'manifold' || e.to === 'manifold')) {
      let nearest = null, best = Infinity;
      for (const n of nodes) {
        if (n.type !== 'door') continue;
        const d = dist(manifold.pos, n.pos);
        if (d < best) { best = d; nearest = n; }
      }
      if (nearest) addEdge('manifold', nearest.id, best * 1.5); // penalised so proper paths are preferred
    }
  }

  // Doors ↔ each touching room's centroid.
  for (const n of nodes) {
    if (n.type !== 'door') continue;
    if (n.roomA && nodeById.has(`room-${n.roomA}`)) {
      addEdge(n.id, `room-${n.roomA}`, dist(n.pos, nodeById.get(`room-${n.roomA}`).pos));
    }
    if (n.roomB && nodeById.has(`room-${n.roomB}`)) {
      addEdge(n.id, `room-${n.roomB}`, dist(n.pos, nodeById.get(`room-${n.roomB}`).pos));
    }
  }
  // Door ↔ door if they share a room.
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type !== 'door') continue;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].type !== 'door') continue;
      const a = nodes[i], b = nodes[j];
      const shared = (a.roomA && (b.roomA === a.roomA || b.roomB === a.roomA)) ||
                     (a.roomB && (b.roomA === a.roomB || b.roomB === a.roomB));
      if (shared) addEdge(a.id, b.id, dist(a.pos, b.pos));
    }
  }

  return { nodes, edges, nodeById };
}

// Dijkstra shortest path. Returns the array of node IDs from `fromId` to
// `toId`, or null if unreachable.
export function shortestPath(graph, fromId, toId) {
  const adj = new Map();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    adj.get(e.from).push({ to: e.to, weight: e.weight });
    adj.get(e.to).push({ to: e.from, weight: e.weight });
  }
  const distMap = new Map();
  const prev = new Map();
  for (const n of graph.nodes) distMap.set(n.id, Infinity);
  distMap.set(fromId, 0);
  const queue = new Set(graph.nodes.map(n => n.id));
  while (queue.size) {
    let u = null, uDist = Infinity;
    for (const id of queue) {
      const d = distMap.get(id);
      if (d < uDist) { uDist = d; u = id; }
    }
    if (u === null || uDist === Infinity) break;
    queue.delete(u);
    if (u === toId) break;
    for (const { to, weight } of adj.get(u) || []) {
      if (!queue.has(to)) continue;
      const alt = uDist + weight;
      if (alt < distMap.get(to)) {
        distMap.set(to, alt);
        prev.set(to, u);
      }
    }
  }
  if (distMap.get(toId) === Infinity) return null;
  const path = [];
  let curr = toId;
  while (curr !== undefined) {
    path.unshift(curr);
    if (curr === fromId) return path;
    curr = prev.get(curr);
    if (curr === undefined) return null;
  }
  return null;
}

// Identify a room shared by two graph nodes (manifold or door). Returns its
// id, or null if there's no overlap.
function sharedRoomId(a, b) {
  const aRooms = a.type === 'door' ? [a.roomA, a.roomB].filter(Boolean) : (a.roomId ? [a.roomId] : []);
  const bRooms = b.type === 'door' ? [b.roomA, b.roomB].filter(Boolean) : (b.roomId ? [b.roomId] : []);
  for (const r of aRooms) if (bRooms.includes(r)) return r;
  return null;
}

// True if the polygon is an axis-aligned 4-vertex rectangle.
function isAxisAlignedRect(verts) {
  if (!verts || verts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = verts[i], b = verts[(i + 1) % 4];
    const isV = Math.abs(a.x - b.x) < 1;
    const isH = Math.abs(a.y - b.y) < 1;
    if (!isV && !isH) return false;
  }
  return true;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function polylineLen(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

// Wall-hugging route from A to B inside an axis-aligned rectangular room.
// Both A and B should lie on (or near) the room's perimeter — typically two
// doorway centres. Returns the full polyline including A and B as endpoints.
// Falls back to a straight line for non-rectangular rooms or when the
// inset would collapse.
function routeAroundRect(roomVerts, A, B, setback) {
  if (!isAxisAlignedRect(roomVerts)) return [A, B];
  const xs = roomVerts.map(v => v.x), ys = roomVerts.map(v => v.y);
  const x1 = Math.min(...xs), y1 = Math.min(...ys);
  const x2 = Math.max(...xs), y2 = Math.max(...ys);
  const s = setback;
  const ix1 = x1 + s, iy1 = y1 + s;
  const ix2 = x2 - s, iy2 = y2 - s;
  if (ix2 <= ix1 || iy2 <= iy1) return [A, B];

  const project = (p) => {
    // Snap p to the inset wall it's closest to.
    const dN = Math.abs(p.y - y1);
    const dS = Math.abs(p.y - y2);
    const dW = Math.abs(p.x - x1);
    const dE = Math.abs(p.x - x2);
    const m = Math.min(dN, dS, dW, dE);
    if (m === dN) return { wall: 'N', pos: { x: clamp(p.x, ix1, ix2), y: iy1 } };
    if (m === dS) return { wall: 'S', pos: { x: clamp(p.x, ix1, ix2), y: iy2 } };
    if (m === dW) return { wall: 'W', pos: { x: ix1, y: clamp(p.y, iy1, iy2) } };
    return { wall: 'E', pos: { x: ix2, y: clamp(p.y, iy1, iy2) } };
  };
  const pA = project(A);
  const pB = project(B);

  if (pA.wall === pB.wall) {
    return [A, pA.pos, pB.pos, B];
  }
  const adjacentCorner = {
    'N-E': { x: ix2, y: iy1 }, 'E-N': { x: ix2, y: iy1 },
    'E-S': { x: ix2, y: iy2 }, 'S-E': { x: ix2, y: iy2 },
    'S-W': { x: ix1, y: iy2 }, 'W-S': { x: ix1, y: iy2 },
    'W-N': { x: ix1, y: iy1 }, 'N-W': { x: ix1, y: iy1 },
  };
  const corner = adjacentCorner[`${pA.wall}-${pB.wall}`];
  if (corner) {
    return [A, pA.pos, corner, pB.pos, B];
  }
  // Opposite walls: two corners. Compute both options and pick shorter.
  const NW = { x: ix1, y: iy1 }, NE = { x: ix2, y: iy1 };
  const SE = { x: ix2, y: iy2 }, SW = { x: ix1, y: iy2 };
  let p1, p2;
  if (pA.wall === 'N' && pB.wall === 'S') { p1 = [A, pA.pos, NE, SE, pB.pos, B]; p2 = [A, pA.pos, NW, SW, pB.pos, B]; }
  else if (pA.wall === 'S' && pB.wall === 'N') { p1 = [A, pA.pos, SE, NE, pB.pos, B]; p2 = [A, pA.pos, SW, NW, pB.pos, B]; }
  else if (pA.wall === 'E' && pB.wall === 'W') { p1 = [A, pA.pos, NE, NW, pB.pos, B]; p2 = [A, pA.pos, SE, SW, pB.pos, B]; }
  else { p1 = [A, pA.pos, NW, NE, pB.pos, B]; p2 = [A, pA.pos, SW, SE, pB.pos, B]; }
  return polylineLen(p1) <= polylineLen(p2) ? p1 : p2;
}

// Find the doorway through which the manifold's path enters `parentRoom`.
// Returns the door node's world position, or null if there's no graph path.
// Used by the pattern engine to start the serpentine at the entry doorway
// rather than an arbitrary corner of the room.
export function findEntryDoor(state, parentRoom, graph) {
  if (!state.manifold || !parentRoom) return null;
  const g = graph || buildNavGraph(state);
  const pathIds = shortestPath(g, 'manifold', `room-${parentRoom.id}`);
  if (!pathIds || pathIds.length === 0) return null;
  const doorNodes = pathIds
    .map(id => g.nodeById.get(id))
    .filter(n => n.type === 'door');
  return doorNodes.length > 0 ? doorNodes[doorNodes.length - 1].pos : null;
}

// Build a tail polyline from the manifold to `target` (a point inside
// `parentRoom`, typically the loop's first or last pipe point), routing via
// the navigation graph. Between consecutive waypoints that share a transit
// or hybrid room, the segment is routed along that room's perimeter rather
// than cut diagonally — keeps tails neatly along walls.
export function routeTailViaGraph(state, parentRoom, target, graph) {
  if (!state.manifold || !parentRoom) return { points: [target], door: null };
  const g = graph || buildNavGraph(state);
  const pathIds = shortestPath(g, 'manifold', `room-${parentRoom.id}`);
  if (!pathIds || pathIds.length === 0) {
    return { points: [state.manifold, target], door: null };
  }
  // Extract just the physical waypoints (manifold + door positions); skip
  // the room-centroid routing artefacts.
  const waypointNodes = pathIds
    .map(id => g.nodeById.get(id))
    .filter(n => n.type === 'manifold' || n.type === 'door');

  const setback = (state.config && state.config.wallSetback) || 200;
  const points = [waypointNodes[0].pos];

  for (let i = 1; i < waypointNodes.length; i++) {
    const prev = waypointNodes[i - 1];
    const curr = waypointNodes[i];
    const sharedId = sharedRoomId(prev, curr);
    const sharedRoom = sharedId ? state.rooms.find(r => r.id === sharedId) : null;
    const kind = sharedRoom && (sharedRoom.kind || 'heated');
    if (sharedRoom && (kind === 'transit' || kind === 'hybrid')) {
      const perim = routeAroundRect(sharedRoom.vertices, prev.pos, curr.pos, setback);
      // perim starts with prev.pos (already in points) — append the rest.
      for (let k = 1; k < perim.length; k++) points.push(perim[k]);
    } else {
      points.push(curr.pos);
    }
  }
  // Final hop: last waypoint → target (the loop's first/last pipe point).
  // This sits inside the heated room; keep it direct.
  points.push(target);
  return { points, door: null };
}
