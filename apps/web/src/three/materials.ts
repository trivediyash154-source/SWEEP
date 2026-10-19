import * as THREE from 'three';
import { SPECTRAL_STOPS, type ThemeName } from '../lib/spectral';

/**
 * Spectral route shader. Every vertex of the route tube carries `aDist`, the
 * TRUE route distance (engine weights) at that point, and `aKind` (0 service,
 * 1 repeat, 2 deadhead). The colour loop, the travelling light band, the
 * leading highlight at the vehicle and the trail fade are all functions of
 * aDist against the playback head, so the animation follows the computed
 * traversal continuously and never restarts at segment boundaries.
 */
const vertex = /* glsl */ `
attribute float aDist;
attribute float aKind;
varying float vDist;
varying float vKind;
varying vec3 vNormalV;
void main() {
  vDist = aDist;
  vKind = aKind;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragment = /* glsl */ `
uniform float uTime;
uniform float uHead;
uniform float uCycle;
uniform float uBandSpacing;
uniform float uBandSpeed;
uniform float uHeadLen;
uniform float uTrailLen;
uniform float uStripe;
uniform float uGhost;
uniform float uIntensity;
uniform float uHalo;
uniform vec3 uStops[5];
uniform vec3 uTint;
uniform float uTintMix;
uniform vec3 uRepeat;
uniform vec3 uDeadhead;
varying float vDist;
varying float vKind;
varying vec3 vNormalV;

vec3 spectral(float u) {
  float t = fract(u) * 5.0;
  int i = int(floor(t));
  float f = fract(t);
  vec3 a = uStops[0]; vec3 b = uStops[1];
  if (i == 1) { a = uStops[1]; b = uStops[2]; }
  else if (i == 2) { a = uStops[2]; b = uStops[3]; }
  else if (i == 3) { a = uStops[3]; b = uStops[4]; }
  else if (i >= 4) { a = uStops[4]; b = uStops[0]; }
  return mix(a, b, smoothstep(0.0, 1.0, f));
}

void main() {
  float behind = uHead - vDist;
  bool future = behind < 0.0;
  if (future && uGhost <= 0.0) discard;
  if (vKind > 1.5 && fract(vDist / uStripe) > 0.62) discard; // deadhead: dashed
  vec3 col = spectral(vDist / uCycle - uTime * 0.045);
  col = mix(col, uTint, uTintMix);
  if (vKind > 0.5 && vKind < 1.5) {
    float stripe = step(0.5, fract(vDist / uStripe));
    col = mix(col, uRepeat, 0.5 + 0.3 * stripe);
  } else if (vKind > 1.5) {
    col = mix(col, uDeadhead, 0.55);
  }
  float phase = fract((vDist - uTime * uBandSpeed) / uBandSpacing);
  float band = exp(-pow((phase - 0.5) * 8.0, 2.0));
  float head = future ? 0.0 : exp(-behind / uHeadLen);
  float trail = future ? 1.0 : mix(0.62, 1.0, exp(-behind / uTrailLen));
  float rim = 0.75 + 0.25 * abs(vNormalV.z);
  vec3 c = col * (uIntensity * trail * rim + band * 1.25) + vec3(1.0, 0.96, 0.9) * head * 2.4;
  if (uHalo > 0.5) {
    float a = (0.14 + 0.42 * band + 0.9 * head) * (future ? uGhost : 1.0);
    gl_FragColor = vec4(c * 0.9, a);
  } else {
    gl_FragColor = vec4(future ? col * 0.55 : c, future ? uGhost : 1.0);
  }
}`;

export interface SpectralOptions {
  theme: ThemeName;
  halo?: boolean;
  /** Distance over which the colour loop repeats once. */
  cycle: number;
  /** Width scale for highlights (scene units of route distance). */
  unit: number;
  tint?: string | null;
  tintMix?: number;
}

export function createSpectralMaterial(o: SpectralOptions): THREE.ShaderMaterial {
  const stops = SPECTRAL_STOPS[o.theme].map((c) => new THREE.Color(c));
  const dark = o.theme === 'velvet';
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: !o.halo,
    blending: o.halo ? (dark ? THREE.AdditiveBlending : THREE.NormalBlending) : THREE.NormalBlending,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uHead: { value: 1e9 },
      uCycle: { value: o.cycle },
      uBandSpacing: { value: o.cycle * 0.5 },
      uBandSpeed: { value: o.cycle * 0.09 },
      uHeadLen: { value: o.unit * 2.2 },
      uTrailLen: { value: o.cycle * 0.8 },
      uStripe: { value: o.unit * 0.9 },
      uGhost: { value: o.halo ? 0 : 0.16 },
      uIntensity: { value: dark ? 1.15 : 0.95 },
      uHalo: { value: o.halo ? 1 : 0 },
      uStops: { value: stops },
      uTint: { value: new THREE.Color(o.tint ?? '#ffffff') },
      uTintMix: { value: o.tint ? (o.tintMix ?? 0.5) : 0 },
      uRepeat: { value: new THREE.Color(dark ? '#ff6d86' : '#d23c5a') },
      uDeadhead: { value: new THREE.Color(dark ? '#e9c98c' : '#9a6d1f') },
    },
  });
}

/**
 * Building material: MeshStandardMaterial plus procedural facade detail —
 * window bands on vertical faces (lit at random in Velvet, crisp model
 * reveals in Porcelain) and a soft occlusion gradient at street level.
 */
export function createBuildingMaterial(theme: ThemeName, floorH: number): THREE.MeshStandardMaterial {
  const dark = theme === 'velvet';
  const mat = new THREE.MeshStandardMaterial({ roughness: dark ? 0.62 : 0.88, metalness: dark ? 0.12 : 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFloorH = { value: floorH };
    shader.uniforms.uWinColor = { value: new THREE.Color(dark ? '#ffd9a0' : '#9a8f86') };
    shader.uniforms.uWinIntensity = { value: dark ? 0.85 : 0 };
    shader.uniforms.uWinShade = { value: dark ? 0.55 : 0.86 };
    shader.uniforms.uLit = { value: dark ? 0.62 : 2 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vec4 sweepW = vec4(transformed, 1.0);
vec3 sweepN = objectNormal;
#ifdef USE_INSTANCING
  sweepW = instanceMatrix * sweepW;
  sweepN = mat3(instanceMatrix) * sweepN;
#endif
vWPos = (modelMatrix * sweepW).xyz;
vWNormal = normalize(mat3(modelMatrix) * sweepN);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform float uFloorH;
uniform vec3 uWinColor;
uniform float uWinIntensity;
uniform float uWinShade;
uniform float uLit;
float sweepHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb *= mix(0.68, 1.0, smoothstep(0.0, uFloorH * 2.2, vWPos.y));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float sweepSide = 1.0 - step(0.45, abs(vWNormal.y));
vec3 sweepT = normalize(cross(vec3(0.0, 1.0, 0.0), vWNormal) + vec3(1e-4));
float sweepU = dot(vWPos, sweepT) / (uFloorH * 0.85);
float sweepV = vWPos.y / uFloorH;
vec2 sweepCell = fract(vec2(sweepU, sweepV));
float sweepWin = step(0.2, sweepCell.x) * step(sweepCell.x, 0.8) * step(0.3, sweepCell.y) * step(sweepCell.y, 0.8) * step(0.9, sweepV);
float sweepLit = step(uLit, sweepHash(floor(vec2(sweepU, sweepV)) + floor(vWPos.xz * 0.013)));
diffuseColor.rgb *= mix(1.0, uWinShade, sweepSide * sweepWin);
totalEmissiveRadiance += sweepSide * sweepWin * sweepLit * uWinColor * uWinIntensity;`,
      );
  };
  return mat;
}

/** Unit gable roof: footprint 1 × 1 on y = 0, ridge along x at y = 1. */
export function createGableGeometry(): THREE.BufferGeometry {
  const p = [
    // two sloped faces
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // gable ends
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}
