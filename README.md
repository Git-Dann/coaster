# Cozy Coaster

A peaceful, browser-based roller coaster sandbox. Build track across streaming procedural landscapes, watch supports grow beneath it, choose your train and weather, then ride it, driven by a real distributed-mass physics simulation. No money, no timers, no scores.

## Run it

```bash
nvm use            # Node 22
npm ci
npm run dev        # http://localhost:5173
```

## Checks

```bash
npm run check      # typecheck, lint, unit + physics tests, production build
npm run build && npm run test:e2e   # Playwright smoke/regression against the production preview
```

## What's inside

- **Physics**: rail-constrained articulated train, per-bogie gravity, normal-force rolling resistance, quadratic drag, chain lifts with anti-rollback, LSM launches, magnetic brakes, tyre-driven station; RK4 at 120 Hz. See [docs/physics.md](docs/physics.md).
- **Track**: quintic Hermite curves with curvature continuity at nodes, arc-length baked frames that stay stable through loops, 14 builder elements from eased turns to Immelmanns.
- **World**: deterministic chunked terrain generated in workers, six biomes, river, instanced vegetation with wind, time of day and weather.
- **Construction**: translucent previews, draggable steer/height handles, automatic banking, friendly fit hints, previewed circuit closing, procedural steel and timber supports that grow and re-anchor, full undo/redo.
- **Everything else**: procedural audio, IndexedDB autosave with migration and recovery, import/export, photo and relax modes, PWA offline support.

Docs: [architecture](docs/architecture.md) · [physics](docs/physics.md) · [performance](docs/performance.md) · [art direction](docs/art-direction.md) · [interaction](docs/interaction-design.md) · [audio](docs/audio-design.md) · [deployment](docs/deployment.md) · [asset licences](docs/asset-licences.md) · [status and limitations](docs/status.md)

This is an entertainment simulation, not an engineering or ride-safety tool.
