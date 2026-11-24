import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from '../terrain/noise';
import { paintedBandsShader } from '../renderer/materials';

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

// ---------------------------------------------------------------- painterly vegetation helpers

/** Cheap deterministic 3D value noise for pigment dabs. */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

type ColourAt = (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void;

/**
 * Weld, smooth and colour a geometry with a per-vertex pigment function. Used for foliage so
 * colour falls in patchy dabs (as a painter would lay it) rather than smooth CG gradients.
 */
function painted(g: Geo, colourAt: ColourAt, sway: (y: number) => number, smooth = true): Geo {
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
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const sw = new Float32Array(pos.count);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    colourAt(p, n, c);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    sw[i] = sway(p.y);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  return geo;
}

/** A four-step foliage ramp (shadow → mid → light → highlight) derived from biome colours. */
function foliageRamp(foliage: THREE.Color, foliageAlt: THREE.Color): THREE.Color[] {
  // Watercolour temperature split: shadows lean blue-green, lights lean yellow-green.
  const shadow = foliage.clone().multiplyScalar(0.5).lerp(new THREE.Color('#2F4A55'), 0.35);
  const mid = foliage.clone().multiplyScalar(0.9);
  const light = foliage.clone().lerp(foliageAlt, 0.8).lerp(new THREE.Color('#B9C266'), 0.2);
  const high = foliageAlt.clone().multiplyScalar(1.15).lerp(new THREE.Color('#E3D77E'), 0.35);
  return [shadow, mid, light, high];
}

function rampAt(ramp: THREE.Color[], t: number, out: THREE.Color): THREE.Color {
  const x = Math.min(0.999, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.floor(x);
  return out.copy(ramp[i]!).lerp(ramp[i + 1]!, x - i);
}

/**
 * Foliage pigment: light depends on how much a surface faces the sun side and how high it sits,
 * then is broken into soft dabs by noise and gently stepped, like layered washes.
 */
function foliagePaint(ramp: THREE.Color[], y0: number, y1: number, seed: number, dabScale = 1.6): ColourAt {
  return (p, n, out) => {
    const h = (p.y - y0) / Math.max(0.01, y1 - y0);
    const sun = n.y * 0.45 + (n.x * 0.35 + n.z * 0.2) * 0.5;
    const dab = noise3(p.x * dabScale + seed, p.y * dabScale, p.z * dabScale - seed) - 0.5;
    let t = 0.22 + sun * 0.6 + h * 0.35 + dab * 0.8;
    // Soft quantisation into washes.
    const q = t * 4;
    t = (Math.floor(q) + smoothstepJs(0.25, 0.75, q - Math.floor(q))) / 4;
    rampAt(ramp, t, out);
  };
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** An irregular leaf clump. */
function clump(x: number, y: number, z: number, r: number, seed: number, squash = 0.8): Geo {
  const g = new THREE.IcosahedronGeometry(r, 2).scale(1, squash, 1);
  lumpy(g, 0.22, seed);
  return g.translate(x, y, z);
}

/** Leaf clumps scattered over an ellipsoid crown, flattened underneath, plus a core to fill gaps. */
function crown(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, count: number, size: number, seed: number): Geo[] {
  const rnd = mulberry32(seed);
  const out: Geo[] = [clump(cx, cy, cz, Math.min(rx, ry, rz) * 0.85, seed + 1, 0.85)];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const yN = 1 - ((i + 0.5) / count) * 1.55; // top to slightly below the equator
    const rad = Math.sqrt(Math.max(0, 1 - yN * yN));
    const th = i * golden + rnd() * 0.6;
    const j = 0.82 + rnd() * 0.22;
    out.push(clump(cx + Math.cos(th) * rad * rx * j, cy + yN * ry * j, cz + Math.sin(th) * rad * rz * j, size * (0.7 + rnd() * 0.55), seed + 10 + i, 0.72 + rnd() * 0.2));
  }
  return out;
}

/** Tapered trunk with a slight lean and an optional fork into the crown. */
function trunk(height: number, r0: number, r1: number, colour: string, forks: number, seed: number): Geo[] {
  const rnd = mulberry32(seed);
  const c = new THREE.Color(colour);
  const cool = c.clone().multiplyScalar(0.7);
  cool.b *= 1.2;
  const paint: ColourAt = (p, n, out) => {
    out.copy(cool).lerp(c, Math.min(1, Math.max(0, 0.45 + n.x * 0.3 + n.z * 0.2 + p.y * 0.05)));
  };
  const parts = [painted(new THREE.CylinderGeometry(r1, r0, height, 7, 3).translate(0, height / 2, 0), paint, () => 0)];
  for (let i = 0; i < forks; i++) {
    const a = rnd() * Math.PI * 2;
    const len = height * (0.35 + rnd() * 0.2);
    const b = new THREE.CylinderGeometry(r1 * 0.35, r1 * 0.7, len, 5).translate(0, len / 2, 0).rotateZ(0.55 + rnd() * 0.3).rotateY(a).translate(0, height * (0.65 + rnd() * 0.2), 0);
    parts.push(painted(b, paint, () => 0.15));
  }
  return parts;
}

export function pineGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  const parts: Geo[] = trunk(2.4, 0.26, 0.15, '#6A4E3E', 0, 1);
  // Pines are cooler and deeper than broadleaves.
  const deep = foliage.clone().multiplyScalar(0.85);
  deep.b *= 1.12;
  const ramp = foliageRamp(deep, foliage.clone().lerp(foliageAlt, 0.5));
  const tiers = [
    { y: 1.5, r: 2.2, h: 2.6 },
    { y: 2.9, r: 1.85, h: 2.3 },
    { y: 4.1, r: 1.45, h: 2.0 },
    { y: 5.2, r: 1.05, h: 1.7 },
    { y: 6.15, r: 0.62, h: 1.4 },
  ];
  tiers.forEach((t, i) => {
    const pts: THREE.Vector2[] = [new THREE.Vector2(0.01, -0.15)];
    for (let k = 0; k <= 6; k++) {
      const u = k / 6;
      pts.push(new THREE.Vector2(t.r * (1 - u) ** 1.15 + 0.02, u * t.h));
    }
    const g = new THREE.LatheGeometry(pts, 14).translate(0, t.y, 0);
    // Jagged, drooping branch tips around each skirt.
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      const rr = Math.hypot(v.x, v.z);
      if (rr < 0.05) continue;
      const a = Math.atan2(v.z, v.x);
      const edge = rr / t.r;
      const jag = 1 + (0.2 * Math.sin(a * 7 + i * 1.7) + 0.09 * Math.sin(a * 13 + i)) * edge;
      v.x *= jag;
      v.z *= jag;
      v.y -= edge * edge * 0.32;
      pos.setXYZ(k, v.x, v.y, v.z);
    }
    const tierSeed = 5 + i * 3;
    parts.push(
      painted(
        g,
        (p, n, out) => {
          const rr = Math.hypot(p.x, p.z) / t.r;
          const dab = noise3(p.x * 1.8 + tierSeed, p.y * 1.8, p.z * 1.8) - 0.5;
          let tt = 0.15 + rr * 0.35 + n.y * 0.25 + (n.x * 0.3 + n.z * 0.15) * 0.4 + dab * 0.5 + i * 0.05;
          const q = tt * 4;
          tt = (Math.floor(q) + smoothstepJs(0.25, 0.75, q - Math.floor(q))) / 4;
          rampAt(ramp, tt, out);
        },
        swayAbove(1.2, 6),
      ),
    );
  });
  return mergeGeometries(parts)!;
}

export function oakGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  const parts: Geo[] = trunk(2.8, 0.36, 0.2, '#6E5040', 3, 2);
  const ramp = foliageRamp(foliage, foliageAlt);
  const leaves = mergeGeometries(crown(0, 4.1, 0, 2.3, 1.55, 2.2, 11, 1.05, 21))!;
  parts.push(painted(leaves, foliagePaint(ramp, 2.4, 5.8, 3), swayAbove(2.2, 4)));
  return mergeGeometries(parts)!;
}

export function birchGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  // White bark with dark lenticel dashes.
  const bark = new THREE.CylinderGeometry(0.09, 0.15, 4.6, 7, 12).translate(0, 2.3, 0);
  const parts: Geo[] = [
    painted(
      bark,
      (p, n, out) => {
        const a = Math.floor(((Math.atan2(p.z, p.x) + Math.PI) / (Math.PI * 2)) * 5);
        const mark = hash3(Math.floor(p.y * 3.2), a, 7) > 0.72;
        out.set(mark ? '#4A433E' : '#EEE8DC');
        if (!mark) out.multiplyScalar(0.82 + Math.max(0, n.x * 0.12 + n.z * 0.06));
      },
      () => 0,
      false,
    ),
  ];
  const light = foliageAlt.clone().lerp(new THREE.Color('#C9D27A'), 0.25);
  const ramp = foliageRamp(foliage.clone().lerp(light, 0.5), light);
  const clumps: Geo[] = [];
  const rnd = mulberry32(33);
  for (let i = 0; i < 7; i++) {
    const a = i * 2.4;
    const y = 3.0 + (i / 7) * 2.4;
    const r = 0.75 - (i / 7) * 0.35;
    clumps.push(clump(Math.cos(a) * r, y, Math.sin(a) * r, 0.5 + rnd() * 0.25, 40 + i, 0.85));
  }
  parts.push(painted(mergeGeometries(clumps)!, foliagePaint(ramp, 2.6, 5.8, 9, 2.2), swayAbove(2.6, 3)));
  return mergeGeometries(parts)!;
}

export function bushGeometry(foliage: THREE.Color, foliageAlt: THREE.Color): Geo {
  const ramp = foliageRamp(foliage, foliageAlt);
  const rnd = mulberry32(41);
  const clumps: Geo[] = [clump(0, 0.45, 0, 0.55, 41, 0.75)];
  for (let i = 0; i < 5; i++) {
    const a = i * 1.25 + rnd();
    const r = 0.45 + rnd() * 0.25;
    clumps.push(clump(Math.cos(a) * r, 0.3 + rnd() * 0.35, Math.sin(a) * r, 0.3 + rnd() * 0.18, 50 + i, 0.75));
  }
  return painted(mergeGeometries(clumps)!, foliagePaint(ramp, 0, 1.1, 13, 2.4), swayAbove(0.1, 1));
}

export function rockGeometry(): Geo {
  const g = new THREE.DodecahedronGeometry(0.9, 1).scale(1.3, 0.7, 1);
  lumpy(g, 0.18, 51);
  const warm = new THREE.Color('#B3A898');
  const cool = new THREE.Color('#7F8590');
  const moss = new THREE.Color('#8C9C62');
  return painted(
    g.translate(0, 0.3, 0),
    (p, n, out) => {
      // Warm lit planes, cool shaded planes, a little moss on top.
      out.copy(cool).lerp(warm, Math.min(1, Math.max(0, 0.45 + n.y * 0.35 + n.x * 0.25)));
      const m = smoothstepJs(0.55, 0.9, n.y) * smoothstepJs(0.4, 0.7, noise3(p.x * 2.5, p.y * 2.5, p.z * 2.5));
      out.lerp(moss, m * 0.8);
    },
    () => 0,
    false,
  );
}

export function flowerGeometry(): Geo {
  const parts: Geo[] = [];
  const rnd = mulberry32(61);
  const colours = ['#F6EEE2', '#E9C35E', '#D9826C', '#A992C4', '#F2D466', '#E6A3B4'];
  const leaf = new THREE.Color('#6E8F5E');
  // A low leafy rosette grounds the cluster.
  parts.push(painted(clump(0, 0.06, 0, 0.32, 60, 0.35), (_p, n, out) => out.copy(leaf).multiplyScalar(0.8 + n.y * 0.25), () => 0.3));
  for (let i = 0; i < 9; i++) {
    const x = (rnd() - 0.5) * 0.9;
    const z = (rnd() - 0.5) * 0.9;
    const h = 0.28 + rnd() * 0.3;
    parts.push(prep(new THREE.CylinderGeometry(0.012, 0.016, h, 3).translate(x, h / 2, z), '#6E8F5E', swayAbove(0, h)));
    const head = new THREE.IcosahedronGeometry(0.08 + rnd() * 0.05, 0).scale(1, 0.7, 1).translate(x, h, z);
    parts.push(prep(head, colours[i % colours.length]!, 1, 0.1, 70 + i));
  }
  return mergeGeometries(parts)!;
}

export function grassGeometry(): Geo {
  const parts: Geo[] = [];
  const rnd = mulberry32(71);
  const base = new THREE.Color('#6F8A55');
  const tip = new THREE.Color('#BFC77F');
  for (let i = 0; i < 13; i++) {
    const a = rnd() * Math.PI * 2;
    const h = 0.3 + rnd() * 0.4;
    const blade = new THREE.ConeGeometry(0.04, h, 3, 2, true).translate(0, h / 2, 0).rotateZ((rnd() - 0.5) * 0.6).rotateY(a);
    blade.translate(Math.cos(a) * 0.16, 0, Math.sin(a) * 0.16);
    parts.push(painted(blade, (p, _n, out) => out.copy(base).lerp(tip, Math.min(1, p.y / 0.6)), swayAbove(0, 0.6), false));
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
    paintedBandsShader(shader, 0.6, 0.3);
  };
  m.customProgramCacheKey = () => 'foliage-sway';
  return m;
}
