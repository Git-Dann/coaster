import * as THREE from 'three';

/**
 * Painterly / watercolour post-process.
 *
 * The scene is rendered into a multisampled HDR target with a depth texture, then one full-screen
 * pass turns it into a watercolour illustration:
 *  - Kuwahara filter: flattens shading into soft pigment areas (radius by quality tier)
 *  - wet-edge wobble: tiny noise-driven UV offsets so edges look hand-painted
 *  - pigment pooling: darkens where colours meet, like dried watercolour edges
 *  - soft ink lines: depth discontinuities drawn as broken, warm, semi-transparent strokes
 *  - paper: procedural fibre grain plus granulation that collects in pigment
 *  - distance wash: far terrain dissolves into the paper/sky tone with a ragged edge
 *  - colour grade: lifted warm shadows, softened contrast, gentle saturation
 * Tone mapping and sRGB conversion happen at the end of this pass.
 */
const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform int uRadius;
uniform float uLines;
uniform float uPaper;
uniform float uWobble;
uniform float uWash;
uniform float uWashDist;
uniform vec3 uPaperColor;
uniform vec3 uWashColor;
uniform vec3 uInk;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }

float linearDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec3 kuwahara(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  float n = 0.0;
  for (int j = 0; j <= 4; j++) {
    if (j > uRadius) break;
    for (int i = 0; i <= 4; i++) {
      if (i > uRadius) break;
      vec3 c0 = texture2D(tColor, uv + vec2(-i, -j) * px).rgb;
      vec3 c1 = texture2D(tColor, uv + vec2( i, -j) * px).rgb;
      vec3 c2 = texture2D(tColor, uv + vec2(-i,  j) * px).rgb;
      vec3 c3 = texture2D(tColor, uv + vec2( i,  j) * px).rgb;
      m[0] += c0; s[0] += c0 * c0;
      m[1] += c1; s[1] += c1 * c1;
      m[2] += c2; s[2] += c2 * c2;
      m[3] += c3; s[3] += c3 * c3;
      n += 1.0;
    }
  }
  vec3 best = m[0] / n; float minVar = 1e9;
  for (int k = 0; k < 4; k++) {
    vec3 mean = m[k] / n;
    vec3 v = abs(s[k] / n - mean * mean);
    float var = v.r + v.g + v.b;
    if (var < minVar) { minVar = var; best = mean; }
  }
  return best;
}

void main() {
  vec2 px = 1.0 / uResolution;
  // Wet-edge wobble: low-frequency noise nudges the sample position a pixel or two.
  vec2 nuv = vUv * uResolution / 140.0;
  vec2 wob = (vec2(vnoise(nuv), vnoise(nuv + 17.3)) - 0.5) * uWobble * px * 3.0;
  vec2 uv = vUv + wob;

  vec3 col = uRadius > 0 ? kuwahara(uv) : texture2D(tColor, uv).rgb;

  // Pigment pooling: difference from a small blur, darkens boundaries between colour areas.
  vec3 blur = (texture2D(tColor, uv + vec2(2.5, 0.0) * px).rgb + texture2D(tColor, uv - vec2(2.5, 0.0) * px).rgb
             + texture2D(tColor, uv + vec2(0.0, 2.5) * px).rgb + texture2D(tColor, uv - vec2(0.0, 2.5) * px).rgb) * 0.25;
  float edge = clamp(length(texture2D(tColor, uv).rgb - blur) * 2.2, 0.0, 1.0);
  col *= 1.0 - edge * 0.32 * uPaper;

  // Soft ink lines from depth discontinuities, broken up by noise so they feel drawn.
  float d = linearDepth(vUv);
  bool sky = texture2D(tDepth, vUv).x > 0.99999;
  if (uLines > 0.0) {
    float dl = linearDepth(vUv - vec2(px.x, 0.0));
    float dr = linearDepth(vUv + vec2(px.x, 0.0));
    float du = linearDepth(vUv + vec2(0.0, px.y));
    float dd = linearDepth(vUv - vec2(0.0, px.y));
    float lap = abs(dl + dr + du + dd - 4.0 * d) / max(d, 1.0);
    float line = sky ? 0.0 : smoothstep(0.012, 0.05, lap);
    float breakup = smoothstep(0.25, 0.65, vnoise(vUv * uResolution / 9.0 + d * 0.1));
    line *= mix(0.45, 1.0, breakup) * (1.0 - smoothstep(120.0, 420.0, d));
    col = mix(col, col * uInk, line * 0.55 * uLines);
  }

  // Distance wash: far landscape dissolves into the sky/paper tone with a ragged, bleeding edge.
  float far = sky ? 0.0 : smoothstep(0.35, 0.95, d / uWashDist + (fbm(vUv * 6.0 + uTime * 0.005) - 0.5) * 0.22);
  // Aerial perspective as a wash: fog tone warmed towards the paper.
  col = mix(col, uWashColor, far * uWash);

  // Colour grade (still linear): gentle saturation, lifted warm shadows, softened contrast.
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, 1.24);
  // Warm the lights, cool the shadows slightly: the classic watercolour temperature split.
  col *= mix(vec3(0.95, 0.97, 1.05), vec3(1.04, 1.0, 0.94), smoothstep(0.05, 0.6, l));
  col = col * 0.92 + vec3(0.04, 0.034, 0.03);

  // Tone map + sRGB.
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // Paper: fibres, grain and granulation applied in display space like real pigment on paper.
  vec2 pp = vUv * uResolution;
  float fibres = fbm(pp / vec2(3.0, 18.0)) * 0.6 + fbm(pp / 2.2) * 0.4;
  float grain = hash(floor(pp * 0.5)) - 0.5;
  float granulation = smoothstep(0.35, 0.8, fbm(pp / 6.0));
  vec3 c = gl_FragColor.rgb;
  float pigment = 1.0 - dot(c, vec3(0.333));
  c *= 1.0 - uPaper * (0.06 * fibres + 0.07 * granulation * pigment);
  c += grain * 0.018 * uPaper;
  c = mix(c, uPaperColor, 0.05 * uPaper);
  // Warm vignette like the edge of a painted page.
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.35 * uPaper;
  gl_FragColor.rgb = c;
}`;

export interface PainterlySettings {
  /** Kuwahara radius 0–4 (0 disables). */
  radius: number;
  lines: number;
  paper: number;
  wobble: number;
  wash: number;
}

export const PAINTERLY_BY_LEVEL: PainterlySettings[] = [
  { radius: 0, lines: 0.7, paper: 0.8, wobble: 0.6, wash: 0.8 }, // battery
  { radius: 1, lines: 0.85, paper: 1, wobble: 1, wash: 1 }, // low
  { radius: 2, lines: 1, paper: 1, wobble: 1, wash: 1 }, // balanced
  { radius: 3, lines: 1, paper: 1, wobble: 1, wash: 1 }, // high
  { radius: 3, lines: 1, paper: 1, wobble: 1, wash: 1 }, // ultra
];

export class PainterlyPipeline {
  enabled = true;
  private target: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(width: number, height: number) {
    this.target = this.makeTarget(width, height);
    this.uniforms = {
      tColor: { value: this.target.texture },
      tDepth: { value: this.target.depthTexture },
      uResolution: { value: new THREE.Vector2(width, height) },
      uNear: { value: 0.15 },
      uFar: { value: 6000 },
      uTime: { value: 0 },
      uRadius: { value: 2 },
      uLines: { value: 1 },
      uPaper: { value: 1 },
      uWobble: { value: 1 },
      uWash: { value: 1 },
      uWashDist: { value: 600 },
      uPaperColor: { value: new THREE.Color('#F4EBDC') },
      uWashColor: { value: new THREE.Color('#E8E4DA') },
      uInk: { value: new THREE.Color('#5E4E48') },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: depth,
      depthBuffer: true,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
  }

  setSize(w: number, h: number): void {
    if (this.target.width === w && this.target.height === h) return;
    this.target.dispose();
    this.target.depthTexture?.dispose();
    this.target = this.makeTarget(w, h);
    this.uniforms.tColor!.value = this.target.texture;
    this.uniforms.tDepth!.value = this.target.depthTexture;
    (this.uniforms.uResolution!.value as THREE.Vector2).set(w, h);
  }

  apply(s: PainterlySettings): void {
    this.uniforms.uRadius!.value = s.radius;
    this.uniforms.uLines!.value = s.lines;
    this.uniforms.uPaper!.value = s.paper;
    this.uniforms.uWobble!.value = s.wobble;
    this.uniforms.uWash!.value = s.wash;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, elapsed: number, wash: THREE.Color, washDistance: number): void {
    if (!this.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    this.uniforms.uNear!.value = camera.near;
    this.uniforms.uFar!.value = camera.far;
    this.uniforms.uTime!.value = elapsed;
    (this.uniforms.uWashColor!.value as THREE.Color).copy(wash);
    this.uniforms.uWashDist!.value = washDistance;
    renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    this.target.dispose();
    this.target.depthTexture?.dispose();
    (this.quad.material as THREE.Material).dispose();
    this.quad.geometry.dispose();
  }
}
