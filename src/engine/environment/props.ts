import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from '../terrain/noise';

/**
 * Procedurally modelled props with baked vertex colours. Every prop is a single merged
 * BufferGeometry so it can be drawn with one InstancedMesh. Vertex attribute `aSway`
 * (0 at the base, 1 at the tips) drives gentle wind motion in the foliage shader.
 */

type Geo = THREE.BufferGeometry;

function prep(g: Geo, colour: THREE.ColorRepresentation, sway: number | ((y: number) => number), jitter = 0, seed = 1, smooth = true): Geo {
  // Weld coincident vertices so normals are smooth (soft, sculpted look rather than facets).
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  let geo: Geo;
  if (smooth) {
    if (g.getAttribute('normal')) g.deleteAttribute('normal');
    const welded = mergeVertices(g, 1e-4);
    welded.computeVertexNormals();
    geo = welded.toNonIndexed();
  } else {
    geo = g.index ? g.toNonIndexed() : g;
    geo.computeVertexNormals();
  }
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const sw = new Float32Array(n);
  const c = new THREE.Color(colour);
  const rnd = mulberry32(seed);
  // Painter's gradient for foliage: warm, light tops and cool, deeper undersides.
  const leafy = sway !== 0 && typeof sway === 'function';
  geo.computeBoundingBox();
  const y0 = geo.boundingBox!.min.y;
  const y1 = geo.boundingBox!.max.y;
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    const v = 1 + (rnd() - 0.5) * jitter;
    let r = c.r * v;
    let g = c.g * v;
    let b = c.b * v;
    if (leafy && y1 > y0) {
      const t = (y - y0) / (y1 - y0);
      const warm = 0.8 + t * 0.38;
      r *= warm * (1 + t * 0.12);
      g *= warm;
      b *= warm * (1.18 - t * 0.35);
    }
    col[i * 3] = r;
    col[i * 3 + 1] = g;
    col[i * 3 + 2] = b;
    sw[i] = typeof sway === 'function' ? sway(y) : sway;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  return geo;
}

/** Push vertices outwards by smooth noise for organic, hand-shaped blobs. */
function lumpy(g: Geo, amount: number, seed: number): Geo {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const a = rnd() * 10;
  const b = rnd() * 10;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + amount * (Math.sin(v.x * 2.1 + a) * Math.sin(v.y * 1.7 + b) * Math.sin(v.z * 2.3 + a * b));
    pos.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}

const swayAbove = (y0: number, h: number) => (y: number) => Math.max(0, Math.min(1, (y - y0) / h));

export function pineGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  const parts: Geo[] = [];
  parts.push(prep(new THREE.CylinderGeometry(0.16, 0.24, 2.2, 7).translate(0, 1.1, 0), '#6E5444', 0));
  const tiers = [
    { y: 1.6, r: 2.0, h: 3.0 },
    { y: 3.2, r: 1.6, h: 2.6 },
    { y: 4.6, r: 1.15, h: 2.2 },
    { y: 5.8, r: 0.7, h: 1.6 },
  ];
  tiers.forEach((t, i) => {
    // Lathe profile: soft rounded skirt rather than a hard cone.
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      const r = t.r * (1 - u) ** 0.9 * (1 - 0.18 * Math.sin(Math.PI * u * 0.5)) + 0.02;
      pts.push(new THREE.Vector2(r, u * t.h - (k === 0 ? 0.25 : 0)));
    }
    pts.unshift(new THREE.Vector2(0.01, -0.3));
    const g = new THREE.LatheGeometry(pts, 9).translate(0, t.y, 0);
    lumpy(g, 0.06, 11 + i);
    const c = foliage.clone().lerp(foliageAlt, i / tiers.length);
    parts.push(prep(g, c, swayAbove(1.2, 6), 0.08, 3 + i));
  });
  return mergeGeometries(parts)!;
}

export function oakGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  const parts: Geo[] = [];
  parts.push(prep(new THREE.CylinderGeometry(0.22, 0.34, 2.6, 7).translate(0, 1.3, 0), '#765B48', 0));
  parts.push(prep(new THREE.CylinderGeometry(0.08, 0.14, 1.4, 5).rotateZ(0.7).translate(0.5, 2.6, 0), '#765B48', 0.2));
  const blobs = [
    [0, 3.9, 0, 1.9],
    [1.1, 3.4, 0.4, 1.3],
    [-1.0, 3.5, -0.3, 1.35],
    [0.2, 3.6, -1.0, 1.25],
    [-0.2, 4.8, 0.3, 1.2],
  ] as const;
  blobs.forEach(([x, y, z, r], i) => {
    const g = new THREE.IcosahedronGeometry(r, 3).scale(1, 0.85, 1).translate(x, y, z);
    lumpy(g, 0.08, 21 + i);
    parts.push(prep(g, foliage.clone().lerp(foliageAlt, (i % 3) / 3), swayAbove(2.2, 4), 0.1, 7 + i));
  });
  return mergeGeometries(parts)!;
}

export function birchGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  const parts: Geo[] = [];
  parts.push(prep(new THREE.CylinderGeometry(0.1, 0.15, 4.2, 6).translate(0, 2.1, 0), '#EDE7DC', 0.05, 0.12, 4));
  const g = new THREE.IcosahedronGeometry(1.1, 3).scale(0.85, 1.6, 0.85).translate(0, 4.6, 0);
  lumpy(g, 0.1, 31);
  parts.push(prep(g, foliageAlt.clone().lerp(foliage, 0.3), swayAbove(3, 3), 0.1, 9));
  return mergeGeometries(parts)!;
}

export function bushGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  const parts: Geo[] = [];
  const blobs = [
    [0, 0.5, 0, 0.75],
    [0.55, 0.4, 0.2, 0.55],
    [-0.5, 0.4, -0.15, 0.6],
  ] as const;
  blobs.forEach(([x, y, z, r], i) => {
    const g = new THREE.IcosahedronGeometry(r, 2).scale(1, 0.8, 1).translate(x, y, z);
    lumpy(g, 0.1, 41 + i);
    parts.push(prep(g, foliage.clone().lerp(foliageAlt, i * 0.35), swayAbove(0.1, 1), 0.12, 13 + i));
  });
  return mergeGeometries(parts)!;
}

export function rockGeometry(): Geo {
  const g = new THREE.DodecahedronGeometry(0.9, 1).scale(1.3, 0.7, 1);
  lumpy(g, 0.18, 51);
  return prep(g.translate(0, 0.3, 0), '#A29C90', 0, 0.12, 17, false);
}

export function flowerGeometry(): Geo {
  const parts: Geo[] = [];
  const rnd = mulberry32(61);
  const colours = ['#F3E7D8', '#E5C579', '#D99A8B', '#B9A6C9', '#F0D36E'];
  for (let i = 0; i < 7; i++) {
    const x = (rnd() - 0.5) * 0.9;
    const z = (rnd() - 0.5) * 0.9;
    const h = 0.25 + rnd() * 0.25;
    parts.push(prep(new THREE.CylinderGeometry(0.012, 0.015, h, 3).translate(x, h / 2, z), '#6E8F5E', swayAbove(0, h)));
    parts.push(prep(new THREE.IcosahedronGeometry(0.06 + rnd() * 0.03, 0).translate(x, h, z), colours[i % colours.length]!, 1));
  }
  return mergeGeometries(parts)!;
}

export function grassGeometry(): Geo {
  const parts: Geo[] = [];
  const rnd = mulberry32(71);
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2;
    const h = 0.25 + rnd() * 0.35;
    const blade = new THREE.ConeGeometry(0.035, h, 3, 1, true).translate(0, h / 2, 0).rotateZ((rnd() - 0.5) * 0.5).rotateY(a);
    blade.translate(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15);
    parts.push(prep(blade, rnd() > 0.5 ? '#8DA36C' : '#9FB27C', swayAbove(0, 0.5)));
  }
  return mergeGeometries(parts)!;
}

export function benchGeometry(): Geo {
  const parts: Geo[] = [];
  for (let i = 0; i < 3; i++) parts.push(prep(new RoundedBoxGeometry(1.6, 0.05, 0.12, 2, 0.02).translate(0, 0.45, -0.15 + i * 0.15), '#B28761', 0));
  for (let i = 0; i < 2; i++) parts.push(prep(new RoundedBoxGeometry(1.6, 0.1, 0.04, 2, 0.02).translate(0, 0.75 + i * 0.14, -0.27), '#B28761', 0));
  for (const x of [-0.7, 0.7]) parts.push(prep(new RoundedBoxGeometry(0.06, 0.9, 0.5, 2, 0.02).translate(x, 0.45, -0.05), '#343C37', 0));
  return mergeGeometries(parts)!;
}

export function lanternGeometry(): Geo {
  const parts: Geo[] = [];
  parts.push(prep(new THREE.CylinderGeometry(0.05, 0.07, 2.2, 8).translate(0, 1.1, 0), '#343C37', 0));
  parts.push(prep(new RoundedBoxGeometry(0.3, 0.4, 0.3, 2, 0.04).translate(0, 2.35, 0), '#343C37', 0));
  parts.push(prep(new THREE.ConeGeometry(0.26, 0.2, 4).rotateY(Math.PI / 4).translate(0, 2.65, 0), '#343C37', 0));
  return mergeGeometries(parts)!;
}

/** The glowing core of a lantern, rendered with an emissive material. */
export function lanternGlowGeometry(): Geo {
  return prep(new THREE.BoxGeometry(0.22, 0.3, 0.22).translate(0, 2.35, 0), '#FFE2A8', 0);
}

export function fenceGeometry(): Geo {
  const parts: Geo[] = [];
  for (const x of [-1, 0, 1]) parts.push(prep(new RoundedBoxGeometry(0.1, 0.9, 0.1, 2, 0.02).translate(x, 0.45, 0), '#C9A47E', 0));
  for (const y of [0.35, 0.7]) parts.push(prep(new RoundedBoxGeometry(2.1, 0.08, 0.05, 2, 0.02).translate(0, y, 0), '#C9A47E', 0));
  return mergeGeometries(parts)!;
}

export function signGeometry(): Geo {
  const parts: Geo[] = [];
  for (const x of [-0.6, 0.6]) parts.push(prep(new RoundedBoxGeometry(0.08, 1.7, 0.08, 2, 0.02).translate(x, 0.85, 0), '#765B48', 0));
  parts.push(prep(new RoundedBoxGeometry(1.6, 0.6, 0.08, 2, 0.04).translate(0, 1.5, 0.02), '#F5EBDD', 0));
  parts.push(prep(new RoundedBoxGeometry(1.7, 0.08, 0.12, 2, 0.03).translate(0, 1.84, 0.02), '#C77D62', 0));
  return mergeGeometries(parts)!;
}

export function hutGeometry(): Geo {
  const parts: Geo[] = [];
  parts.push(prep(new RoundedBoxGeometry(3, 2.2, 2.6, 2, 0.08).translate(0, 1.1, 0), '#E9DCC6', 0, 0.04, 81));
  const roof = new THREE.CylinderGeometry(0.01, 2.4, 1.5, 4, 1).rotateY(Math.PI / 4).scale(1.05, 1, 0.95).translate(0, 2.95, 0);
  parts.push(prep(roof, '#C77D62', 0, 0.06, 82));
  parts.push(prep(new RoundedBoxGeometry(0.8, 1.4, 0.06, 2, 0.03).translate(0, 0.7, 1.31), '#765B48', 0));
  parts.push(prep(new RoundedBoxGeometry(0.6, 0.5, 0.06, 2, 0.03).translate(-0.95, 1.3, 1.31), '#8DAABB', 0));
  return mergeGeometries(parts)!;
}

/**
 * Standard material with wind sway in the vertex shader. Shared by all vegetation; `uTime`
 * and `uWind` are updated once per frame by the engine.
 */
export function foliageMaterial(uniforms: { uTime: { value: number }; uWind: { value: number } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 ip = vec3(0.0);
#endif
float ph = ip.x * 0.11 + ip.z * 0.07;
float sw = aSway * aSway * uWind;
transformed.x += sin(uTime * 1.3 + ph) * 0.12 * sw + sin(uTime * 3.1 + ph * 2.0 + position.y) * 0.03 * sw;
transformed.z += cos(uTime * 1.1 + ph * 1.3) * 0.09 * sw;`,
      );
  };
  m.customProgramCacheKey = () => 'foliage-sway';
  return m;
}
