# Art direction

A painted wooden miniature meets a premium architectural model: soft, warm, readable, hand-finished.

## Palette tokens

| Token | Hex | Use |
|---|---|---|
| Warm cream | `#F5EBDD` | UI surfaces, steel supports, station trim |
| Meadow green | `#A8B58B` | Grass, UI accents |
| Forest green | `#55745B` | Foliage, toggles, industrial steel |
| Dusty blue | `#8DAABB` | Water, default train, height handle |
| Terracotta | `#C77D62` | Rails, roofs, primary actions |
| Butter yellow | `#E5C579` | Sun, trim, handle glow |
| Walnut | `#765B48` | Timber, sleepers, trunks |
| Soft charcoal | `#343C37` | Text, seats, active states |

These are starting tokens, not a rule for every object. Biomes extend them (see `BIOME_CONFIG` in `src/engine/terrain/heightfield.ts`).

## Principles

- **Rounded and bevelled**: rounded boxes, lathe-profiled pines, welded smooth-shaded foliage blobs. Rocks stay faceted for a chiselled feel.
- **Matte painted surfaces** with a subtle world-space mottling (`addPaintedVariation`) instead of textures.
- **Light does the work**: warm keyed sun, hemisphere sky/ground fill, soft PCF shadows, ACES tone mapping, exponential fog matched to the horizon colour for atmospheric perspective. No bloom or heavy post-processing.
- **Composition**: the starter scene frames station, lift and drop with the meadow and woodland behind.
- **No people**: carriages have empty seats and restraints only.

## Time of day and weather

Keyframed sky (zenith/horizon), sun colour/intensity, hemisphere colours and fog for 0–24 h, blended smoothly. Weather modifies cloud cover, sun strength, saturation, fog density and ground wetness. All purely cosmetic unless environmental physics is switched on.

## Known gaps

- Models are procedural and code-built. They are deliberately soft and coherent, but a production release would benefit from hand-modelled glTF carriages and station kits (see `docs/status.md`).
- No ambient occlusion pass; contact shadows rely on the shadow map.
- Tunnels are marked in data but not yet rendered with a shell.
