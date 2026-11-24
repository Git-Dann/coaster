# Status, acceptance criteria and known limitations

Last updated 2026-11-24. This is an honest account of what is done, what is partial and what is outstanding.

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Simulation foundation | **Done.** Track engine, distributed-mass physics, 22 physics tests, starter circuit. |
| 2 | Construction | **Mostly done.** Presets, live preview, steer/height handles, auto-banking, fit hints, previewed connect, node editing, supports, undo/redo. Missing: section insertion mid-track, track duplication UI, whole-coaster move UI (functions exist in `design-ops.ts`), adjustable snapping increments. |
| 3 | Visual identity | **Partial.** Coherent procedural art, materials, lighting, station, six carriage styles, four track styles, seven support materials. Models are code-built, not hand-modelled; tunnels have no shell. |
| 4 | Environment streaming | **Done for the core.** Worker chunk streaming, LOD, skirts, six biomes, seeds, weather, time of day, day cycle. Floating origin handled by chunk-local geometry (see architecture). |
| 5 | Interface and sound | **Mostly done.** Responsive UI, design tokens, settings, accessibility options, procedural audio. Audio not yet tuned by ear; no WCAG audit. |
| 6 | Creative sandbox | **Partial.** Scenery placement/removal, terrain brushes, coaster garden, saves (multiple parks, rename/duplicate/delete/import/export, thumbnails, snapshots), photo mode, relax mode. Missing: blueprint library, ride journal, decorative presets, tilt-shift miniature mode, track lighting, named station signs rendered in 3D. |
| 7 | Optimisation | **Partial.** Instancing, merged draw calls, worker generation, adaptive quality, diagnostics overlay, CPU benchmark. Not done: physical device profiling, thermal and memory soak tests, mobile draw-call target. |
| 8 | Release | **Partial.** PWA, CI, Cloudflare Pages project with Git integration and preview deployments. Production (`main`) not yet updated: awaiting your review and merge. |

## Definition of done walkthrough

| Step | State |
|---|---|
| Opens on a phone straight into the world | Yes (no landing page; welcome card over the live scene) |
| Select track end, raise it, supports grow | Yes (verified with real pointer events in e2e) |
| Create a banked turn | Yes (Track piece with turn; auto-banking) |
| Connect the circuit | Yes (Connect shows a preview, then commits) |
| Six-carriage train, change colours | Yes |
| Timber support structure | Yes |
| Gentle rain | Yes |
| Ride it with physical acceleration, climb, descent, banking, braking | Yes (front/rear seat and four other cameras) |
| Hide the interface and watch | Yes (relax mode, photo mode) |
| Autosave, close, return, creation intact | Yes (e2e verifies reload persistence in Chromium) |
| Same on desktop, tablet, mobile | Layouts implemented for all three; **only tested in emulation** |

## Test evidence

- Unit/physics: `npm test`: 108 tests across physics (22), construction/rendering (18), saves (59), audio (9). All pass.
- End-to-end: Playwright, Chromium only, two projects (1440×900 desktop, Pixel 7 emulation), software WebGL (SwiftShader). See the PR description for the latest run.
- Visual regression scenes are captured to `test-results/visual/` and were inspected by eye. There is no pixel-diff baseline yet (software rendering is not deterministic enough across machines; needs a fixed CI image).

## Browser and device matrix

| Target | Tested? |
|---|---|
| Chromium desktop (headless, SwiftShader) | Yes, automated |
| Android Chrome (Pixel 7 emulation) | Emulated only |
| iPhone Safari / iPad | **Not tested** (no WebKit or devices here) |
| macOS Safari | **Not tested** |
| Firefox | **Not tested** |
| Installed PWA | **Not tested** |
| Physical devices of any kind | **Not tested** |

## Known limitations

- Ride physics follows the track centre line, not the heartline; couplings are rigid; no static friction. See `docs/physics.md`.
- Inverted and near-vertical sections have no ground supports.
- Flex is not applied to shadow maps (shadows stay rigid; the difference is millimetres to centimetres).
- Removing a piece removes the last node, not the whole last element.
- Biome changes regenerate distant chunks over a few seconds; far terrain briefly shows the previous biome.
- Audio is untuned; the (Not Boring) Sound Kit is not used (licence unverified).
- No haptics on iOS (no web API); `navigator.vibrate` is used where available.
- WebGPU not evaluated.
- Mobile overview draw calls (~187) exceed the 150 target.
- IndexedDB code paths other than validation are covered only by the Chromium e2e reload test.
