import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BakedTrack } from './bake';
import { buildTrackGeometry, type GeometryBuffers } from './track-geometry';
import type { TrackColours, TrackStyle } from './types';
import { injectFlex, type FlexUniforms } from '../physics/flex';

/**
 * Track material: one draw call for rails, spine, sleepers and section details. Each vertex
 * carries a `aPart` index; colours come from a uniform array so recolouring never rebuilds geometry.
 */
export function trackMaterial(opts: { preview?: boolean } = {}): THREE.MeshStandardMaterial & { userData: { colours: THREE.Color[] } } {
  const colours = [new THREE.Color('#C77D62'), new THREE.Color('#C77D62'), new THREE.Color('#765B48'), new THREE.Color('#3B3F3B'), new THREE.Color('#B9BDBA')];
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.5,
    metalness: 0.12,
    transparent: !!opts.preview,
    // The edit-mode ghost: a soft glowing sky blue that reads clearly against grass, sky and track.
    opacity: opts.preview ? 0.78 : 1,
    depthWrite: !opts.preview,
    emissive: opts.preview ? new THREE.Color('#2f6f9f') : new THREE.Color('#000000'),
    emissiveIntensity: opts.preview ? 0.55 : 0,
  }) as THREE.MeshStandardMaterial & { userData: { colours: THREE.Color[] } };
  mat.userData.colours = colours;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uParts = { value: colours };
    shader.uniforms.uPreview = { value: opts.preview ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nuniform vec3 uParts[5];\nvarying vec3 vPartColor;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPartColor = uParts[int(aPart + 0.5)];');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPartColor;\nuniform float uPreview;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb *= vPartColor;
if (uPreview > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.8, 0.98), 0.8);`,
      );
  };
  mat.customProgramCacheKey = () => (opts.preview ? 'track-preview' : 'track');
  return mat;
}

function toGeometry(b: GeometryBuffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(b.part, 1));
  g.setIndex(new THREE.BufferAttribute(b.index, 1));
  return g;
}

/** Cheap fingerprint of a segment's baked geometry so unchanged segments are reused. */
function segmentHash(track: BakedTrack, s0: number, s1: number, style: string): string {
  let h = 0;
  const i0 = Math.floor(s0 / track.ds);
  const i1 = Math.min(track.count - 1, Math.ceil(s1 / track.ds));
  for (let i = i0; i <= i1; i += 3) {
    h = (h * 31 + Math.round(track.pos[i * 3]! * 100) + Math.round(track.pos[i * 3 + 1]! * 100) * 7 + Math.round(track.pos[i * 3 + 2]! * 100) * 13) | 0;
    h = (h * 31 + Math.round(track.up[i * 3]! * 1000) + Math.round(track.up[i * 3 + 1]! * 1000) * 3 + track.kind[i]! * 17) | 0;
  }
  return `${style}:${(s1 - s0).toFixed(3)}:${h}`;
}

/**
 * Renders a baked track. Geometry is generated per design segment and cached by fingerprint,
 * so an edit only regenerates the segments it actually changed; the cached pieces are then
 * merged into one mesh for a single draw call.
 */
export class TrackRenderer {
  readonly mesh: THREE.Mesh;
  readonly material: ReturnType<typeof trackMaterial>;
  private cache = new Map<string, THREE.BufferGeometry>();
  origin = new THREE.Vector3();
  lastRegenerated = 0;

  constructor(preview = false) {
    this.material = trackMaterial({ preview });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.castShadow = !preview;
    this.mesh.receiveShadow = !preview;
    this.mesh.frustumCulled = false;
    this.mesh.name = preview ? 'track-preview' : 'track';
  }

  /** Let the track bend with the structure (committed track only). */
  enableFlex(u: FlexUniforms): void {
    const prev = this.material.onBeforeCompile;
    this.material.onBeforeCompile = (shader, rr) => {
      prev.call(this.material, shader, rr);
      injectFlex(shader, u, 0);
    };
    this.material.customProgramCacheKey = () => 'track-flex';
    this.material.needsUpdate = true;
  }

  setColours(c: TrackColours, style: TrackStyle): void {
    const cols = this.material.userData.colours;
    cols[0]!.set(c.rail);
    cols[1]!.set(style === 'wood' ? c.sleeper : c.spine);
    cols[2]!.set(c.sleeper);
    this.material.roughness = style === 'wood' ? 0.85 : 0.45;
    this.material.metalness = style === 'wood' || style === 'mine' ? 0.05 : 0.15;
  }

  update(track: BakedTrack | null, style: TrackStyle, fromS = 0, toS = Infinity): void {
    if (!track || track.count < 2) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    // Anchor geometry near the first node for float32 precision.
    this.origin.set(Math.round(track.pos[0]! / 64) * 64, 0, Math.round(track.pos[2]! / 64) * 64);
    const o = [this.origin.x, this.origin.y, this.origin.z];
    const nodeS = track.nodeS;
    const segCount = track.closed ? nodeS.length : nodeS.length - 1;
    const next = new Map<string, THREE.BufferGeometry>();
    const parts: THREE.BufferGeometry[] = [];
    let regenerated = 0;
    for (let i = 0; i < segCount; i++) {
      const s0 = nodeS[i]!;
      const s1 = i + 1 < nodeS.length ? nodeS[i + 1]! : track.length;
      if (s1 <= fromS || s0 >= toS - 1e-6) continue;
      const key = `${segmentHash(track, s0, s1, style)}@${o.join(',')}`;
      let g = this.cache.get(key) ?? next.get(key);
      if (!g) {
        g = toGeometry(buildTrackGeometry(track, style, Math.max(s0, fromS), s1, o));
        regenerated++;
      }
      next.set(key, g);
      parts.push(g);
    }
    for (const [k, g] of this.cache) if (!next.has(k)) g.dispose();
    this.cache = next;
    this.lastRegenerated = regenerated;
    const merged = parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry();
    this.mesh.geometry.dispose();
    this.mesh.geometry = merged ?? new THREE.BufferGeometry();
    this.mesh.position.copy(this.origin);
  }

  dispose(): void {
    for (const g of this.cache.values()) g.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
