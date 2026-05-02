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

  if (state.manifold) {
    addNode({ id: 'manifold', type: 'manifold', pos: state.manifold });
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
  let manifoldRoom = null;
  if (manifold) {
    manifoldRoom = roomContainingPoint(manifold.pos, state.rooms);
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

// Build a tail polyline from the manifold to `target` (a point inside
// `parentRoom`, typically the loop's first or last pipe point), routing via
// the navigation graph. The polyline is:
//   [manifold.pos, door1.pos, door2.pos, ..., target]
// If no graph path is found, falls back to a straight line.
export function routeTailViaGraph(state, parentRoom, target, graph) {
  if (!state.manifold || !parentRoom) return { points: [target], door: null };
  const g = graph || buildNavGraph(state);
  const pathIds = shortestPath(g, 'manifold', `room-${parentRoom.id}`);
  if (!pathIds || pathIds.length === 0) {
    return { points: [state.manifold, target], door: null };
  }
  const points = [];
  for (const id of pathIds) {
    const n = g.nodeById.get(id);
    // Only the manifold and door waypoints become physical pipe points; the
    // room-centroid nodes are routing-graph artefacts and aren't pipe stops.
    if (n.type === 'manifold' || n.type === 'door') points.push(n.pos);
  }
  points.push(target);
  return { points, door: null };
}
