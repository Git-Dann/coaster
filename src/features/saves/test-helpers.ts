/** Test fixtures for the saves feature. Not imported by app code. */
import type { TrackNode } from '../../engine/track/types';
import type { SaveData } from '../../types/world';

/** A realistic, valid schema-1 save. Pass overrides to tweak top-level fields. */
export function makeTestSave(overrides: Partial<SaveData> = {}): SaveData {
  const nodes: TrackNode[] = [];
  const count = 24;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    nodes.push({
      id: `node-${i}`,
      p: [Math.cos(a) * 30, 4 + (i === 6 ? 18 : 0), Math.sin(a) * 30],
      dir: [-Math.sin(a) + 0, 0, Math.cos(a)], // + 0 avoids -0, which JSON cannot round-trip
      bank: i > 10 && i < 14 ? 0.4 : 0,
      kind: i === 0 ? 'station' : i < 5 ? 'lift' : i === 20 ? 'brake' : 'track',
      ...(i < 5 && i > 0 ? { param: 3.5 } : {}),
      ...(i === 8 ? { tension: 1.2 } : {}),
    });
  }
  return {
    schema: 1,
    id: '6f1c2c1e-7a4b-4f3e-9d0c-1b2a3c4d5e6f',
    name: 'Sunny Meadow',
    created: 1_760_000_000_000,
    updated: 1_760_000_500_000,
    coasterName: 'The Bumblebee',
    environment: { biome: 'meadow', seed: 12345, weather: 'clear', time: 'golden', autoCycle: false, environmentalPhysics: false },
    track: {
      nodes,
      closed: true,
      style: 'wood',
      supportStyle: 'pine',
      colours: { rail: '#aa3322', spine: '#553311', sleeper: '#886644', support: '#ccaa66' },
    },
    train: {
      cars: 4,
      style: 'timber',
      colours: { primary: '#c0392b', secondary: '#f3e9d2', seat: '#3b2f2a', trim: '#d4a64a', wheels: '#2b2b2b' },
      finish: 'gloss',
    },
    physics: { rollingCoeff: 0.005, dwell: 6 },
    scenery: [
      { id: 's-1', type: 'oak', p: [10, 0, 12], rot: 0.5, scale: 1.2 },
      { id: 's-2', type: 'bench', p: [-4, 0, 8], rot: 1.1, scale: 1 },
    ],
    terrainEdits: [
      { mode: 'raise', x: 5, z: 5, radius: 6, strength: 1.5 },
      { mode: 'paint-path', x: 0, z: 0, radius: 2, strength: 0.8 },
    ],
    camera: { target: [0, 5, 0], distance: 60, yaw: 0.8, pitch: 0.4 },
    thumbnail: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U',
    ...overrides,
  };
}

/** Deep clone through JSON, returning a mutable untyped record for corruption tests. */
export function cloneLoose(save: SaveData): Record<string, unknown> {
  return JSON.parse(JSON.stringify(save)) as Record<string, unknown>;
}
