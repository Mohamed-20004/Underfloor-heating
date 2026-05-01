# UFH Mapper

A web-based **Underfloor Heating Layout Designer**. Draw a floor plan, mark
external walls, place a manifold, and generate a professional setting-out
drawing with pipe loops, lengths, and a manifold schedule.

## Run it

There is no build step and no install step.

```bash
# from the repository root
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server (or just opening `index.html` directly in a modern
browser) works. The app uses native ES modules.

## Quick tour

1. Click **Load Sample** to populate a small ground-floor plan.
2. Click **Generate Layout** to produce pipe loops.
3. Use the right-hand panel to inspect the **Schedule**, **Calculations**, and
   **Warnings**.
4. Use **SVG**, **CSV**, or **Print / PDF** to export.

## Drawing your own plan

| Tool        | What it does                                              |
|-------------|-----------------------------------------------------------|
| Select      | Click a room to edit its name, pattern, and walls.        |
| Room        | Click and drag on the canvas to draw a rectangular room.  |
| Wall        | Click any wall edge to toggle external / internal.        |
| Manifold    | Click anywhere to place the manifold.                     |
| No-Go       | Click and drag inside a room to mark a no-pipe area.      |
| Delete      | Click a room or no-go zone to remove it.                  |

Hold **Shift** + drag (or middle-click drag) to pan. Wheel to zoom.

## Engineering rules embedded in the engine

- **100 m maximum loop length** (configurable). Longer paths are split
  automatically and a warning is emitted.
- **80 mm minimum bend radius** (configurable). All corners are rendered as
  circular arcs, never polygonal.
- **100 mm wall setback** keeps pipes off the wall.
- **Edge-zone tightening** within 1 m of any external wall: spacing drops from
  the field value (default 200 mm) to the edge value (default 100 mm),
  approximating BS EN 1264 heat-loss compensation.
- **External-wall hugging**: the first parallel pipe row hugs the longest
  external wall.
- **No-pipe-crosses-internal-wall**: each room is a separate loop, joined to
  the manifold by tails.
- **4-colour disambiguation**: a greedy graph-colouring algorithm assigns one
  of four colours per loop so that adjacent loops never share a colour. Colours
  carry **no thermal meaning**.
- **Loop-balance check**: warns if the spread between the longest and shortest
  loop exceeds 20%.

## Patterns

- **Serpentine (meander)** — parallel rows along the longest external wall,
  spacing tightens in the edge zone, alternating direction with U-bends.
- **Bifilar (counterflow)** — concentric rectangular spiral inward at 2× the
  field spacing, then outward offset by one spacing so flow and return runs
  alternate across the floor. Best for living spaces.
- **Hybrid (routed)** — serpentine variant that drops rows obstructed by no-go
  zones. A future iteration could swap in a true skeleton-based router.

## Limitations (MVP)

- Rooms are rectangles. Arbitrary polygons require a polygon-offset library
  (Clipper, Turf.js, or similar) — straightforward to add later.
- Manifold tails are drawn as straight lines for the MVP. Production output
  would route them along walls and through doorway thresholds.
- The hybrid pattern reuses the serpentine algorithm with no-go avoidance; a
  full skeleton-based pathfinder is out of scope for the MVP.
- Heat-output figures are first-approximation only. Plug into a proper heat
  loss model (e.g. CIBSE Domestic Heating Design Guide) for production work.

## File layout

```
index.html         — page shell
styles.css         — UI + SVG style rules
src/state.js       — central state + actions
src/geometry.js    — polygon and pipe-path math
src/patterns.js    — serpentine / bifilar / hybrid generators
src/loops.js       — loop assembly, splitting, colouring
src/render.js      — SVG rendering of all layers
src/editor.js      — pointer interactions per tool
src/calc.js        — totals and balance summary
src/export.js      — SVG / CSV / print export
src/main.js        — DOM wiring
```

## Tech notes

- Pure ES modules, no bundler required.
- All coordinates are in millimetres internally; the SVG `viewBox` is in mm so
  exports are scale-correct (1:50 on A3 looks right immediately).
- Pipe paths are stored as polylines and smoothed at corners with circular
  arcs at render and export time.
