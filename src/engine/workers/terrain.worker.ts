/// <reference lib="webworker" />
import { generateChunk, type ChunkRequest } from '../terrain/chunk-gen';
import { Heightfield } from '../terrain/heightfield';

/**
 * Terrain generation worker. Receives chunk requests, returns geometry buffers as transferables
 * so no large arrays are copied back to the main thread.
 */
let field: Heightfield | null = null;

self.onmessage = (ev: MessageEvent<ChunkRequest>) => {
  const req = ev.data;
  try {
    if (!field || field.biome !== req.biome || field.seed !== req.seed) field = new Heightfield(req.biome, req.seed);
    const data = generateChunk(req, field);
    (self as unknown as Worker).postMessage({ ok: true, data }, [
      data.positions.buffer,
      data.normals.buffer,
      data.colors.buffer,
      data.index.buffer,
      data.vegetation.buffer,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, rev: req.rev, cx: req.cx, cz: req.cz, error: String(err) });
  }
};
