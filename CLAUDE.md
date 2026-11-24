# Cozy Coaster: engineering constraints

Browser 3D roller coaster sandbox. Three.js + strict TypeScript + Vite + React (UI only) + Zustand. Client-only, deployed to Cloudflare Pages.

## Commands

- `npm run dev`: local dev server
- `npm run check`: typecheck, lint, unit/physics tests, build (run before every commit)
- `npm run test:physics`: physics validation suite
- `npm run build && npm run test:e2e`: Playwright smoke/regression against the production preview
- `node scripts/icons.cjs`: regenerate PWA icons from `public/icons/icon.svg`

## Non-negotiables

- Physics is the source of truth. Never move the train with animation or constant-speed splines. SI units, fixed 120 Hz step, RK4. Playback speed scales time, never forces. See `docs/physics.md`.
- The canonical track is `TrackDesign` → `BakedTrack`. Meshes, supports, audio and physics all derive from it; never read geometry back from meshes.
- Never silently alter committed track. Builder changes go through a preview (`engine.setPreview`) and are committed explicitly; one construction operation = one undo step.
- No per-frame data in React state. The engine owns a single `requestAnimationFrame`. UI reads live values via refs/intervals.
- No per-frame allocation in hot paths (sim step, track sampling, instance writes).
- Workers for terrain generation; transferables only; reject stale results by revision.
- Pressure-free tone: no fail states, no red alerts, friendly hints only. No riders, passengers or human figures in carriages.
- Never fabricate test or performance results. Never disable tests to go green. Document limitations in `docs/status.md`.
- No new dependencies without a written justification in the PR.
- All audio is synthesised at runtime (no unlicensed assets). Register any asset in `docs/asset-licences.md`.

## Map

- `src/engine/`: renderer-independent core (`core/vec3`, `track/`, `physics/`) plus Three.js systems
- `src/features/`: builder logic, saves (IndexedDB), scenery helpers
- `src/stores/game.ts`: app state and undo history; `src/app/bridge.ts` syncs store → engine
- `src/components/`, `src/design-system/`: UI
- `docs/`: specifications
