import { BakedTrack, newSample } from '../track/bake';
import type { TrainSim } from './train-sim';

export const MAX_FLEX_LOADS = 12;

/** Structural stiffness profile. Values are plausible approximations, documented in docs/physics.md. */
export interface FlexProfile {
  /** Vertical stiffness per bogie load (N/m). */
  kVertical: number;
  /** Longitudinal spread of deflection along the structure (m, Gaussian sigma). */
  sigma: number;
  /** Lateral sway natural frequency (Hz) and damping ratio. */
  swayHz: number;
  swayDamping: number;
  /** Lateral compliance: metres of sway per newton of lateral train force at steady state. */
  swayCompliance: number;
  /** Vertical bounce compliance (m/N) and frequency (Hz). */
  bounceCompliance: number;
  bounceHz: number;
  /** Ride rattle amplitude at speed (m) and roll (rad). */
  rattle: number;
  rattleRoll: number;
}

export const FLEX_TIMBER: FlexProfile = {
  kVertical: 4.2e5,
  sigma: 2.6,
  swayHz: 1.4,
  swayDamping: 0.07,
  swayCompliance: 6e-7,
  bounceCompliance: 3.5e-7,
  bounceHz: 2.2,
  rattle: 0.006,
  rattleRoll: 0.0045,
};

export const FLEX_STEEL: FlexProfile = {
  kVertical: 4.5e6,
  sigma: 4,
  swayHz: 2.6,
  swayDamping: 0.03,
  swayCompliance: 6e-8,
  bounceCompliance: 4e-8,
  bounceHz: 3.5,
  rattle: 0.0012,
  rattleRoll: 0.0008,
};

/**
 * Subtle, physically motivated structural flex. Purely visual: it reads the simulation and never
 * feeds back into it (energy lost to the structure is covered by the rolling-resistance model).
 *
 * - Static deflection under each bogie: δ = m·g/k spread with a Gaussian along the structure.
 * - Lateral sway: one damped mode driven by the train's lateral (centripetal) force.
 * - Vertical bounce: one damped mode driven by the change in normal load (hills, valleys).
 */
export class StructureFlex {
  profile: FlexProfile = FLEX_STEEL;
  enabled = true;
  /** xyz = bogie world position, w = static deflection (m). */
  readonly loads = new Float32Array(MAX_FLEX_LOADS * 4);
  loadCount = 0;
  readonly swayDir = new Float32Array(3);
  sway = 0;
  private swayVel = 0;
  bounce = 0;
  private bounceVel = 0;
  readonly centre = new Float32Array(3);
  ground = 0;
  top = 1;
  private readonly smp = newSample();

  /** Advance the structural modes by one fixed simulation step. */
  step(sim: TrainSim, track: BakedTrack, dt: number): void {
    const p = this.profile;
    const smp = this.smp;
    const g = sim.params.gravity;
    const v = sim.v;
    let lat = 0;
    let normal = 0;
    let m = 0;
    for (const c of sim.cars) {
      track.sample(c.centre, smp);
      const carMass = sim.mass / sim.cars.length;
      // Horizontal lateral force from curvature: m·v²·κ projected on the horizontal right vector.
      const rx = smp.right[0];
      const rz = smp.right[2];
      const rl = Math.hypot(rx, rz) || 1;
      lat += carMass * v * v * ((smp.curv[0] * rx + smp.curv[2] * rz) / rl);
      normal += carMass * (v * v * (smp.curv[1] * smp.up[1] + smp.curv[0] * smp.up[0] + smp.curv[2] * smp.up[2]) + g * Math.max(0, smp.up[1]));
      m += carMass;
    }
    // Damped oscillators: x'' + 2ζω x' + ω² x = ω² · compliance · F
    const w = 2 * Math.PI * p.swayHz;
    const a = w * w * (p.swayCompliance * lat - this.sway) - 2 * p.swayDamping * w * this.swayVel;
    this.swayVel += a * dt;
    this.sway += this.swayVel * dt;
    const wb = 2 * Math.PI * p.bounceHz;
    const dynamic = normal - m * g;
    const ab = wb * wb * (-p.bounceCompliance * dynamic - this.bounce) - 2 * 0.08 * wb * this.bounceVel;
    this.bounceVel += ab * dt;
    this.bounce += this.bounceVel * dt;
    // Keep within a plausible envelope even for extreme layouts.
    this.sway = Math.max(-0.08, Math.min(0.08, this.sway));
    this.bounce = Math.max(-0.03, Math.min(0.03, this.bounce));
  }

  /** Update per-frame outputs (load positions, sway direction) from interpolated bogie positions. */
  update(sim: TrainSim, track: BakedTrack, bogies: Array<{ front: number; rear: number; centre: number }>, groundAt: (x: number, z: number) => number): void {
    const smp = this.smp;
    const perBogie = (sim.mass / Math.max(1, sim.cars.length) / 2) * sim.params.gravity;
    const delta = this.enabled ? perBogie / this.profile.kVertical : 0;
    let n = 0;
    for (const b of bogies) {
      for (const s of [b.front, b.rear]) {
        if (n >= MAX_FLEX_LOADS) break;
        track.sample(s, smp);
        this.loads[n * 4] = smp.pos[0];
        this.loads[n * 4 + 1] = smp.pos[1];
        this.loads[n * 4 + 2] = smp.pos[2];
        this.loads[n * 4 + 3] = delta;
        n++;
      }
    }
    this.loadCount = n;
    const mid = bogies[Math.floor(bogies.length / 2)];
    if (mid) {
      track.sample(mid.centre, smp);
      this.centre[0] = smp.pos[0];
      this.centre[1] = smp.pos[1];
      this.centre[2] = smp.pos[2];
      const rx = smp.right[0];
      const rz = smp.right[2];
      const rl = Math.hypot(rx, rz) || 1;
      this.swayDir[0] = rx / rl;
      this.swayDir[1] = 0;
      this.swayDir[2] = rz / rl;
      this.ground = groundAt(smp.pos[0], smp.pos[2]);
      this.top = Math.max(this.ground + 0.5, smp.pos[1]);
    }
  }

  /** Same displacement as the shader, evaluated on the CPU (for the train and cameras). */
  offsetAt(x: number, y: number, z: number, out: [number, number, number]): [number, number, number] {
    if (!this.enabled) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const s2 = 2 * this.profile.sigma * this.profile.sigma;
    let dy = 0;
    for (let i = 0; i < this.loadCount; i++) {
      const dx = x - this.loads[i * 4]!;
      const dyy = y - this.loads[i * 4 + 1]!;
      const dz = z - this.loads[i * 4 + 2]!;
      dy -= this.loads[i * 4 + 3]! * Math.exp(-(dx * dx + dyy * dyy + dz * dz) / s2);
    }
    const cx = x - this.centre[0]!;
    const cz = z - this.centre[2]!;
    const env = Math.exp(-(cx * cx + cz * cz) / (2 * 14 * 14));
    const h = Math.min(1, Math.max(0, (y - this.ground) / Math.max(1, this.top - this.ground)));
    out[0] = this.swayDir[0]! * this.sway * env * h;
    out[1] = dy + this.bounce * env * h;
    out[2] = this.swayDir[2]! * this.sway * env * h;
    return out;
  }
}

/** GLSL for the matching vertex displacement. Inject into materials with `injectFlex`. */
export const FLEX_GLSL = /* glsl */ `
uniform vec4 uFlexLoads[${MAX_FLEX_LOADS}];
uniform int uFlexCount;
uniform float uFlexSigma;
uniform vec3 uFlexSwayDir;
uniform float uFlexSway;
uniform float uFlexBounce;
uniform vec3 uFlexCentre;
uniform float uFlexGround;
uniform float uFlexTop;
uniform float uFlexRigidBase;
vec3 flexOffset(vec3 wp) {
  float s2 = 2.0 * uFlexSigma * uFlexSigma;
  float dy = 0.0;
  for (int i = 0; i < ${MAX_FLEX_LOADS}; i++) {
    if (i >= uFlexCount) break;
    vec3 d = wp - uFlexLoads[i].xyz;
    dy -= uFlexLoads[i].w * exp(-dot(d, d) / s2);
  }
  vec2 c = wp.xz - uFlexCentre.xz;
  float env = exp(-dot(c, c) / (2.0 * 14.0 * 14.0));
  float h = clamp((wp.y - uFlexGround) / max(1.0, uFlexTop - uFlexGround), 0.0, 1.0);
  // Supports: footings stay planted, deflection grows towards the top.
  float base = mix(1.0, h, uFlexRigidBase);
  return vec3(uFlexSwayDir.x * uFlexSway * env * h, dy * base + uFlexBounce * env * h, uFlexSwayDir.z * uFlexSway * env * h);
}`;

export interface FlexUniforms {
  uFlexLoads: { value: Float32Array };
  uFlexCount: { value: number };
  uFlexSigma: { value: number };
  uFlexSwayDir: { value: Float32Array };
  uFlexSway: { value: number };
  uFlexBounce: { value: number };
  uFlexCentre: { value: Float32Array };
  uFlexGround: { value: number };
  uFlexTop: { value: number };
}

export function makeFlexUniforms(flex: StructureFlex): FlexUniforms {
  return {
    uFlexLoads: { value: flex.loads },
    uFlexCount: { value: 0 },
    uFlexSigma: { value: 3 },
    uFlexSwayDir: { value: flex.swayDir },
    uFlexSway: { value: 0 },
    uFlexBounce: { value: 0 },
    uFlexCentre: { value: flex.centre },
    uFlexGround: { value: 0 },
    uFlexTop: { value: 1 },
  };
}

export function syncFlexUniforms(u: FlexUniforms, flex: StructureFlex): void {
  u.uFlexCount.value = flex.enabled ? flex.loadCount : 0;
  u.uFlexSigma.value = flex.profile.sigma;
  u.uFlexSway.value = flex.enabled ? flex.sway : 0;
  u.uFlexBounce.value = flex.enabled ? flex.bounce : 0;
  u.uFlexGround.value = flex.ground;
  u.uFlexTop.value = flex.top;
}

/**
 * Add flex displacement to a standard material's vertex shader. The displacement is computed
 * from the world position but applied in view space, so precision far from the origin is kept.
 * `rigidBase` = 1 keeps footings planted (supports); 0 moves everything equally (track).
 */
export function injectFlex(shader: { vertexShader: string; uniforms: Record<string, unknown> }, u: FlexUniforms, rigidBase: number): void {
  Object.assign(shader.uniforms, u, { uFlexRigidBase: { value: rigidBase } });
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${FLEX_GLSL}`).replace(
    '#include <project_vertex>',
    `#include <project_vertex>
{
  vec4 wpF = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wpF = instanceMatrix * wpF;
  #endif
  wpF = modelMatrix * wpF;
  vec3 offF = flexOffset(wpF.xyz);
  mvPosition.xyz += (viewMatrix * vec4(offF, 0.0)).xyz;
  gl_Position = projectionMatrix * mvPosition;
}`,
  );
}
