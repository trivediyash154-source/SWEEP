import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { CityModel } from './cityModel';
import { sampleRoute } from '../lib/geometry';

export type SceneTheme = 'velvet' | 'porcelain';

export const PALETTE = {
  velvet: {
    background: '#1d0f2e',
    fog: '#1d0f2e',
    ground: '#2e1c45',
    road: '#5f4a80',
    roadRequired: '#d9c6b6',
    roadOptional: '#4a3a5c',
    building: ['#6f5c93', '#7d699f', '#8a76aa', '#655387'],
    route: '#75e0ff',
    repeat: '#ff6d86',
    deadhead: '#e9c98c',
    vehicle: '#fff4e0',
    hemiSky: '#b7a6ff',
    hemiGround: '#2a1530',
    sun: '#ffd9b8',
    odd: '#b7a6ff',
  },
  porcelain: {
    background: '#f4f0e8',
    fog: '#f4f0e8',
    ground: '#ece4d6',
    road: '#cbbfae',
    roadRequired: '#3b2a47',
    roadOptional: '#c2b7aa',
    building: ['#fbf7f0', '#f3ece1', '#ffffff', '#ebe2d4'],
    route: '#0a7ea6',
    repeat: '#d23c5a',
    deadhead: '#9a6d1f',
    vehicle: '#2c1a3a',
    hemiSky: '#ffffff',
    hemiGround: '#d9cdbd',
    sun: '#fff3e0',
    odd: '#6148d1',
  },
} as const;

const SPECTRAL = ['#f3a7c4', '#e9c98c', '#75e0ff', '#b7a6ff', '#ff6d86'].map((c) => new THREE.Color(c));

function spectralAt(u: number, out: THREE.Color): THREE.Color {
  const t = ((u % 1) + 1) % 1;
  const f = t * SPECTRAL.length;
  const i = Math.floor(f);
  return out.copy(SPECTRAL[i % SPECTRAL.length]!).lerp(SPECTRAL[(i + 1) % SPECTRAL.length]!, f - i);
}

/* ------------------------------------------------------------------ roads */
function Roads({ model, theme, dimOptional = true }: { model: CityModel; theme: SceneTheme; dimOptional?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const width = Math.max(7, model.extent * 0.009);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const pal = PALETTE[theme];
    const req = new THREE.Color(pal.roadRequired);
    const opt = new THREE.Color(dimOptional ? pal.roadOptional : pal.road);
    model.roads.forEach((r, i) => {
      const dx = r.bx - r.ax;
      const dz = r.bz - r.az;
      const len = Math.hypot(dx, dz) + width * 0.5;
      p.set((r.ax + r.bx) / 2, 0.6, (r.az + r.bz) / 2);
      q.setFromAxisAngle(up, -Math.atan2(dz, dx));
      s.set(len, r.required ? 1.2 : 0.8, r.required ? width : width * 0.62);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, r.required ? req : opt);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [model, theme, width, dimOptional]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, model.roads.length]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.85} metalness={0.05} />
    </instancedMesh>
  );
}

/* -------------------------------------------------------------- buildings */
function Buildings({ model, theme }: { model: CityModel; theme: SceneTheme }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const tones = PALETTE[theme].building.map((c) => new THREE.Color(c));
    model.buildings.forEach((b, i) => {
      p.set(b.x, b.h / 2, b.z);
      q.setFromAxisAngle(up, b.rot);
      s.set(b.w, b.h, b.d);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, tones[Math.floor(b.tone * tones.length)]!);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [model, theme]);
  if (model.buildings.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, model.buildings.length]} castShadow={false} receiveShadow={false} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={theme === 'porcelain' ? 0.9 : 0.6} metalness={theme === 'porcelain' ? 0 : 0.15} />
    </instancedMesh>
  );
}

/* ------------------------------------------------------------ route tube */
export type RouteColoring = 'spectral' | 'kind';

function useRouteTube(model: CityModel, theme: SceneTheme, coloring: RouteColoring) {
  return useMemo(() => {
    const route = model.route;
    if (!route || route.points.length < 2) return null;
    const pts = route.points.map((p) => new THREE.Vector3(p[0] - model.center.x, 3.2, p[1] - model.center.z));
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < pts.length; i++) if (pts[i]!.distanceTo(pts[i - 1]!) > 1e-6) path.add(new THREE.LineCurve3(pts[i - 1]!, pts[i]!));
    if (path.curves.length === 0) return null;
    const tubular = Math.min(6000, Math.max(200, path.curves.length * 6));
    const radial = 6;
    const radius = Math.max(2.4, model.extent * 0.0032);
    const geo = new THREE.TubeGeometry(path, tubular, radius, radial, false);
    const colors = new Float32Array(geo.attributes.position!.count * 3);
    const c = new THREE.Color();
    const pal = PALETTE[theme];
    const kindColor = { service: new THREE.Color(pal.route), repeat: new THREE.Color(pal.repeat), deadhead: new THREE.Color(pal.deadhead) };
    for (let i = 0; i <= tubular; i++) {
      const u = i / tubular;
      if (coloring === 'spectral') spectralAt(u * 2.2, c);
      else {
        const sm = sampleRoute(route, u * route.totalDrawn);
        c.copy(kindColor[route.steps[sm.stepIndex]?.kind ?? 'service']);
      }
      for (let j = 0; j <= radial; j++) {
        const idx = (i * (radial + 1) + j) * 3;
        colors[idx] = c.r;
        colors[idx + 1] = c.g;
        colors[idx + 2] = c.b;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const indexCount = geo.index!.count;
    return { geo, indexCount, total: route.totalDrawn };
  }, [model, theme, coloring]);
}

/**
 * Animated route: drawn progressively along its true order and followed by a
 * glowing vehicle. Progress comes from `getProgress` (drawn length), so the
 * same component serves the self-running hero and the synchronised workspace.
 */
function RouteRunner({ model, theme, coloring, getProgress, showVehicle = true }: { model: CityModel; theme: SceneTheme; coloring: RouteColoring; getProgress: (dt: number) => number; showVehicle?: boolean }) {
  const tube = useRouteTube(model, theme, coloring);
  const meshRef = useRef<THREE.Mesh>(null);
  const vehicleRef = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  useEffect(() => () => tube?.geo.dispose(), [tube]);
  useFrame((_, dt) => {
    if (!tube || !model.route) return;
    const s = getProgress(dt);
    const frac = tube.total > 0 ? Math.min(1, s / tube.total) : 1;
    const count = Math.floor((frac * tube.indexCount) / 6) * 6;
    tube.geo.setDrawRange(0, count);
    const v = vehicleRef.current;
    if (v) {
      const sm = sampleRoute(model.route, s);
      v.position.set(sm.point[0] - model.center.x, 6, sm.point[1] - model.center.z);
      v.rotation.y = -sm.angle;
      v.visible = showVehicle && frac > 0 && frac < 1;
    }
    if (lightRef.current && v) lightRef.current.position.copy(v.position).setY(28);
  });
  if (!tube) return null;
  const pal = PALETTE[theme];
  const vehSize = Math.max(6, model.extent * 0.007);
  return (
    <group>
      <mesh ref={meshRef} geometry={tube.geo} frustumCulled={false}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
      <group ref={vehicleRef}>
        <mesh>
          <boxGeometry args={[vehSize * 1.8, vehSize * 0.9, vehSize]} />
          <meshStandardMaterial color={pal.vehicle} emissive={pal.vehicle} emissiveIntensity={theme === 'velvet' ? 1.6 : 0.2} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <sphereGeometry args={[vehSize * 1.6, 16, 12]} />
          <meshBasicMaterial color={pal.route} transparent opacity={theme === 'velvet' ? 0.18 : 0.12} toneMapped={false} depthWrite={false} />
        </mesh>
      </group>
      <pointLight ref={lightRef} color={pal.route} intensity={theme === 'velvet' ? 4000 : 800} distance={model.extent * 0.35} decay={2} />
    </group>
  );
}

/* ------------------------------------------------------------- vertices */
function Junctions({ model, theme, highlightOdd }: { model: CityModel; theme: SceneTheme; highlightOdd: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const r = Math.max(4, model.extent * 0.0045);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const pal = PALETTE[theme];
    const base = new THREE.Color(pal.roadRequired);
    const odd = new THREE.Color(pal.odd);
    model.vertices.forEach((v, i) => {
      m.makeTranslation(v.x, 2.2, v.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, highlightOdd && v.odd ? odd : base);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [model, theme, highlightOdd]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, model.vertices.length]} frustumCulled={false}>
      <cylinderGeometry args={[r, r, 2.4, 18]} />
      <meshStandardMaterial roughness={0.5} emissiveIntensity={0.4} />
    </instancedMesh>
  );
}

/* --------------------------------------------------------------- petals */
function makePetalTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.translate(32, 60);
  const grad = g.createLinearGradient(0, 0, 0, -56);
  grad.addColorStop(0, '#e98bb0');
  grad.addColorStop(0.5, '#f6b3cc');
  grad.addColorStop(1, '#fff0f6');
  g.fillStyle = grad;
  const s = 54;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(s * 0.62, -s * 0.12, s * 0.78, -s * 0.78, s * 0.2, -s);
  g.quadraticCurveTo(0, -s * 0.84, -s * 0.2, -s);
  g.bezierCurveTo(-s * 0.78, -s * 0.78, -s * 0.62, -s * 0.12, 0, 0);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Petals3D({ count = 46, spread, height }: { count?: number; spread: number; height: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const tex = useMemo(() => makePetalTexture(), []);
  const seeds = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: (Math.sin(i * 12.9898) * 0.5) * spread,
        y: ((i * 37) % 100) / 100,
        z: (Math.cos(i * 78.233) * 0.5) * spread * 0.6,
        speed: 0.04 + ((i * 17) % 10) / 160,
        spin: ((i * 29) % 10) / 10,
        size: 8 + ((i * 13) % 10),
      })),
    [count, spread],
  );
  useEffect(() => () => tex.dispose(), [tex]);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const s = useMemo(() => new THREE.Vector3(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    seeds.forEach((sd, i) => {
      const life = (sd.y + t * sd.speed) % 1;
      p.set(sd.x + Math.sin(t * 0.6 + i) * 30 + life * spread * 0.25, height * (1 - life), sd.z + Math.cos(t * 0.4 + i) * 20);
      e.set(t * (0.6 + sd.spin), t * (0.4 + sd.spin), i);
      q.setFromEuler(e);
      const fade = Math.sin(life * Math.PI);
      s.setScalar(sd.size * (0.4 + 0.6 * fade));
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={tex} transparent alphaTest={0.08} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
    </instancedMesh>
  );
}

/* --------------------------------------------------------------- camera */
function HeroCameraRig({ extent, paused }: { extent: number; paused: boolean }) {
  const { camera, pointer } = useThree();
  const target = useMemo(() => new THREE.Vector3(), []);
  const t0 = useRef(0);
  useFrame((_, dt) => {
    if (!paused) t0.current += dt;
    const a = -0.65 + Math.sin(t0.current * 0.05) * 0.12 + pointer.x * 0.06;
    const r = extent * 0.92;
    const h = extent * (0.62 + pointer.y * 0.03);
    target.set(Math.sin(a) * r - extent * 0.06, h, Math.cos(a) * r);
    camera.position.lerp(target, 0.04);
    camera.lookAt(extent * 0.14, 0, extent * 0.02);
  });
  return null;
}

/* ---------------------------------------------------------------- scene */
export interface CitySceneProps {
  model: CityModel;
  theme: SceneTheme;
  mode: 'hero' | 'workspace';
  paused?: boolean;
  getProgress: (dt: number) => number;
  coloring: RouteColoring;
  showOdd?: boolean;
  children?: ReactNode;
}

export function CityScene({ model, theme, mode, paused = false, getProgress, coloring, showOdd = false }: CitySceneProps) {
  const pal = PALETTE[theme];
  const ext = model.extent;
  // Degrade gracefully on slow GPUs / software rendering: drop resolution and post-processing.
  const [lowPower, setLowPower] = useState(false);
  return (
    <Canvas
      dpr={lowPower ? 1 : [1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
      camera={{ fov: mode === 'hero' ? 34 : 40, near: 1, far: ext * 8, position: mode === 'hero' ? [ext * -0.6, ext * 0.6, ext * 0.7] : [ext * -0.5, ext * 0.95, ext * 1.05] }}
      frameloop={paused ? 'demand' : 'always'}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = theme === 'velvet' ? 1.05 : 1.0;
      }}
    >
      <PerformanceMonitor onDecline={() => setLowPower(true)} flipflops={2} onFallback={() => setLowPower(true)} />
      <color attach="background" args={[pal.background]} />
      <fog attach="fog" args={[pal.fog, ext * (mode === 'hero' ? 0.9 : 1.2), ext * (mode === 'hero' ? 2.3 : 3.4)]} />
      <hemisphereLight args={[pal.hemiSky, pal.hemiGround, theme === 'velvet' ? 1.1 : 1.5]} />
      <directionalLight position={[ext * 0.4, ext * 0.8, ext * 0.3]} intensity={theme === 'velvet' ? 1.45 : 1.6} color={pal.sun} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[ext * 6, ext * 6]} />
        <meshStandardMaterial color={pal.ground} roughness={1} />
      </mesh>
      <Roads model={model} theme={theme} />
      <Buildings model={model} theme={theme} />
      <Junctions model={model} theme={theme} highlightOdd={showOdd} />
      <RouteRunner model={model} theme={theme} coloring={coloring} getProgress={getProgress} />
      {mode === 'hero' && <Petals3D spread={ext * 0.9} height={ext * 0.5} />}
      {mode === 'hero' ? <HeroCameraRig extent={ext} paused={paused} /> : <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI * 0.46} minDistance={ext * 0.15} maxDistance={ext * 2.2} target={[0, 0, 0]} />}
      {!lowPower && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={theme === 'velvet' ? 0.85 : 0.25} luminanceThreshold={theme === 'velvet' ? 0.55 : 0.85} luminanceSmoothing={0.2} mipmapBlur />
          <Vignette eskil={false} offset={0.25} darkness={theme === 'velvet' ? 0.55 : 0.2} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
