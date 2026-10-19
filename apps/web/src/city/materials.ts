import * as THREE from 'three';
import type { ThemeName } from '../lib/spectral';

/**
 * Scene palettes for the geographic city. These are scene colours and light
 * levels, not CSS: switching theme rebuilds the materials and lights.
 *
 * Velvet: a dark aubergine ground that stays visible, facades lifted by a
 * violet sky fill and a cool moon key light, a restrained gold rim, warm
 * windows, and road surfaces ranked by class so they separate from both the
 * ground and the buildings.
 * Porcelain: cream ground, white architectural massing with soft sun shadows,
 * warm-grey road surfaces with graphite edges.
 */
export interface CityPalette {
  background: string;
  fog: string;
  ground: string;
  /** Road colours by rank 0 (trunk) … 4 (service). */
  road: [string, string, string, string, string];
  roadEdge: string;
  wallA: string;
  wallB: string;
  roof: string;
  window: string;
  windowLit: number;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sun: string;
  sunI: number;
  fill: string;
  fillI: number;
  rim: string;
  rimI: number;
  estimateTint: string;
  exposure: number;
}

export const CITY_PALETTE: Record<ThemeName, CityPalette> = {
  velvet: {
    background: '#170b26',
    fog: '#1e1030',
    ground: '#2e1c45',
    road: ['#6d5690', '#5f4a80', '#554272', '#4b3a66', '#41325a'],
    roadEdge: '#8a73b0',
    wallA: '#7a67a0',
    wallB: '#9583b6',
    roof: '#b3a2d2',
    window: '#ffd391',
    windowLit: 0.34,
    hemiSky: '#c3b3ff',
    hemiGround: '#2b1a40',
    hemi: 1.05,
    sun: '#ece2ff',
    sunI: 1.55,
    fill: '#e9c98c',
    fillI: 0.35,
    rim: '#e9c98c',
    rimI: 0.32,
    estimateTint: '#b7a6ff',
    exposure: 1.12,
  },
  porcelain: {
    background: '#ece5d9',
    fog: '#ece5d9',
    ground: '#baab92',
    road: ['#8f8371', '#9a8e7c', '#a59a88', '#b0a594', '#bab09f'],
    roadEdge: '#5c5246',
    wallA: '#f4efe6',
    wallB: '#ebe3d6',
    roof: '#fdfbf7',
    window: '#8f97a3',
    windowLit: 0,
    hemiSky: '#ffffff',
    hemiGround: '#cfc5b5',
    hemi: 1.15,
    sun: '#fff3df',
    sunI: 2.1,
    fill: '#dfe7ff',
    fillI: 0.35,
    rim: '#40214c',
    rimI: 0.06,
    estimateTint: '#6148d1',
    exposure: 1.0,
  },
};

const BUILDING_VERTEX_PARS = /* glsl */ `
attribute float part;
attribute float shade;
attribute float facadeU;
attribute float estimated;
varying float vPart;
varying float vShade;
varying float vU;
varying float vY;
varying float vEst;
`;
const BUILDING_VERTEX_MAIN = /* glsl */ `
vPart = part;
vShade = shade;
vU = facadeU;
vY = position.y;
vEst = estimated;
`;
const BUILDING_FRAG_PARS = /* glsl */ `
uniform vec3 uWallA;
uniform vec3 uWallB;
uniform vec3 uRoof;
uniform vec3 uWindow;
uniform float uWindowLit;
uniform vec3 uRim;
uniform float uRimI;
uniform vec3 uEstTint;
uniform float uShowEst;
varying float vPart;
varying float vShade;
varying float vU;
varying float vY;
varying float vEst;
float h21(vec2 p) { return fract(sin(dot(p, vec2(41.31, 289.17))) * 43758.5453); }
`;
// Replaces the diffuse colour before lighting.
const BUILDING_COLOR = /* glsl */ `
vec3 wall = mix(uWallA, uWallB, vShade);
vec3 base = vPart > 0.5 ? uRoof * (0.94 + 0.06 * vShade) : wall;
if (uShowEst > 0.5 && vEst > 0.5) {
  float hatch = step(0.5, fract((vU + vY) * 0.25));
  base = mix(base, uEstTint, vPart > 0.5 ? 0.35 : 0.18 + 0.12 * hatch);
}
diffuseColor.rgb = base;
`;
// Adds windows (walls only) and a view-dependent rim after lighting.
const BUILDING_EMISSIVE = /* glsl */ `
if (vPart < 0.5) {
  float storey = floor(vY / 3.0);
  float col = floor(vU / 3.4);
  vec2 cell = vec2(fract(vU / 3.4), fract(vY / 3.0));
  float pane = step(0.22, cell.x) * step(cell.x, 0.78) * step(0.32, cell.y) * step(cell.y, 0.78) * step(1.0, vY);
  float lit = step(h21(vec2(col + vShade * 97.0, storey)), uWindowLit);
  totalEmissiveRadiance += uWindow * pane * (uWindowLit > 0.0 ? lit * 0.9 : 0.0);
  diffuseColor.rgb *= 1.0 - pane * (uWindowLit > 0.0 ? 0.28 : 0.18);
}
`;
const BUILDING_RIM = /* glsl */ `
// vViewPosition points from the fragment towards the camera; normal is in view space.
float rim = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
outgoingLight += uRim * rim * uRimI;
`;

export function createCityBuildingMaterial(theme: ThemeName): THREE.MeshStandardMaterial {
  const p = CITY_PALETTE[theme];
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: theme === 'velvet' ? 0.78 : 0.92, metalness: 0.0 });
  const uniforms = {
    uWallA: { value: new THREE.Color(p.wallA) },
    uWallB: { value: new THREE.Color(p.wallB) },
    uRoof: { value: new THREE.Color(p.roof) },
    uWindow: { value: new THREE.Color(p.window) },
    uWindowLit: { value: p.windowLit },
    uRim: { value: new THREE.Color(p.rim) },
    uRimI: { value: p.rimI },
    uEstTint: { value: new THREE.Color(p.estimateTint) },
    uShowEst: { value: 0 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BUILDING_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BUILDING_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BUILDING_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${BUILDING_COLOR}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${BUILDING_EMISSIVE}`)
      .replace('#include <opaque_fragment>', `${BUILDING_RIM}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `city-building-${theme}`;
  return mat;
}

const ROAD_VERTEX_PARS = /* glsl */ `
attribute float rank;
attribute float across;
varying float vRank;
varying float vAcross;
`;
const ROAD_FRAG_PARS = /* glsl */ `
uniform vec3 uRoad[5];
uniform vec3 uEdge;
varying float vRank;
varying float vAcross;
`;
const ROAD_COLOR = /* glsl */ `
int ri = int(clamp(floor(vRank + 0.5), 0.0, 4.0));
vec3 rc = uRoad[0];
if (ri == 1) rc = uRoad[1];
else if (ri == 2) rc = uRoad[2];
else if (ri == 3) rc = uRoad[3];
else if (ri == 4) rc = uRoad[4];
float edge = smoothstep(0.72, 0.98, abs(vAcross));
diffuseColor.rgb = mix(rc, uEdge, edge * 0.55);
`;

export function createRoadMaterial(theme: ThemeName): THREE.MeshStandardMaterial {
  const p = CITY_PALETTE[theme];
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const uniforms = {
    uRoad: { value: p.road.map((c) => new THREE.Color(c)) },
    uEdge: { value: new THREE.Color(p.roadEdge) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRank = rank; vAcross = across;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${ROAD_FRAG_PARS}`).replace('#include <color_fragment>', `#include <color_fragment>\n${ROAD_COLOR}`);
  };
  mat.customProgramCacheKey = () => `city-road-${theme}`;
  return mat;
}

/**
 * Search-exploration lines: every explored arc carries `aOrder`, its position
 * in the REAL expansion order recorded by the routing algorithm; `uProgress`
 * reveals arcs up to that order, so the animation costs one uniform update
 * per frame however many nodes were expanded.
 */
export function createExplorationMaterial(color: string, theme: ThemeName): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: theme === 'velvet' ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uProgress: { value: 0 }, uColor: { value: new THREE.Color(color) }, uFront: { value: 400 }, uOpacity: { value: theme === 'velvet' ? 0.75 : 0.7 } },
    vertexShader: /* glsl */ `
      attribute float aOrder;
      varying float vOrder;
      void main() { vOrder = aOrder; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uProgress; uniform vec3 uColor; uniform float uFront; uniform float uOpacity;
      varying float vOrder;
      void main() {
        if (vOrder > uProgress) discard;
        float front = 1.0 - clamp((uProgress - vOrder) / uFront, 0.0, 1.0);
        gl_FragColor = vec4(uColor * (0.6 + 0.9 * front), uOpacity * (0.45 + 0.55 * front));
      }`,
  });
}

/** Reachability overlay: per-vertex arrival time (s) coloured by threshold band. */
export function createReachMaterial(theme: ThemeName, bands: [number, number, number]): THREE.ShaderMaterial {
  const dark = theme === 'velvet';
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uB: { value: new THREE.Vector3(...bands) },
      uC0: { value: new THREE.Color(dark ? '#7dffb8' : '#0b8a5a') },
      uC1: { value: new THREE.Color(dark ? '#ffd166' : '#b7791f') },
      uC2: { value: new THREE.Color(dark ? '#ff6d86' : '#c2334f') },
      uReveal: { value: 1e9 },
    },
    vertexShader: /* glsl */ `
      attribute float aTime;
      attribute float across;
      varying float vTime; varying float vAcross;
      void main() { vTime = aTime; vAcross = across; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uB; uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform float uReveal;
      varying float vTime; varying float vAcross;
      void main() {
        if (vTime > uB.z || vTime > uReveal) discard;
        vec3 c = vTime <= uB.x ? uC0 : (vTime <= uB.y ? uC1 : uC2);
        float a = 0.92 - 0.5 * smoothstep(0.6, 1.0, abs(vAcross));
        gl_FragColor = vec4(c, a);
      }`,
  });
}
