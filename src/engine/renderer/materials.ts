import * as THREE from 'three';

/** Art-direction tokens (see docs/art-direction.md). */
export const PALETTE = {
  cream: '#F5EBDD',
  meadow: '#A8B58B',
  forest: '#55745B',
  dusty: '#8DAABB',
  terracotta: '#C77D62',
  butter: '#E5C579',
  walnut: '#765B48',
  charcoal: '#343C37',
} as const;

/**
 * Inject a subtle world-space colour mottling into a standard material so large painted surfaces
 * read as hand-finished rather than flat CG. Cheap: one value-noise lookup in the fragment shader.
 */
export function addPaintedVariation(mat: THREE.MeshStandardMaterial, amount = 0.06, scale = 0.35): THREE.MeshStandardMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uVarAmount = { value: amount };
    shader.uniforms.uVarScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosV;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPosV = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#ifdef USE_INSTANCING\nvWorldPosV = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPosV;
uniform float uVarAmount;
uniform float uVarScale;
float hashV(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
 return mix(mix(mix(hashV(i),hashV(i+vec3(1,0,0)),f.x),mix(hashV(i+vec3(0,1,0)),hashV(i+vec3(1,1,0)),f.x),f.y),
            mix(mix(hashV(i+vec3(0,0,1)),hashV(i+vec3(1,0,1)),f.x),mix(hashV(i+vec3(0,1,1)),hashV(i+vec3(1,1,1)),f.x),f.y),f.z); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float nv = vnoise(vWorldPosV*uVarScale)*0.6 + vnoise(vWorldPosV*uVarScale*3.1)*0.4;
diffuseColor.rgb *= 1.0 + (nv-0.5)*2.0*uVarAmount;`,
      );
  };
  mat.customProgramCacheKey = () => `painted-${amount}-${scale}`;
  return mat;
}

export type FinishName = 'matte' | 'satin' | 'gloss';
export const FINISH: Record<FinishName, { roughness: number; metalness: number }> = {
  matte: { roughness: 0.85, metalness: 0.0 },
  satin: { roughness: 0.55, metalness: 0.08 },
  gloss: { roughness: 0.28, metalness: 0.12 },
};

/** Shared, colour-mutable material. Colour changes mutate `.color`; materials are never recreated. */
export function painted(colour: string, roughness = 0.8, metalness = 0, variation = 0.05): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness, metalness });
  return variation > 0 ? addPaintedVariation(m, variation) : m;
}

export const SUPPORT_MATERIALS = {
  pine: { colour: '#D6B48A', roughness: 0.9, metalness: 0, timber: true },
  walnut: { colour: '#6E5040', roughness: 0.85, metalness: 0, timber: true },
  'painted-timber': { colour: '#F2E6D3', roughness: 0.8, metalness: 0, timber: true },
  weathered: { colour: '#A49A8C', roughness: 0.95, metalness: 0, timber: true },
  'powder-steel': { colour: '#F5EBDD', roughness: 0.55, metalness: 0.15, timber: false },
  galvanised: { colour: '#B9BDBA', roughness: 0.45, metalness: 0.55, timber: false },
  industrial: { colour: '#55745B', roughness: 0.6, metalness: 0.2, timber: false },
} as const;

/**
 * Soft painted light banding: light falls in a few gentle steps instead of a smooth CG
 * gradient, and (optionally) a warm translucent rim lights silhouettes like backlit leaves.
 * Call from inside an onBeforeCompile hook of a MeshStandardMaterial.
 */
export function paintedBandsShader(shader: { fragmentShader: string }, strength = 0.5, rim = 0): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    `{
  float lumP = max(dot(outgoingLight, vec3(0.299, 0.587, 0.114)), 1e-4);
  float pl = pow(lumP, 0.4545) * 4.0;
  float ql = (floor(pl) + smoothstep(0.3, 0.7, fract(pl))) / 4.0;
  float target = pow(max(ql, 0.02), 2.2);
  outgoingLight = mix(outgoingLight, outgoingLight * (target / lumP), ${strength.toFixed(3)});
  ${rim > 0 ? `float rimP = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
  outgoingLight += diffuseColor.rgb * vec3(1.0, 0.92, 0.62) * rimP * ${rim.toFixed(3)};` : ''}
}
#include <opaque_fragment>`,
  );
}

/** Apply soft painted banding to any standard material (chains an existing onBeforeCompile). */
export function withPaintedBands<T extends THREE.MeshStandardMaterial>(mat: T, strength = 0.45): T {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev.call(mat, shader, r);
    paintedBandsShader(shader, strength, 0);
  };
  const prevKey = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => `${prevKey}|bands${strength}`;
  return mat;
}
