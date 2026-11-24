import * as THREE from 'three';
import { WATER_LEVEL } from '../terrain/heightfield';

/**
 * A single camera-following water plane at sea level. Opaque (no overdraw, no depth texture),
 * with gentle procedural ripples in the normal and a soft painterly colour.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly time = { value: 0 };

  constructor() {
    this.material = new THREE.MeshStandardMaterial({ color: '#7FA3B5', roughness: 0.18, metalness: 0.05 });
    const t = this.time;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = t;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nuniform float uTime;')
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
vec2 p = vWP.xz;
float a = sin(p.x*0.35 + uTime*0.9) + sin(p.y*0.29 - uTime*0.7) + 0.5*sin((p.x+p.y)*0.9 + uTime*1.6);
float b = cos(p.x*0.31 - uTime*0.8) + cos(p.y*0.37 + uTime*0.6) + 0.5*cos((p.x-p.y)*0.8 - uTime*1.3);
vec3 pert = vec3(a, 0.0, b) * 0.035;
normal = normalize(normal + (viewMatrix * vec4(pert, 0.0)).xyz);`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
float sh = 0.5 + 0.5*sin(vWP.x*0.05 + vWP.z*0.04 + uTime*0.2);
diffuseColor.rgb *= 0.92 + 0.12*sh;`,
        );
    };
    this.material.customProgramCacheKey = () => 'water-v1';
    const geo = new THREE.PlaneGeometry(4000, 4000, 1, 1).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = WATER_LEVEL;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'water';
  }

  update(elapsed: number, focus: THREE.Vector3, night: number): void {
    this.time.value = elapsed;
    // Snap to a grid so the ripple pattern doesn't swim with the camera.
    this.mesh.position.x = Math.round(focus.x / 64) * 64;
    this.mesh.position.z = Math.round(focus.z / 64) * 64;
    this.material.color.setRGB(0.5 - night * 0.3, 0.64 - night * 0.38, 0.71 - night * 0.36);
  }
}
