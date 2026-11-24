# Asset licensing register

| Asset | Source | Licence | Notes |
|---|---|---|---|
| All 3D models (carriages, trees, rocks, props, station) | Generated in code in this repository | Project licence | `src/engine/environment/props.ts`, `train/train-model.ts`, `environment/station.ts` |
| Terrain, vegetation placement, sky, water, weather | Procedural, this repository | Project licence | |
| All audio, including the lo-fi music | Synthesised at runtime, this repository | Project licence | No audio files or samples are shipped |
| Icons (UI) | Hand-written SVG paths, this repository | Project licence | `src/design-system/Icon.tsx` |
| App icon | `public/icons/icon.svg`, this repository | Project licence | PNGs rendered by `scripts/icons.cjs` |
| Fonts | None shipped; system UI font stack | n/a | |
| three | npm | MIT | Runtime dependency |
| react, react-dom | npm | MIT | Runtime dependency |
| zustand | npm | MIT | Runtime dependency |

Not used: the (Not Boring) Sound Kit (licence not verified; see `docs/audio-design.md`). No third-party proprietary assets, branding or artwork are included.
