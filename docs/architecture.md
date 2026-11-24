# Architecture

## Layers

```
React UI (components, design-system)        ← reads Zustand, never per-frame data
        │ actions
Zustand store (stores/game.ts)               ← canonical app state + undo history
        │ subscribe (app/bridge.ts)
Engine (engine/core/engine.ts)               ← owns renderer, one rAF loop, systems
   ├─ TrainSim (physics)  ← fixed 120 Hz, pure TS, no Three.js
   ├─ BakedTrack (track)  ← pure TS, shared by physics, meshes, supports, audio
   ├─ TerrainManager → Web Worker pool (terrain/chunk-gen.ts, pure)
   ├─ Track/Support/Train renderers, vegetation, atmosphere, water, weather
   ├─ CameraRig, GestureRecogniser
   └─ AudioEngine (Web Audio, procedural)
Persistence (features/saves) ← IndexedDB, validation, migration, autosave
```

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Renderer | Three.js WebGL2 | Reliable baseline everywhere. WebGPU not required; evaluate later behind a flag after benchmarking. |
| Physics | Custom rail-constrained 1-DOF sim | A rigid-body engine would fight the rail constraint and add weight. |
| Curves | Quintic Hermite with shared node curvature | G2 at nodes, predictable derivatives, local control. Catmull-Rom alone overshoots and has no curvature control. |
| Frames | Upright-continuous + rotation-minimising through verticals | Stable loops and level helices; no Frenet flips at inflections. |
| Integrator | RK4, 120 Hz | Excellent energy behaviour; cost negligible. |
| UI | React + Zustand | Familiar, small. Engine is independent of React. |
| Saves | Raw IndexedDB | No dependency needed; canonical design data only (meshes regenerate). |
| Audio | Procedural Web Audio | No licensing risk, tiny download, responds directly to simulation values. |
| Floating origin | Not needed as a rebase step | Three.js composes model-view matrices on the CPU in float64, and every chunk/track mesh stores vertices relative to its own origin, so float32 GPU precision holds at any distance. Physics and saves use float64 logical coordinates. Verified by a test translating the coaster 250 km. |
| Dependencies | three, react, react-dom, zustand | Nothing else at runtime. |

## Data flow for a construction edit

1. UI changes builder params → store.
2. `bridge.refreshPreview` builds a preview design (committed nodes copied untouched, preview nodes get session-stable ids).
3. Engine bakes the preview, draws it with a translucent material, regenerates supports (stable keys mean unchanged supports stay still; new ones grow).
4. Place → `commitDesign` (one undo step) → engine rebakes; track renderer reuses cached geometry for unchanged segments.

## Streaming

128 m chunks, four LODs (64/32/16/8 segments) by distance, skirts hide LOD cracks, revision ids reject stale worker results, uploads limited to two chunks per frame, old meshes stay until replacements arrive, chunks beyond draw distance + hysteresis are disposed. Vegetation candidates come from the worker; the main thread filters them against the track/scenery blocker hash and writes one InstancedMesh per type.
