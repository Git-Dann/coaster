import * as THREE from 'three';
import type { Biome, Weather } from '../../types/world';

/** Lighting keyframe for a given hour. Colours are sRGB hex. */
interface Key {
  h: number;
  zenith: string;
  horizon: string;
  sun: string;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  fog: string;
}

const KEYS: Key[] = [
  { h: 0, zenith: '#0E1527', horizon: '#26304A', sun: '#9FB0D8', sunI: 0.3, hemiSky: '#3A4A6E', hemiGround: '#1C2219', hemiI: 0.45, fog: '#232C42' },
  { h: 4.8, zenith: '#15203A', horizon: '#3A4362', sun: '#9FB0D8', sunI: 0.25, hemiSky: '#46557A', hemiGround: '#22281D', hemiI: 0.5, fog: '#323B57' },
  { h: 6.2, zenith: '#7C9AC0', horizon: '#F2B98C', sun: '#FFB474', sunI: 1.3, hemiSky: '#C9B9B4', hemiGround: '#5E5A44', hemiI: 0.9, fog: '#E8C3A6' },
  { h: 9, zenith: '#7FA9CF', horizon: '#F1E8D6', sun: '#FFF0D8', sunI: 2.7, hemiSky: '#D4E2EC', hemiGround: '#7C7A55', hemiI: 1.15, fog: '#E6E4DA' },
  { h: 12.5, zenith: '#7BA6D2', horizon: '#EEEADC', sun: '#FFF7EC', sunI: 3.0, hemiSky: '#D9E6EE', hemiGround: '#7F7D58', hemiI: 1.2, fog: '#E4E6E0' },
  { h: 15.5, zenith: '#80A6CB', horizon: '#F3E5CB', sun: '#FFE6C0', sunI: 2.8, hemiSky: '#E1DFD6', hemiGround: '#7E7552', hemiI: 1.15, fog: '#ECE3D0' },
  { h: 18.4, zenith: '#7F98BE', horizon: '#F2BE84', sun: '#FFB565', sunI: 2.1, hemiSky: '#E6CDB0', hemiGround: '#6D6043', hemiI: 0.95, fog: '#EDC9A0' },
  { h: 19.6, zenith: '#4A5F86', horizon: '#A8A2C0', sun: '#8E92BC', sunI: 0.2, hemiSky: '#7D86AA', hemiGround: '#353A31', hemiI: 0.7, fog: '#8A8AA8' },
  { h: 21, zenith: '#1A2440', horizon: '#3E4766', sun: '#9FB0D8', sunI: 0.3, hemiSky: '#46557A', hemiGround: '#22281D', hemiI: 0.5, fog: '#323B57' },
  { h: 24, zenith: '#0E1527', horizon: '#26304A', sun: '#9FB0D8', sunI: 0.3, hemiSky: '#3A4A6E', hemiGround: '#1C2219', hemiI: 0.45, fog: '#232C42' },
];

interface WeatherMod {
  cloud: number;
  sunScale: number;
  desat: number;
  fogDensity: number;
  wet: number;
  rain: number;
  snow: number;
  warm: number;
}

export const WEATHER_MODS: Record<Weather, WeatherMod> = {
  clear: { cloud: 0.12, sunScale: 1, desat: 0, fogDensity: 1, wet: 0, rain: 0, snow: 0, warm: 0 },
  'partly-cloudy': { cloud: 0.45, sunScale: 0.9, desat: 0.05, fogDensity: 1.05, wet: 0, rain: 0, snow: 0, warm: 0 },
  overcast: { cloud: 0.88, sunScale: 0.3, desat: 0.35, fogDensity: 1.5, wet: 0, rain: 0, snow: 0, warm: 0 },
  'light-rain': { cloud: 0.85, sunScale: 0.28, desat: 0.35, fogDensity: 1.8, wet: 0.6, rain: 0.35, snow: 0, warm: 0 },
  rain: { cloud: 0.95, sunScale: 0.18, desat: 0.45, fogDensity: 2.4, wet: 1, rain: 1, snow: 0, warm: 0 },
  snow: { cloud: 0.9, sunScale: 0.3, desat: 0.4, fogDensity: 2.2, wet: 0.1, rain: 0, snow: 1, warm: 0 },
  mist: { cloud: 0.55, sunScale: 0.55, desat: 0.25, fogDensity: 4.2, wet: 0.2, rain: 0, snow: 0, warm: 0 },
  'golden-haze': { cloud: 0.25, sunScale: 0.85, desat: 0, fogDensity: 2.0, wet: 0, rain: 0, snow: 0, warm: 0.6 },
};

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunColor;
uniform float uCloud; uniform float uTime; uniform float uNight; uniform float uSunVis;
varying vec3 vDir;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.03; a*=.5; } return s; }
// Watercolour sky: a pale paper ground near the horizon with uneven washes of colour above.
// Wash edges are a little darker (pigment dries at the rim), clouds are paper left unpainted.
void main(){
  vec3 d = normalize(vDir);
  float y = d.y;
  vec2 uv = d.xz / (max(y, 0.0) + 0.25);
  float wash = fbm(uv * 0.9 + vec2(uTime * 0.002, 0.0));
  float t = smoothstep(-0.04, 0.32, y + (wash - 0.5) * 0.3);
  vec3 col = mix(uHorizon, uZenith, t);
  // Pigment rims where the wash fades.
  float rim = smoothstep(0.42, 0.5, wash) * (1.0 - smoothstep(0.5, 0.6, wash));
  col *= 1.0 - rim * 0.07 * smoothstep(0.0, 0.3, y);
  // Second, looser wash for variation.
  col = mix(col, col * vec3(0.94, 0.97, 1.04), smoothstep(0.55, 0.8, fbm(uv * 0.35 + 4.0)) * 0.6);
  col = mix(col, uGround, smoothstep(0.0, -0.1, y));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 5.0) * 0.16 + pow(sd, 40.0) * 0.22) * uSunVis;
  // Sun as a soft painted disc.
  col = mix(col, uSunColor * 1.35, smoothstep(0.9975, 0.999, sd) * uSunVis * 0.8);
  // Clouds: unpainted paper with soft, slightly ragged edges and a cool shaded underside.
  if (y > -0.02) {
    vec2 cuv = uv * 0.7 + vec2(uTime * 0.004, uTime * 0.0012);
    float c = fbm(cuv) + 0.18 * fbm(cuv * 3.0);
    float cov = smoothstep(1.02 - uCloud, 1.18 - uCloud, c) * smoothstep(-0.02, 0.2, y);
    vec3 paper = mix(vec3(0.97, 0.94, 0.88), uHorizon * 1.05, 0.25);
    vec3 shade = mix(paper, uZenith * 0.85 + vec3(0.06, 0.05, 0.08), 0.35);
    vec3 cloudCol = mix(paper, shade, smoothstep(0.5, 1.0, fbm(cuv * 1.7 + 9.0)));
    cloudCol = mix(cloudCol, uSunColor, pow(sd, 6.0) * 0.25);
    cloudCol = mix(cloudCol, uZenith * 1.4, uNight * 0.7);
    float cloudRim = smoothstep(0.0, 0.15, cov) * (1.0 - smoothstep(0.15, 0.45, cov));
    col = mix(col, cloudCol, cov * 0.95);
    col *= 1.0 - cloudRim * 0.05;
  }
  if (uNight > 0.01 && y > 0.0) {
    vec2 sp = d.xz / (y + 0.4) * 160.0;
    float s = step(0.9965, h(floor(sp))) * smoothstep(0.0, 0.25, y) * (1.0 - uCloud);
    col += vec3(s) * uNight * 0.9;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

function lerpKey(hour: number, field: keyof Omit<Key, 'h' | 'sunI' | 'hemiI'>, out: THREE.Color): THREE.Color {
  const hr = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= hr) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const t = (hr - a.h) / (b.h - a.h);
  tmpA.set(a[field]);
  tmpB.set(b[field]);
  return out.copy(tmpA).lerp(tmpB, t);
}
function lerpNum(hour: number, field: 'sunI' | 'hemiI'): number {
  const hr = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= hr) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  return a[field] + (b[field] - a[field]) * ((hr - a.h) / (b.h - a.h));
}

/** Sun elevation/azimuth for an hour. Night returns a moon-like light from the opposite side. */
export function sunDirection(hour: number, out: THREE.Vector3): { day: number } {
  const dayT = (hour - 6) / 13; // 6:00 → 19:00
  const elev = Math.sin(Math.PI * Math.min(Math.max(dayT, -0.2), 1.2)) * (62 * Math.PI) / 180;
  const az = Math.PI * 0.15 + dayT * Math.PI * 0.9;
  const day = Math.max(0, Math.min(1, (Math.sin(Math.PI * dayT) + 0.08) * 4));
  const e = day > 0.02 ? Math.max(elev, 0.04) : (35 * Math.PI) / 180;
  const a = day > 0.02 ? az : az + Math.PI;
  out.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
  return { day };
}

export interface AtmosphereTarget {
  hour: number;
  weather: Weather;
  biome: Biome;
}

/**
 * Sky dome, sun/moon light, hemisphere ambient and fog, all blended smoothly towards a target
 * time of day and weather. Weather is purely cosmetic here.
 */
export class Atmosphere {
  readonly sky: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.FogExp2;
  private readonly uniforms: Record<string, THREE.IUniform>;
  /** Smoothed state. */
  hour = 15.5;
  private targetHour = 15.5;
  private mod: WeatherMod = { ...WEATHER_MODS.clear };
  private targetMod: WeatherMod = { ...WEATHER_MODS.clear };
  /** Exposed smoothed weather intensities for particles/audio. */
  readonly state = { rain: 0, snow: 0, wet: 0, cloud: 0.12, night: 0, day: 1, fogDensity: 1 };
  baseFog = 0.0021;
  private readonly sunDir = new THREE.Vector3();
  private readonly c = new THREE.Color();
  autoCycle = false;

  constructor() {
    this.uniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color('#6F7A5E') },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uCloud: { value: 0.12 },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uSunVis: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.sky.scale.setScalar(5000);

    this.sun = new THREE.DirectionalLight('#fff', 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    // Soft, slightly lighter shadows: the cool hemisphere fill shows through, giving coloured shadows.
    this.sun.shadow.radius = 4;
    this.sun.shadow.blurSamples = 10;
    this.sun.shadow.intensity = 0.9;
    this.setShadowQuality(2048, 90);
    this.hemi = new THREE.HemisphereLight('#dfe8ee', '#7c7a55', 1.1);
    this.fog = new THREE.FogExp2('#dde6e8', this.baseFog);
  }

  /** Current (blended) sky horizon colour, used by the painterly distance wash. */
  get horizon(): THREE.Color {
    return this.uniforms.uHorizon!.value as THREE.Color;
  }

  setShadowQuality(mapSize: number, extent: number): void {
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 600;
    cam.updateProjectionMatrix();
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  setTarget(t: AtmosphereTarget, immediate = false): void {
    this.targetHour = t.hour;
    this.targetMod = { ...WEATHER_MODS[t.weather] };
    const g = t.biome === 'winter' ? '#D9DDDC' : t.biome === 'coastal' ? '#8E9C86' : '#6F7A5E';
    (this.uniforms.uGround!.value as THREE.Color).set(g);
    if (immediate) {
      this.hour = t.hour;
      this.mod = { ...this.targetMod };
    }
  }

  /** Advance blending and apply to scene objects. `focus` is the point shadows should cover. */
  update(dt: number, elapsed: number, focus: THREE.Vector3): void {
    // Blend hour along the shortest way round the clock.
    if (this.autoCycle) this.targetHour = (this.targetHour + dt * (24 / 600)) % 24; // 10-minute day
    let dh = this.targetHour - this.hour;
    if (dh > 12) dh -= 24;
    if (dh < -12) dh += 24;
    const k = 1 - Math.exp(-dt * (this.autoCycle ? 4 : 1.2));
    this.hour = (((this.hour + dh * k) % 24) + 24) % 24;
    const km = 1 - Math.exp(-dt * 0.8);
    for (const key of Object.keys(this.mod) as Array<keyof WeatherMod>) this.mod[key] += (this.targetMod[key] - this.mod[key]) * km;

    const u = this.uniforms;
    const m = this.mod;
    const { day } = sunDirection(this.hour, this.sunDir);
    const night = 1 - day;
    const desat = (col: THREE.Color, amt: number) => {
      const l = col.r * 0.3 + col.g * 0.59 + col.b * 0.11;
      col.r += (l - col.r) * amt;
      col.g += (l - col.g) * amt;
      col.b += (l - col.b) * amt;
      return col;
    };
    const warm = (col: THREE.Color, amt: number) => col.lerp(this.c.set('#F2C28A'), amt * 0.35);

    desat(lerpKey(this.hour, 'zenith', u.uZenith!.value as THREE.Color), m.desat);
    warm(desat(lerpKey(this.hour, 'horizon', u.uHorizon!.value as THREE.Color), m.desat * 0.8), m.warm);
    lerpKey(this.hour, 'sun', u.uSunColor!.value as THREE.Color);
    (u.uSunDir!.value as THREE.Vector3).copy(this.sunDir);
    u.uCloud!.value = m.cloud;
    u.uTime!.value = elapsed;
    u.uNight!.value = night;
    u.uSunVis!.value = Math.max(0.05, m.sunScale) * (day > 0.02 ? 1 : 0.3);

    lerpKey(this.hour, 'sun', this.sun.color);
    warm(this.sun.color, m.warm);
    this.sun.intensity = lerpNum(this.hour, 'sunI') * m.sunScale;
    lerpKey(this.hour, 'hemiSky', this.hemi.color);
    desat(this.hemi.color, m.desat * 0.5);
    lerpKey(this.hour, 'hemiGround', this.hemi.groundColor);
    this.hemi.intensity = lerpNum(this.hour, 'hemiI') * (1 + (1 - m.sunScale) * 0.35);

    warm(desat(lerpKey(this.hour, 'fog', this.fog.color), m.desat * 0.7), m.warm);
    this.fog.density = this.baseFog * m.fogDensity;

    // Shadow camera follows the focus point.
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 250);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.sky.position.copy(focus);

    this.state.rain = m.rain;
    this.state.snow = m.snow;
    this.state.wet = m.wet;
    this.state.cloud = m.cloud;
    this.state.night = night;
    this.state.day = day;
    this.state.fogDensity = m.fogDensity;
  }
}
