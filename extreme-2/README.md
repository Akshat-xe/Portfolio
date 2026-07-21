# Akshat Kumar Racing Engine

A procedurally generated, infinitely long driving engine that runs entirely in the
browser. No level data, no downloaded meshes, no physics middleware — the terrain,
the road, the scenery, the vehicle dynamics and the engine note are all computed at
runtime from a single seed string.

```
Extreme Akshat/
├── index.html            page shell, HUD markup, colour-vision filter matrices
├── styles.css            translucent overlay UI
└── src/
    ├── main.js           boot sequence, frame loop, settings wiring, cameras
    ├── input.js          keyboard + gamepad, digital keys ramped to analogue axes
    ├── lib/
    │   ├── alea.js       seedable PRNG + positional hash
    │   └── simplex.js    2D simplex noise, allocation-free
    ├── world/
    │   ├── heightfield.js  fBm + ridge + domain warp; road corridor carving
    │   ├── road.js         autonomous router, smoothing, Bezier resample, spatial hash
    │   ├── roadmesh.js     rolling ribbon over a fixed-capacity buffer
    │   ├── terrain.js      three-ring LOD with recycled tiles
    │   ├── scatter.js      deterministic instanced trees / rocks / posts
    │   ├── grass.js        instanced grass, vertex-shader wind, atlas variants
    │   └── sky.js          sky dome shader, sun, decoupled clouds, time of day
    ├── physics/
    │   └── vehicle.js      custom kinematic solver: raycast struts, slip-ratio
    │                       tyres, plane-fit attitude, drift model, barriers
    ├── render/
    │   ├── carmodel.js       procedural vehicle mesh
    │   ├── textures.js       canvas-generated tileable materials & atlases
    │   ├── env.js            shared lighting/atmosphere uniform block
    │   ├── terrainmaterial.js triplanar ground shader
    │   ├── aomap.js          faked-AO splat map render target
    │   └── postfx.js         HDR + depth → atmosphere → bloom → ACES → grade → FXAA
    ├── audio/
    │   └── audio.js        Web Audio engine, tyre, skid and wind synthesis
    └── ui/
        ├── settings.js     declarative schema + observable store
        ├── ui.js           menu, HUD, minimap, toasts
        └── feedback.js     local-first feedback capture
```

## Running it

Any static file server will do. From this directory:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Opening `index.html` directly off the filesystem will **not** work — it uses ES
modules and an import map, both of which browsers refuse over `file://`.

Three.js is loaded from a CDN via the import map in `index.html`. To run offline,
vendor `three.module.js` and `examples/jsm/` locally and repoint the two import-map
entries.

## Controls

| Action | Key |
| --- | --- |
| Throttle / brake | `W` `S` (or arrows) |
| Steer | `A` `D` |
| Handbrake | `Space` |
| Cycle camera | `C` |
| Headlights | `L` |
| Reset to road | `R` |
| Skip ahead 1 km | `T` |
| Photo mode | `P` |
| Settings | `Esc` or `Tab` |

A connected gamepad takes over automatically: left stick steers, triggers are the
pedals, `A`/cross is the handbrake.

## How it works

### Terrain

Elevation is stacked fractional Brownian motion. The first three octaves are
ridged (`1 - |n|`, squared) which puts sharp crests on the large features while the
small octaves stay smooth. The sample point is displaced by a low-frequency warp
field first, which is what stops the result from looking grid-aligned. A separate
low-frequency mask scales the amplitude so the world has plains as well as ranges.

Everything is seeded from an Alea PRNG, so a given seed string reproduces the exact
same world in any browser, any session.

### Road routing

The router marches a midline forward in 10 m increments. At each step it scores a
fan of candidate headings on grade, cross-slope, distance from a slowly-wandering
target heading, and proximity to water, then rejects any candidate that would bring
the road back within 46 m of its own trail. The winner's elevation is clamped to a
12 % grade — the road cuts through a hill rather than climbing it, which is why you
end up driving through embankments and cuttings.

Raw 10 m samples make for a road that bottoms out the suspension, so elevation is
retroactively smoothed with a 9-point moving average once each node has its full
window. The smoothed midline is then resampled to 2 m with a quadratic Bezier using
the midpoint construction — consecutive segments share tangents, so the whole route
is C1 with no separate fitting pass.

Coarse nodes are a doubly-linked list. The fine points go into a uniform-grid
spatial hash, plus a coarser occupancy map that answers "could the road possibly
matter here?" in a single lookup. Terrain generation calls the surface function
millions of times and nearly all of those points are nowhere near the road, so that
early-out is worth more than any other optimisation in the codebase.

### LOD

| Ring | Footprint | Vertex spacing | Purpose |
| --- | --- | --- | --- |
| Far | 5×5 tiles of 1000 m | 12.5 m | horizon |
| Near | 5×5 tiles of 200 m | 4 m | corridor around the car |
| Micro | 3×3 tiles of 40 m | 1 m | tyre-contact geometry |

Tiles are allocated once and recycled. The x/z lattice is baked into the position
buffer at construction; reassigning a tile to new ground only rewrites Y, the
normals and the vertex colours. Normals come from the tile's own height grid by
finite difference, so a rebuild costs no extra noise evaluations.

Seams are welded rather than hidden: near and micro vertices lerp toward the far
ring's bilinearly-sampled lattice as they approach their ring's outer border, so
adjacent rings agree exactly on height. Rings also carry a small descending Y bias
so the coarser ring always loses the depth test where they overlap.

Rebuilds are queued and amortised — one or two tiles per frame during play, and
time-budgeted (work until the frame is nearly spent, then yield) behind the loading
screen.

### Vehicle

A 3-DOF planar rigid body (surge, sway, yaw) with an independent heave axis. No
generic rigid-body engine, so no WASM heap, no cross-boundary marshalling, and no
broadphase paying for collisions this game never needs.

**Suspension** is four independent downward raycasts against the heightfield
*function* — not triangle soup — so ground contact is exact regardless of which
LOD happens to be drawn. Each strut is a damped spring, `F = -k·x - c·v`, with `x`
the rest length minus the raycast hit distance and `v` the compression rate.

**Chassis orientation** comes from the normal of the plane through the four
contact points (cross product of the two diagonals — the cheap best fit for four
near-coplanar points), plus load transfer. It is deliberately **not** derived from
strut compression: feeding compression back into the hub heights that produce it
is a positive feedback loop, and any asymmetry amplifies until one side of the car
rides its bump stops.

**Tyres** carry real angular velocity, so longitudinal force comes from an actual
slip ratio `K = (ωR - u)/u` rather than applied thrust — the car can spin a wheel
up or lock one under braking, and the tacho shows it. Both axes run a simplified
Pacejka saturation curve and are combined through a friction ellipse. Two details
matter for stability:

- `K` is integrated through a **relaxation length** instead of evaluated directly.
  The raw quotient is singular at `u = 0` and stiff just above it. The decay term
  carries a velocity floor, without which a wheel that spins up while stationary
  latches `K` at its clamp forever and the tyre reports full thrust with nothing
  actually slipping.
- Normal load for the tyre model is **not** the raw strut force. Strut load spikes
  on dive, and because pitch here is kinematic there is no matching unload at the
  other axle — summing strut forces yields more total normal load than the car
  weighs, and the tyres invent grip. (Before this was fixed, braking pulled 1.78 g
  against a 1.35 friction coefficient.) Instead weight and downforce are
  distributed by CG position with explicit longitudinal and lateral transfer, and
  the struts contribute only a contact factor so bumps and airtime still modulate
  grip. Total normal load is conserved.

**Drift** is a dual-vector momentum model layered on top. The car carries a
steering vector (where the nose points) and a momentum vector (where it is
actually travelling). While the rears are inside their friction limit the two stay
locked and the model does nothing. Once they saturate, a fraction of the yaw
increment is withheld from the velocity vector — converting longitudinal velocity
into lateral slip at constant speed, so the car slides radially outward from the
Ackermann centre. Counter-steering interpolates the momentum vector back toward
the nose. A dead zone keeps it off ordinary cornering slip, so the tyre model
still owns the car's understeer.

Integration is a fixed 180 Hz substep, capped so a backgrounded tab cannot tunnel
the car through the world when it resumes. The whole update runs on module-scope
scratch state — no allocation in the hot path, so no GC sawtooth. Measured cost is
about 0.09 ms per rendered frame.

### Collisions

Trees, rocks and scenery have no colliders at all — driving through them is
intentional and costs nothing.

The car is kept on the road by **barriers that are not geometry**: each midline
node carries a scalar lateral offset, found by walking outward from the
carriageway edge until the ground stops being drivable (a real drop, or water) and
stopping just short. Constraining the car is then a 1D comparison of lateral
offset against that number — push the chassis back to the line, cancel the normal
velocity component, scrub a little speed.

Two things this needs to not be miserable, both learned the hard way:

- The offset is **rate-limited along the route** (max 0.35 m per 10 m node). A step
  change strands the car outside the new line when a wide section narrows; it gets
  clamped to the barrier and scrapes along it indefinitely.
- The constraint applies a small **restoring push** toward the carriageway.
  Cancelling inward normal velocity alone makes a perfect one-way wall that never
  returns any lateral position, so a car that arrives outside the line rides it
  forever.

Barriers can be switched off in Driving settings to roam off-road.

### Audio

One oscillator stack (four harmonics of the four-cylinder firing frequency through
a waveshaper and a load-dependent lowpass), one gearbox whine, and three bands of a
shared noise buffer for tyre roar, skid and wind. Nodes are built once; only
`AudioParam`s change. Browsers will not start an `AudioContext` without a gesture,
so audio arms on your first click or keypress.

### Terrain shading

The ground is a bespoke `ShaderMaterial`, not a patched standard material. The
scene's lighting rig is one directional key plus a hemisphere fill, so
reimplementing it costs a dozen lines and buys full control.

- **Triplanar mapping.** Textures project from all three axes, blended by the
  normal raised to the fourth power. Plain XZ mapping smears into vertical
  streaks on the 60° cliffs this world generates constantly.
- **Slope-driven blending.** `dot(N, up)` selects between grass, dirt and rock,
  with the transition perturbed by two octaves of macro noise at very different
  world scales so it never reads as a contour line — and so the detail textures
  do not read as an obvious grid from altitude.
- **Fresnel.** Grazing angles pick up a little atmosphere, which is what gives
  distant ridgelines their depth.
- Altitude biomes (beach near the waterline, snow above the treeline masked by
  slope) layer on top of the material blend.

All textures are generated on a canvas at boot from value-noise fBm on a
*periodic* lattice, so they tile seamlessly by construction.

One trap worth recording: the material weights originally guarded each texture
fetch behind `if (weight > 0)`. That puts the sample in non-uniform control flow,
where GLSL derivatives are undefined — the hardware falls back to a coarse mip and
the ground renders as flat untextured colour. Sample unconditionally, weight
afterwards.

### Atmosphere

Fog is a **depth-based post pass**, not a per-material term. The scene renders
into a half-float target carrying a depth texture; the pass reconstructs world
position per pixel and integrates an exponential height-density field along the
view ray analytically. That puts fog thick in the valleys and thin on the peaks
rather than applying a flat curtain by distance, and it means terrain, road,
scenery, car and water share one implementation instead of six that drift apart.

Forward scattering mixes toward the sun's colour by `dot(viewDir, sunDir)`, giving
the two-tone separation you get looking into versus away from the sun.

Clouds live on their own planes, deliberately decoupled from the sky gradient: the
gradient and sun are a function of time of day, the clouds drift on their own
clock. Baking them together would mean a cubemap swap to change either one.

### Instancing

Everything scattered is an `InstancedMesh` — one draw call each.

- **Grass** streams by cell exactly like the scenery. A probability density
  function decides placement, the ground normal tilts each blade so it grows out
  of the slope, and a per-instance random selects one of four tufts from an atlas
  so neighbours are not clones. Wind is entirely in the vertex shader, weighted by
  blade height so the base stays planted and only the tip travels. Distance fade
  is a dithered cutout rather than alpha, so it does not read as a transparent band.
- **Faked ambient occlusion** replaces shadow mapping for static scenery. A splat
  map is maintained around the player with a soft dark disc under every tree and
  rock; the terrain shader samples it by world XZ. It re-renders only when the
  player crosses a 32 m boundary, and it reads positions straight out of the
  instance matrix buffers, so the scatter system does no bookkeeping for it.
  Real-time shadow mapping is kept for one thing only: the car onto the road.

### Post-processing

```
scene → HDR target (FP16 + depth) → atmosphere → bloom → ACES/encode → grade → FXAA
```

- **FP16 HDR.** Half-float keeps the sun and emissives well above 1.0 for the
  bloom threshold and tone mapper, at half the bandwidth of FP32.
- **ACES filmic** tone mapping and sRGB encode happen in `OutputPass`, after
  bloom, so bright skies roll off instead of clipping.
- **Bloom** thresholds at 1.0, so only genuinely bright HDR pixels bloom — sun
  disk, headlamps, brake lights. This is intensity-selective; it is *not* a
  layer-isolated selective bloom, which would need a second scene render.
- **MSAA is off** and anti-aliasing is a single FXAA pass at the very end, working
  on the tonemapped LDR image where it belongs. Multisampling a half-float target
  costs bandwidth better spent elsewhere.

The grade pass folds vignette, chromatic aberration, radial speed blur, film grain
and a saturation/contrast trim into one fullscreen shader. Every effect is
individually switchable and all motion effects are force-disabled by the
reduce-motion accessibility flag.

### Not implemented

Two items from the rendering brief are deliberately absent, rather than silently
approximated:

- **Reversed depth buffer.** `EXT_clip_control` *is* available in the test browser,
  but three.js 0.169 does not expose `renderer.reversedDepthBuffer`, so there is
  nothing to drive it with. The engine probes for both at boot and reports the
  result (`akshatEngine.depthInfo`). Z-fighting on the far grid is instead handled
  by the LOD seam welding and per-ring depth bias described above, which is
  sufficient at this draw distance. Upgrading three to a release that exposes the
  flag would let `PostFX.tryReversedDepth()` enable it with no other changes.
- **2D tree imposters.** Distant trees are still low-poly 3D instances. The
  imposter swap would need the scatter pool split into near/far meshes with
  billboards beyond a radius; the hook (a second pool and a distance test in
  `Scatter._populate`) is not there yet.

## Settings

Seven tabs — World, Graphics, Driving, Audio, Accessibility, Controls, Feedback —
built declaratively from the schema in `src/ui/settings.js`. Adding an option is one
object there plus one listener in `main.js`. Everything persists to `localStorage`.

Accessibility covers reduce-motion, horizon lock, high-contrast HUD, larger UI text,
HUD scale, and protanopia/deuteranopia/tritanopia colour transforms applied to the
whole render.

## Feedback

There is no hard-coded endpoint. Reports are queued in `localStorage` and go nowhere
until you supply a URL of your own in the Feedback tab, and even then only when you
press Send. Saved reports can be exported as JSON or cleared. A report carries the
seed, odometer, frame rate, GPU string, viewport and current settings alongside your
message.

## Measured behaviour

Figures from instrumenting the solver directly (seed `akshat`, assists on):

| | |
| --- | --- |
| 0–60 km/h | 2.2 s |
| 0–100 km/h | 4.1 s |
| Braking, on road | 0.89–1.08 g (μ ceiling 1.35, ABS holds below peak) |
| Peak drift angle, handbrake turn | 44–48°, recovers on counter-steer |
| Barrier constraint accuracy | within 3 cm of the annotated offset |
| Solver + streaming cost | ~0.10 ms per rendered frame |
| Endurance, 78 km/h target | 90% on carriageway, no exceptions, all pools flat |
| Scene | ~720k triangles in ~106 draw calls |

The endurance figure uses a crude proportional lane-keeper as the driver; it is a
measure of the engine's stability over a long run, not of how fast the road can be
driven. Note also that the framerate readout in the HUD is only meaningful in a
normal browser — a headless preview drives `requestAnimationFrame` on demand and
will report nonsense.

## Performance notes

- `renderer.info.autoReset` is off and reset manually, so the HUD's draw-call and
  triangle counts are true per-frame totals across every post-processing pass.
- Streaming budgets shrink automatically when frame time climbs past 22 ms.
- Road geometry behind the car is trimmed continuously; every pooled structure
  (fine nodes, spatial hash, occupancy map, scatter cells, instance slots) stays
  flat over an arbitrarily long drive.
- Draw distance scrubs by hiding outer bands of the far ring rather than rebuilding
  it, so the slider is free to move.
