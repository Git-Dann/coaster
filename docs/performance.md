# Performance

Performance budgets are targets to validate on real hardware. **No physical-device measurements have been taken yet**; everything below says exactly where and how it was measured.

## Budgets (representative scene: starter coaster, meadow, seed 2026)

| Metric | Mobile target | Desktop target |
|---|---|---|
| Frame rate | 60 FPS (30 FPS fallback on mid-range) | 60 FPS, higher where supported |
| Draw calls | ≤ 150 | ≤ 300 |
| Visible triangles | ≤ 300 k | ≤ 1 M |
| Initial compressed download | ≤ 3 MB | same |
| Main-thread tasks during interaction | < 50 ms | < 50 ms |

## Measured

### Bundle (production build, `npm run build`)

| File | Raw | gzip |
|---|---|---|
| three | 553 kB | 138 kB |
| app | 223 kB | 76 kB |
| react | 219 kB | 68 kB |
| CSS | 17 kB | 4 kB |
| terrain worker | 10 kB | – |
| **Total** | **≈ 1.02 MB** | **≈ 290 kB** |

No textures, models or audio files are downloaded: everything is procedural.

### CPU (`npx tsx scripts/bench.ts`, Node 22, Intel Xeon 2.1 GHz cloud VM, 4 vCPU, median of repeated runs)

| Operation | Time |
|---|---|
| Bake starter track (370 m) | 2.8 ms |
| One 1/120 s physics step, 6 cars | 0.019 ms |
| Physics per rendered second (120 steps) | 3.4 ms (≈0.06 ms per 60 Hz frame) |
| Generate supports, whole coaster | 1.2 ms |
| Track mesh, whole coaster, uncached | 15.5 ms (edits only rebuild changed segments) |
| Builder preview (bake + append) | 2.1 ms |
| Terrain chunk LOD0 with vegetation (worker) | 12.3 ms |
| Terrain chunk LOD3 | 0.19 ms |

### GPU-side counts (headless Chromium + SwiftShader software renderer, 1280×800, `balanced` tier)

Counts are hardware-independent; frame times are **not** meaningful on a software renderer (≈4–8 FPS there) and are not reported as performance.

| Scene | Draw calls (incl. shadow pass) | Triangles |
|---|---|---|
| Starter overview (before train mesh merging) | 471 | 548 k |
| Starter overview (after merging carriage meshes by material) | 256–269 | 520–620 k |
| Front-seat ride | 141 | 554 k |
| Phone 390×844, `low` tier | 187 | 290 k |

**Status against budget**: desktop draw calls are within budget; the phone overview is slightly over the 150 target. The biggest remaining contributors are terrain chunks (one draw each, ~50–80 visible) and the train's per-material meshes in the shadow pass. Next steps: merge distant LOD2/3 chunks into a few batched meshes, instance carriages across the train, and skip shadow casting for far terrain/props on mobile tiers.

## Systems

- One `requestAnimationFrame`, owned by the engine. React never renders per frame; telemetry and diagnostics update the DOM directly at 10 Hz / 2 Hz.
- Fixed 120 Hz physics with bounded catch-up; physics is never reduced to save frames.
- Terrain in a worker pool with transferable buffers, revision-based stale-result rejection, two GPU uploads per frame.
- Instancing: vegetation (one InstancedMesh per type across all chunks), scenery, supports (three meshes total), weather particles (fixed pools).
- Track: per-segment geometry cache merged into one draw call; colours are shader uniforms so recolouring never rebuilds geometry.
- Adaptive quality: rolling 120-frame window, p50/p90 with hysteresis (degrade after 2.5 s slow, recover after 10 s of headroom, never auto-climbs to Ultra). Ladder reduces pixel ratio, shadow map size/extent, vegetation radius/density, weather density and draw distance.
- Developer overlay (Settings → Graphics → Developer diagnostics): FPS, frame-time percentiles, main-thread and sim timing, draw calls, triangles, geometries/textures, chunks, supports, vegetation, worker queue, audio voices, quality tier, pixel ratio and resolution.

## Watercolour pass cost

The painterly pass is a full-screen filter; its Kuwahara step is the costly part (taps grow with radius²). It is expected to be modest on real GPUs at radius 2–3 (not yet measured); on CPU software rendering (SwiftShader, used in CI) it roughly halves the frame rate. Battery tier disables Kuwahara and Settings → Graphics → Watercolour painting turns the whole pass off. Functional browser tests run at Battery with painting off for that reason; the visual-scenes test keeps the full look. Mobile GPU cost has **not** been measured.

## Not yet done

- Physical device profiling (iPhone, Android mid-range, iPad), thermal soak tests.
- Long-session memory leak testing on hardware (chunk disposal and geometry disposal are implemented and counted in diagnostics, but not soak-tested).
- WebGPU evaluation.
- KTX2/glTF pipelines (not needed yet: no textures or model files).
