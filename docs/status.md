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
- Biome changes regenerate distant chunks over a few seconds; far terrain briefly shows the previous biome.
- Audio, including the generative lo-fi music, has not yet been tuned by ear on real devices. The (Not Boring) Sound Kit is not used (licence unverified).
- No haptics on iOS (no web API); `navigator.vibrate` is used where available.
- WebGPU not evaluated.
- Mobile overview draw calls (~187) exceed the 150 target.
- IndexedDB code paths other than validation are covered only by the Chromium e2e reload test.

## Build model (since the touch-first rework)

- **Adding pieces:** tap a piece to add it straight away. The newest piece stays adjustable with the end ring, the height lever and the size buttons until another piece is added; adjusting it is the same undo step as adding it.
- **Never disconnected:** an automatic return (a Dubins path with eased height, ground clearance, speed-matched banking and a brake run) always carries the train back into the station, so the circuit can never be left disconnected. A seeded fuzz test builds 40 random layouts and checks every circuit closes cleanly and simulates without errors.
- **Removing:** "Remove last" removes the whole last piece. The station can't be removed.
- **Carriages:** they can be changed at any time; the train simply returns to the station.
- **No clashes, ever (track):** wherever two parts of the coaster come within 2.6 m in plan view (and are more than 30 m apart along the circuit), the newer part is kept at least 5.5 m above or below the other, rail to rail (`src/engine/track/clearance.ts`). Simple track and the automatic return are smoothly lifted over (or dropped under, if there is room above the ground) with a gentle ramp. Loops, rolls, spirals, lifts and drops are never bent: a ramp in front raises the whole element clear, as part of the same piece. Spirals always rise at least 6.1 m per turn. Earlier track is never moved.
- **No clashes, ever (scaffolding):** every support member is checked against a train-sized envelope around all track (1.5 m either side of the centre, 1.0 m below to 2.4 m above rail level, in the track's own frame). A clashing brace is left out; a clashing post, column or footing removes that support, and a wide timber bent first falls back to a narrow two-post bent. Near the track a support carries, members may reach the spine but never above it.
- **Banking after rolls:** pieces and the automatic return keep the bank on the same winding after a roll, so they never unwind whole turns as a hidden twist.
- **Tests:** the 40-layout fuzz test asserts no track clash and a bounded twist rate; `support-clearance.test.ts` independently brute-forces every support member against every track sample for the starter (timber and steel) and six random layouts.
- **Height lever:** on plain track, steep requests become longer ramps (about 19° on average, under 30° at the steepest). Going down stops above the ground; drops and spirals descend only as far as the ground allows (a drop at ground level climbs a little first). The lever always shows the real height.
- **Automatic return:** it tries wider paths when lifting alone can't clear your track (for example when it would have to pass through a loop), and drops near-coincident points that used to make it spike upwards.
- **Camera:** the interface tells the engine which parts of the screen it covers; overview cameras centre their aim in the clear area, follow the newest piece as it's added, adjusted or removed, and thin the haze when pulled far back. Leaving relax mode returns to an overview of the coaster.
- **Ride sheet:** Ride!, Watch and Back seat put the sheet away; closing the sheet never ends a ride.
- **Playtesting:** a scripted playtest presses every control on phone, desktop and landscape layouts and audits the track (closed, no clashes, above ground, no sudden twists) and the interface (on screen, tappable, not covered, not cut off, newest piece visible) after each step.
- **Known gaps:** the automatic return goes over or under your track rather than routing around it, so it can climb noticeably on busy layouts. Where a support is removed to keep clear of other track, the neighbouring supports carry the span (no special bridging structure). The full-screen background under Safari's bars has been checked in desktop Chromium only, not on a real iPhone.
