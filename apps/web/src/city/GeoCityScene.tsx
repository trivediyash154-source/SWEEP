import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CityModel } from '@sweep/engine';
import type { ThemeName } from '../lib/spectral';
import { createSpectralMaterial } from '../three/materials';
import { CITY_PALETTE, createCityBuildingMaterial, createExplorationMaterial, createReachMaterial, createRoadMaterial } from './materials';
import type { BuildingChunk, RibbonOut } from './geometry';
import { SegmentIndex } from './spatial';

export interface CityMeshes {
  chunks: BuildingChunk[];
  roads: RibbonOut;
  ms: { buildings: number; roads: number };
}

/** A route drawn on the real network, in travel order. */
export interface PathOverlay {
  id: string;
  /** x,y pairs (city metres) of a continuous polyline in travel order. */
  points: Float64Array;
  /** Cumulative distance (m) at every point. */
  dist: Float64Array;
  tint: string | null;
  width: number;
  /** Ref holding the playback head (route distance in m), read every frame; Infinity shows the whole route. */
  head?: { current: number };
  dim?: boolean;
}

export interface ExplorationOverlay {
  id: string;
  /** Line segments x0,y0,x1,y1 per explored arc, in expansion order. */
  lines: Float32Array;
  /** Expansion order of each line. */
  order: Float32Array;
  color: string;
  /** Drawn width of each explored street piece (m). */
  width: number;
  /** Ref holding the number of expansions revealed so far. */
  progress: { current: number };
}

export interface ReachOverlay {
  ribbon: RibbonOut;
  /** Arrival time (s) per ribbon vertex. */
  time: Float32Array;
  bands: [number, number, number];
}

export interface Marker {
  id: string;
  x: number;
  y: number;
  kind: 'origin' | 'destination' | 'depot' | 'dump' | 'focus';
  label?: string;
}

export interface VehiclePose {
  x: number;
  y: number;
  heading: number;
  color: string;
}

export interface SceneOverlays {
  paths: PathOverlay[];
  explorations: ExplorationOverlay[];
  reach: ReachOverlay | null;
  markers: Marker[];
  /** Segment ribbons to highlight (selection, closures, zone). */
  highlights: { ribbon: RibbonOut; color: string; opacity: number; key: string }[];
  /** Ref with the vehicles to draw this frame (shift simulation). */
  vehicles?: { current: VehiclePose[] };
  /**
   * Service-zone outline in city metres: a finished zone (closed), or the zone being
   * drawn (open, with `preview` = the rubber-band part that follows the cursor).
   */
  zone?: { points: [number, number][]; closed: boolean; preview: [number, number][] } | null;
}

export type PickResult = { kind: 'segment'; seg: number; x: number; y: number } | { kind: 'node'; node: number; x: number; y: number } | { kind: 'building'; building: number; x: number; y: number } | { kind: 'ground'; x: number; y: number };

export type CameraCommand = 'overview' | 'focus' | 'street' | 'top' | 'frame';

export interface GeoCitySceneProps {
  city: CityModel;
  meshes: CityMeshes | null;
  theme: ThemeName;
  reduced: boolean;
  lowPower: boolean;
  showEstimates: boolean;
  overlays: SceneOverlays;
  camera: { cmd: CameraCommand; nonce: number; frame?: { minX: number; minY: number; maxX: number; maxY: number } | null };
  /** What a click resolves to: 'ground' returns the exact ground point (zone drawing), never a feature. */
  pickMode: 'node' | 'segment' | 'any' | 'ground';
  onPick: (p: PickResult) => void;
  onHover: (p: PickResult | null) => void;
  /** Width (px) of the panel covering the left edge of the canvas; the view is centred in the remaining area. */
  panelPx?: number;
  /** Exposed for tests: projects a city point to normalised screen coordinates. */
  /** Test hooks: project a city point to normalised device coordinates; whether a camera transition is running; the last camera command applied. */
  debugRef?: { current: { project: (x: number, y: number, h: number) => [number, number]; moving: () => boolean; appliedNonce: () => number } | null };
}

function makeGeometry(attrs: Record<string, Float32Array>, index: Uint32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, arr] of Object.entries(attrs)) g.setAttribute(name, new THREE.BufferAttribute(arr, name === 'position' || name === 'normal' ? 3 : 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

function Ground({ city, theme, shadows }: { city: CityModel; theme: ThemeName; shadows: boolean }) {
  const b = city.bounds;
  const w = (b.maxX - b.minX) * 4 + 8000;
  const h = (b.maxY - b.minY) * 4 + 8000;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const p = CITY_PALETTE[theme];
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cy]} receiveShadow={shadows} raycast={() => null}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial color={p.ground} roughness={1} metalness={0} />
    </mesh>
  );
}

function Roads({ meshes, theme, shadows }: { meshes: CityMeshes; theme: ThemeName; shadows: boolean }) {
  const geo = useMemo(() => {
    const r = meshes.roads;
    const n = r.positions.length / 3;
    const normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normals[3 * i + 1] = 1;
    return makeGeometry({ position: r.positions, normal: normals, rank: r.rank, across: r.across }, r.index);
  }, [meshes]);
  const mat = useMemo(() => createRoadMaterial(theme), [theme]);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);
  return <mesh geometry={geo} material={mat} receiveShadow={shadows} raycast={() => null} renderOrder={1} />;
}

function Buildings({ meshes, theme, shadows, showEstimates, groupRef }: { meshes: CityMeshes; theme: ThemeName; shadows: boolean; showEstimates: boolean; groupRef: React.RefObject<THREE.Group | null> }) {
  const geos = useMemo(
    () =>
      meshes.chunks.map((c) => {
        const g = makeGeometry({ position: c.positions, normal: c.normals, part: c.part, shade: c.shade, facadeU: c.facadeU, estimated: c.estimated }, c.index);
        g.userData.triBuilding = c.triBuilding;
        return g;
      }),
    [meshes],
  );
  const mat = useMemo(() => createCityBuildingMaterial(theme), [theme]);
  useEffect(() => {
    (mat.userData.uniforms as { uShowEst: { value: number } }).uShowEst.value = showEstimates ? 1 : 0;
  }, [mat, showEstimates]);
  useEffect(() => () => geos.forEach((g) => g.dispose()), [geos]);
  useEffect(() => () => mat.dispose(), [mat]);
  return (
    <group ref={groupRef}>
      {geos.map((g, i) => (
        <mesh key={i} geometry={g} material={mat} castShadow={shadows} receiveShadow={shadows} />
      ))}
    </group>
  );
}

function routeTube(points: Float64Array, dist: Float64Array, radius: number, y: number): THREE.BufferGeometry | null {
  const n = points.length / 2;
  if (n < 2) return null;
  const path = new THREE.CurvePath<THREE.Vector3>();
  const distAt: number[] = [dist[0]!];
  const drawn: number[] = [0];
  let run = 0;
  for (let i = 1; i < n; i++) {
    const a = new THREE.Vector3(points[2 * i - 2]!, y, points[2 * i - 1]!);
    const b = new THREE.Vector3(points[2 * i]!, y, points[2 * i + 1]!);
    const len = a.distanceTo(b);
    if (len < 1e-3) continue;
    path.add(new THREE.LineCurve3(a, b));
    run += len;
    drawn.push(run);
    distAt.push(dist[i]!);
  }
  if (path.curves.length === 0) return null;
  const tubular = Math.min(20000, Math.max(64, path.curves.length * 3));
  const geo = new THREE.TubeGeometry(path, tubular, radius, 6, false);
  const count = geo.attributes.position!.count;
  const aDist = new Float32Array(count);
  const aKind = new Float32Array(count);
  let k = 0;
  for (let i = 0; i <= tubular; i++) {
    const target = (i / tubular) * run;
    while (k < drawn.length - 2 && drawn[k + 1]! < target) k++;
    const span = drawn[k + 1]! - drawn[k]!;
    const f = span > 0 ? (target - drawn[k]!) / span : 0;
    const dv = distAt[k]! + (distAt[k + 1]! - distAt[k]!) * f;
    for (let j = 0; j <= 6; j++) aDist[i * 7 + j] = dv;
  }
  geo.setAttribute('aDist', new THREE.BufferAttribute(aDist, 1));
  geo.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1));
  return geo;
}

function PathView({ path, theme, reduced }: { path: PathOverlay; theme: ThemeName; reduced: boolean }) {
  const total = path.dist[path.dist.length - 1] ?? 0;
  const core = useMemo(() => routeTube(path.points, path.dist, path.width * 0.4, 3.2), [path]);
  const halo = useMemo(() => routeTube(path.points, path.dist, path.width * 1.25, 3.2), [path]);
  const unit = Math.max(8, path.width * 2);
  const cycle = Math.max(unit * 40, total / 2.5);
  const coreMat = useMemo(() => createSpectralMaterial({ theme, cycle, unit, tint: path.tint, tintMix: 0.55 }), [theme, cycle, unit, path.tint]);
  const haloMat = useMemo(() => createSpectralMaterial({ theme, cycle, unit, tint: path.tint, tintMix: 0.55, halo: true }), [theme, cycle, unit, path.tint]);
  useEffect(() => () => {
    core?.dispose();
    halo?.dispose();
    coreMat.dispose();
    haloMat.dispose();
  }, [core, halo, coreMat, haloMat]);
  useFrame((_, dt) => {
    const head = path.head ? Math.min(path.head.current, total + 1) : total + 1;
    for (const m of [coreMat, haloMat]) {
      if (!reduced) m.uniforms.uTime!.value += dt;
      m.uniforms.uHead!.value = head;
      m.uniforms.uIntensity!.value = path.dim ? 0.4 : theme === 'velvet' ? 1.25 : 1.0;
    }
  });
  if (!core || !halo) return null;
  return (
    <group>
      <mesh geometry={core} material={coreMat} frustumCulled={false} raycast={() => null} renderOrder={4} />
      <mesh geometry={halo} material={haloMat} frustumCulled={false} raycast={() => null} renderOrder={5} />
    </group>
  );
}

function ExplorationView({ ex, theme }: { ex: ExplorationOverlay; theme: ThemeName }) {
  const geo = useMemo(() => {
    const n = ex.lines.length / 4;
    // One flat quad per explored polyline piece, in expansion order.
    const pos = new Float32Array(n * 12);
    const ord = new Float32Array(n * 4);
    const idx = new Uint32Array(n * 6);
    const half = ex.width / 2;
    for (let i = 0; i < n; i++) {
      const x0 = ex.lines[4 * i]!;
      const y0 = ex.lines[4 * i + 1]!;
      const x1 = ex.lines[4 * i + 2]!;
      const y1 = ex.lines[4 * i + 3]!;
      const l = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = (-(y1 - y0) / l) * half;
      const ny = ((x1 - x0) / l) * half;
      const quad = [x0 + nx, y0 + ny, x0 - nx, y0 - ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny];
      for (let k = 0; k < 4; k++) {
        pos[12 * i + 3 * k] = quad[2 * k]!;
        pos[12 * i + 3 * k + 1] = 1.6;
        pos[12 * i + 3 * k + 2] = quad[2 * k + 1]!;
        ord[4 * i + k] = ex.order[i]!;
      }
      const b = 4 * i;
      idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], 6 * i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aOrder', new THREE.BufferAttribute(ord, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }, [ex]);
  const mat = useMemo(() => {
    const m = createExplorationMaterial(ex.color, theme);
    m.side = THREE.DoubleSide;
    return m;
  }, [ex.color, theme]);
  useEffect(() => () => {
    geo.dispose();
    mat.dispose();
  }, [geo, mat]);
  useFrame(() => {
    mat.uniforms.uProgress!.value = ex.progress.current;
    mat.uniforms.uFront!.value = Math.max(60, ex.order.length * 0.04);
  });
  return <mesh geometry={geo} material={mat} frustumCulled={false} raycast={() => null} renderOrder={3} />;
}

function ReachView({ reach, theme }: { reach: ReachOverlay; theme: ThemeName }) {
  const geo = useMemo(() => {
    const r = reach.ribbon;
    const pos = new Float32Array(r.positions);
    for (let i = 1; i < pos.length; i += 3) pos[i] = 0.9;
    return makeGeometry({ position: pos, aTime: reach.time, across: r.across }, r.index);
  }, [reach]);
  const mat = useMemo(() => createReachMaterial(theme, reach.bands), [theme, reach.bands]);
  useEffect(() => () => {
    geo.dispose();
    mat.dispose();
  }, [geo, mat]);
  return <mesh geometry={geo} material={mat} raycast={() => null} renderOrder={2} />;
}

function HighlightView({ h }: { h: SceneOverlays['highlights'][number] }) {
  const geo = useMemo(() => {
    const pos = new Float32Array(h.ribbon.positions);
    for (let i = 1; i < pos.length; i += 3) pos[i] = 1.2;
    return makeGeometry({ position: pos }, h.ribbon.index);
  }, [h]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo} raycast={() => null} renderOrder={6}>
      <meshBasicMaterial color={h.color} transparent opacity={h.opacity} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

const MARKER_COLOR: Record<Marker['kind'], string> = { origin: '#36e0a0', destination: '#ff5d7a', depot: '#e9c98c', dump: '#9aa7ff', focus: '#e9c98c' };

function MarkerView({ m, scale }: { m: Marker; scale: number }) {
  const c = MARKER_COLOR[m.kind];
  const h = 26 * scale;
  return (
    <group position={[m.x, 0, m.y]}>
      <mesh position={[0, h / 2, 0]} raycast={() => null}>
        <cylinderGeometry args={[0.9 * scale, 0.9 * scale, h, 8]} />
        <meshBasicMaterial color={c} toneMapped={false} />
      </mesh>
      <mesh position={[0, h + 4 * scale, 0]} raycast={() => null}>
        <sphereGeometry args={[4.5 * scale, 18, 12]} />
        <meshBasicMaterial color={c} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.6, 0]} raycast={() => null}>
        <ringGeometry args={[7 * scale, 10 * scale, 40]} />
        <meshBasicMaterial color={c} transparent opacity={0.7} toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Vehicles({ vehicles, scale }: { vehicles: { current: VehiclePose[] }; scale: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const max = 16;
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    const im = ref.current;
    if (!im) return;
    const list = vehicles.current;
    im.count = Math.min(max, list.length);
    for (let i = 0; i < im.count; i++) {
      const v = list[i]!;
      tmp.position.set(v.x, 3.5 * scale, v.y);
      tmp.rotation.set(0, -v.heading, 0);
      tmp.scale.setScalar(scale);
      tmp.updateMatrix();
      im.setMatrixAt(i, tmp.matrix);
      im.setColorAt(i, color.set(v.color));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, max]} frustumCulled={false} raycast={() => null} renderOrder={7}>
      <boxGeometry args={[9, 5, 4.5]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

function lineGeometry(points: [number, number][], closed: boolean): THREE.BufferGeometry {
  const y = 1.4;
  const ring = closed && points.length > 2 ? [...points, points[0]!] : points;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ring.flatMap(([x, z]) => [x, y, z])), 3));
  return g;
}

/** Vertex handles of a zone being drawn: small squares on the ground. */
function ZoneHandles({ points, color }: { points: [number, number][]; color: string }) {
  const geo = useMemo(() => {
    const y = 1.5;
    const h = 3;
    const pos: number[] = [];
    for (const [x, z] of points) pos.push(x - h, y, z - h, x + h, y, z - h, x + h, y, z + h, x - h, y, z - h, x + h, y, z + h, x - h, y, z + h);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    return g;
  }, [points]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh raycast={() => null} renderOrder={8}>
      <primitive object={geo} attach="geometry" />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  );
}

function ZoneOutline({ zone, theme }: { zone: NonNullable<SceneOverlays['zone']>; theme: ThemeName }) {
  const color = theme === 'velvet' ? '#e9c98c' : '#2c1a3a';
  const geo = useMemo(() => lineGeometry(zone.points, zone.closed), [zone.points, zone.closed]);
  const preview = useMemo(() => (zone.preview.length > 1 ? lineGeometry(zone.preview, false) : null), [zone.preview]);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => preview?.dispose(), [preview]);
  return (
    <>
      <line>
        <primitive object={geo} attach="geometry" />
        <lineBasicMaterial color={color} toneMapped={false} />
      </line>
      {preview && (
        <line>
          <primitive object={preview} attach="geometry" />
          <lineBasicMaterial color={color} transparent opacity={0.55} toneMapped={false} />
        </line>
      )}
      {!zone.closed && <ZoneHandles points={zone.points} color={color} />}
    </>
  );
}

/** Camera presets framed on the real extent of the loaded city. */
function CameraRig({ city, camera, debugRef, panelPx }: { city: CityModel; camera: GeoCitySceneProps['camera']; debugRef?: GeoCitySceneProps['debugRef']; panelPx: number }) {
  const { camera: cam, size, invalidate } = useThree();
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const anim = useRef<{ fp: THREE.Vector3; tp: THREE.Vector3; ft: THREE.Vector3; tt: THREE.Vector3; t: number } | null>(null);
  // Nonce of the last camera command turned into a transition (commands reach this component after a delay).
  const applied = useRef(-1);
  const b = city.region;
  // A side panel covers the left of the canvas: render a wider virtual view and show its right part,
  // so the scene's centre sits in the middle of the visible area.
  useEffect(() => {
    const pc = cam as THREE.PerspectiveCamera;
    const pad = size.width > 900 ? panelPx : 0;
    if (pad > 0) pc.setViewOffset(size.width + pad, size.height, 0, 0, size.width, size.height);
    else pc.clearViewOffset();
    pc.updateProjectionMatrix();
    invalidate();
  }, [cam, size.width, size.height, panelPx, invalidate]);
  useEffect(() => {
    if (!debugRef) return;
    debugRef.current = {
      project: (x, y, h) => {
        const v = new THREE.Vector3(x, h, y).project(cam);
        return [v.x, v.y];
      },
      moving: () => anim.current !== null,
      appliedNonce: () => applied.current,
    };
    return () => {
      debugRef.current = null;
    };
  }, [cam, debugRef]);
  useEffect(() => {
    if (!controls) return;
    const aspect = size.width / Math.max(1, size.height);
    const target = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const span = (fb: { minX: number; minY: number; maxX: number; maxY: number }) => Math.max((fb.maxX - fb.minX) / Math.max(1, aspect) * 1.25, fb.maxY - fb.minY);
    if (camera.cmd === 'frame' && camera.frame) {
      const f = camera.frame;
      const s = Math.max(250, span(f));
      target.set((f.minX + f.maxX) / 2, 0, (f.minY + f.maxY) / 2);
      pos.set(target.x - s * 0.25, s * 0.85, target.z + s * 0.75);
    } else if (camera.cmd === 'top') {
      const s = span(b);
      target.set((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2);
      pos.set(target.x, s * 1.15 / Math.min(1, aspect), target.z + 0.01);
    } else if (camera.cmd === 'focus' || camera.cmd === 'street') {
      const f = city.focus?.xy ?? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
      target.set(f[0], 0, f[1]);
      if (camera.cmd === 'street') pos.set(f[0] - 90, 38, f[1] + 160);
      else pos.set(f[0] - 380, 520, f[1] + 700);
    } else {
      const s = span(b);
      target.set((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2);
      pos.set(target.x - s * 0.12, s * 0.95, target.z + s * 0.95);
    }
    anim.current = { fp: cam.position.clone(), tp: pos, ft: controls.target.clone(), tt: target, t: 0 };
    applied.current = camera.nonce;
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.nonce, controls]);
  useFrame((_, dt) => {
    const a = anim.current;
    if (!a || !controls) return;
    a.t = Math.min(1, a.t + dt / 1.1);
    const e = 1 - Math.pow(1 - a.t, 3);
    cam.position.lerpVectors(a.fp, a.tp, e);
    controls.target.lerpVectors(a.ft, a.tt, e);
    controls.update();
    if (a.t >= 1) anim.current = null;
    else invalidate();
  });
  return null;
}

/** Pointer picking: ground-plane projection + spatial index for streets; ray-cast against buildings on click only. */
type PickerCallbacks = { current: Pick<GeoCitySceneProps, 'onPick' | 'onHover' | 'pickMode'> };

function Picker({ city, index, cbs, buildingsRef }: { city: CityModel; index: SegmentIndex; cbs: PickerCallbacks; buildingsRef: React.RefObject<THREE.Group | null> }) {
  const { camera, gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    let down: { x: number; y: number } | null = null;
    let raf = 0;
    const toGround = (ev: PointerEvent): { x: number; y: number } | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return ray.ray.intersectPlane(ground, hit) ? { x: hit.x, y: hit.z } : null;
    };
    const resolve = (p: { x: number; y: number }, mode: GeoCitySceneProps['pickMode']): PickResult => {
      if (mode === 'ground') return { kind: 'ground', x: p.x, y: p.y };
      const tol = Math.max(12, camera.position.y * 0.02);
      const node = mode !== 'segment' ? index.nearestNode(p.x, p.y, tol * 1.6) : null;
      if (node && (mode === 'node' || node.dist < tol * 0.6)) return { kind: 'node', node: node.node, x: city.nodeX[node.node]!, y: city.nodeY[node.node]! };
      const seg = mode !== 'node' ? index.nearestSegment(p.x, p.y, tol) : null;
      if (seg) return { kind: 'segment', seg: seg.seg, x: p.x, y: p.y };
      if (node) return { kind: 'node', node: node.node, x: city.nodeX[node.node]!, y: city.nodeY[node.node]! };
      return { kind: 'ground', x: p.x, y: p.y };
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.buttons) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const g = toGround(ev);
        cbs.current.onHover(g ? resolve(g, cbs.current.pickMode) : null);
      });
    };
    const onDown = (ev: PointerEvent) => {
      down = { x: ev.clientX, y: ev.clientY };
    };
    const onUp = (ev: PointerEvent) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
      down = null;
      const g = toGround(ev);
      if (cbs.current.pickMode === 'any' && buildingsRef.current) {
        const hits = ray.intersectObjects(buildingsRef.current.children, false);
        const h = hits[0];
        if (h && h.faceIndex != null) {
          const tri = (h.object as THREE.Mesh).geometry.userData.triBuilding as Int32Array | undefined;
          const b = tri?.[h.faceIndex];
          const streetHit = g ? resolve(g, 'any') : null;
          // Prefer a street the pointer is directly over; otherwise the building in front.
          if (b !== undefined && !(streetHit && streetHit.kind !== 'ground' && h.distance > camera.position.distanceTo(new THREE.Vector3(g!.x, 0, g!.y)) - 1)) {
            cbs.current.onPick({ kind: 'building', building: b, x: h.point.x, y: h.point.z });
            return;
          }
        }
      }
      if (g) cbs.current.onPick(resolve(g, cbs.current.pickMode));
    };
    const onLeave = () => cbs.current.onHover(null);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [camera, gl, index, city, buildingsRef, cbs]);
  return null;
}

/** Keeps an on-demand canvas drawing while overlays animate. */
function Animator({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useFrame(() => {
    if (active) invalidate();
  });
  useEffect(() => {
    if (active) invalidate();
  }, [active, invalidate]);
  return null;
}

export default function GeoCityScene(props: GeoCitySceneProps) {
  const { city, meshes, theme, reduced, lowPower, overlays } = props;
  const p = CITY_PALETTE[theme];
  const b = city.bounds;
  const ext = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const shadows = !lowPower && theme === 'porcelain';
  const index = useMemo(() => new SegmentIndex(city), [city]);
  const buildingsRef = useRef<THREE.Group>(null);
  // The pick mode and callbacks are read when the pointer event arrives, from this (DOM-side) render. Props
  // inside <Canvas> reach the R3F reconciler later; on slow frames a quick click after choosing a tool would
  // otherwise resolve with the previous mode (e.g. an intersection instead of the street to close).
  const pickerCbs = useRef<PickerCallbacks['current']>({ onPick: props.onPick, onHover: props.onHover, pickMode: props.pickMode });
  pickerCbs.current = { onPick: props.onPick, onHover: props.onHover, pickMode: props.pickMode };
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const markerScale = Math.max(1, ext / 2500);
  const animating = !reduced && (overlays.paths.length > 0 || overlays.explorations.length > 0 || (overlays.vehicles?.current.length ?? 0) > 0);
  return (
    <Canvas
      shadows={shadows ? { type: THREE.PCFSoftShadowMap } : false}
      dpr={lowPower ? 1 : [1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance', alpha: false, preserveDrawingBuffer: false }}
      camera={{ fov: 40, near: 2, far: ext * 10, position: [cx - ext * 0.18, ext * 0.62, cy + ext * 0.78] }}
      frameloop={lowPower || reduced ? 'demand' : 'always'}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = p.exposure;
      }}
      data-testid="city-canvas"
    >
      <color attach="background" args={[p.background]} />
      <fog attach="fog" args={[p.fog, ext * 0.8, ext * 2.4]} />
      <hemisphereLight args={[p.hemiSky, p.hemiGround, p.hemi]} />
      <directionalLight
        position={[cx - ext * 0.35, ext * 0.6, cy - ext * 0.25]}
        intensity={p.sunI}
        color={p.sun}
        castShadow={shadows}
        shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-ext * 0.7}
        shadow-camera-right={ext * 0.7}
        shadow-camera-top={ext * 0.7}
        shadow-camera-bottom={-ext * 0.7}
        shadow-camera-near={10}
        shadow-camera-far={ext * 3}
        shadow-bias={-0.0006}
      />
      <directionalLight position={[cx + ext * 0.4, ext * 0.25, cy + ext * 0.35]} intensity={p.fillI} color={p.fill} />
      <Ground city={city} theme={theme} shadows={shadows} />
      {meshes && <Roads meshes={meshes} theme={theme} shadows={shadows} />}
      {meshes && <Buildings meshes={meshes} theme={theme} shadows={shadows} showEstimates={props.showEstimates} groupRef={buildingsRef} />}
      {overlays.reach && <ReachView reach={overlays.reach} theme={theme} />}
      {overlays.highlights.map((h) => (
        <HighlightView key={h.key} h={h} />
      ))}
      {overlays.explorations.map((ex) => (
        <ExplorationView key={ex.id} ex={ex} theme={theme} />
      ))}
      {overlays.paths.map((path) => (
        <PathView key={path.id} path={path} theme={theme} reduced={reduced} />
      ))}
      {overlays.markers.map((m) => (
        <MarkerView key={m.id} m={m} scale={markerScale} />
      ))}
      {overlays.vehicles && <Vehicles vehicles={overlays.vehicles} scale={markerScale} />}
      {overlays.zone && <ZoneOutline zone={overlays.zone} theme={theme} />}
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI * 0.46} minDistance={25} maxDistance={ext * 3} screenSpacePanning={false} />
      <CameraRig city={city} camera={props.camera} panelPx={props.panelPx ?? 0} {...(props.debugRef ? { debugRef: props.debugRef } : {})} />
      <Picker city={city} index={index} cbs={pickerCbs} buildingsRef={buildingsRef} />
      <Animator active={animating} />
      {!lowPower && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={theme === 'velvet' ? 0.75 : 0.25} luminanceThreshold={theme === 'velvet' ? 0.55 : 0.85} luminanceSmoothing={0.25} mipmapBlur />
          <Vignette eskil={false} offset={0.25} darkness={theme === 'velvet' ? 0.55 : 0.25} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
