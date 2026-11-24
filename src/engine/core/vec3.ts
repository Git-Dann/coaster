/**
 * Minimal allocation-free vector helpers on plain tuples / typed-array slots.
 * The simulation and track baker use these instead of three.js so they can run
 * in tests and workers without a renderer.
 */
export type V3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const set = (o: V3, x: number, y: number, z: number): V3 => {
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
};
export const copy = (o: V3, a: Readonly<V3>): V3 => set(o, a[0], a[1], a[2]);
export const add = (o: V3, a: Readonly<V3>, b: Readonly<V3>): V3 => set(o, a[0] + b[0], a[1] + b[1], a[2] + b[2]);
export const sub = (o: V3, a: Readonly<V3>, b: Readonly<V3>): V3 => set(o, a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const scale = (o: V3, a: Readonly<V3>, s: number): V3 => set(o, a[0] * s, a[1] * s, a[2] * s);
export const addScaled = (o: V3, a: Readonly<V3>, b: Readonly<V3>, s: number): V3 =>
  set(o, a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s);
export const dot = (a: Readonly<V3>, b: Readonly<V3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (o: V3, a: Readonly<V3>, b: Readonly<V3>): V3 =>
  set(o, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
export const len = (a: Readonly<V3>): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Readonly<V3>, b: Readonly<V3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const normalize = (o: V3, a: Readonly<V3>): V3 => {
  const l = len(a);
  return l > 1e-12 ? scale(o, a, 1 / l) : set(o, 0, 0, 0);
};
export const lerp = (o: V3, a: Readonly<V3>, b: Readonly<V3>, t: number): V3 =>
  set(o, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
export const isFiniteV = (a: Readonly<V3>): boolean => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

/** Rotate `v` about unit axis `k` by angle `a` (Rodrigues). */
export const rotateAxis = (o: V3, v: Readonly<V3>, k: Readonly<V3>, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kd = dot(k, v) * (1 - c);
  const cx = k[1] * v[2] - k[2] * v[1];
  const cy = k[2] * v[0] - k[0] * v[2];
  const cz = k[0] * v[1] - k[1] * v[0];
  return set(o, v[0] * c + cx * s + k[0] * kd, v[1] * c + cy * s + k[1] * kd, v[2] * c + cz * s + k[2] * kd);
};

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Direction from heading (radians, 0 = +X, CCW seen from above towards -Z) and pitch (radians, +up). */
export const dirFromAngles = (heading: number, pitch: number): V3 => {
  const cp = Math.cos(pitch);
  return [Math.cos(heading) * cp, Math.sin(pitch), -Math.sin(heading) * cp];
};
export const anglesFromDir = (d: Readonly<V3>): { heading: number; pitch: number } => ({
  heading: Math.atan2(-d[2], d[0]),
  pitch: Math.asin(clamp(d[1], -1, 1)),
});
