import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { solveChinesePostman } from '@sweep/engine';
import { heroCity } from '@sweep/engine/examples';
import { buildDistrict, type District } from './district';
import { SCENE_PALETTE, Buildings, Ground, Junctions, Streets, Trees, buildTube, type Pal } from './districtParts';
import { createSpectralMaterial } from './materials';
import { buildTrack, sampleTrack, type RouteTrack } from '../lib/routeTrack';
import { lowPowerFor, startInLowPower } from '../lib/webgl';
import type { ThemeName } from '../lib/spectral';

/**
 * The landing-page city: a deterministic synthetic district whose route is solved live by the engine, drawn with
 * the network lab's district (lit windows, trees, street markings) and spectral route. The route draws itself
 * along its true order behind a vehicle, holds complete for a moment, then starts again. Nothing is interactive.
 */

/** Seconds to draw the whole route, and to hold it complete before the next pass. */
const DRAW_S = 14;
const HOLD_S = 8;

/**
 * Porcelain in the hero: the same cream, one step deeper on the ground and streets, so white buildings and the ink
 * route stand out from it instead of dissolving into the page behind the text.
 */
const HERO_PORCELAIN = {
  ground: '#e4d9c6',
  plate: '#ebe1cf',
  road: '#cdbfa9',
  roadRequired: '#bba88f',
  sidewalk: '#f5efe4',
  junction: '#d6c8b2',
  fog: '#efe7da',
  building: ['#fbf7f1', '#f1e9dd', '#f7f1e8', '#e9e0d1', '#f4ede2'],
};

/** Self-running playback head, in true route distance; complete (and still) under reduced motion. */
function useHeroHead(total: number, paused: boolean, reduced: boolean) {
  const head = useRef({ s: 0, hold: 0 });
  useFrame((_, dt) => {
    const h = head.current;
    if (reduced) {
      h.s = total + 1;
      return;
    }
    if (paused) return;
    if (h.s < total) {
      h.s = Math.min(total, h.s + (total / DRAW_S) * dt);
      return;
    }
    h.hold += dt;
    if (h.hold > HOLD_S) {
      h.hold = 0;
      h.s = 0;
    }
  });
  return head;
}

function HeroRoute({ track, d, theme, paused, reduced }: { track: RouteTrack; d: District; theme: ThemeName; paused: boolean; reduced: boolean }) {
  const unit = d.roadW;
  const core = useMemo(() => buildTube(track, d, 2.8, d.laneW * 0.75), [track, d]);
  const halo = useMemo(() => buildTube(track, d, 2.8, d.laneW * 1.7), [track, d]);
  const cycle = Math.max(unit * 40, track.total / 3);
  const coreMat = useMemo(() => {
    const m = createSpectralMaterial({ theme, cycle, unit });
    // The route still to come stays visible as a faint trace, so the hero never shows an empty city.
    m.uniforms.uGhost!.value = theme === 'velvet' ? 0.3 : 0.45;
    m.uniforms.uIntensity!.value = theme === 'velvet' ? 1.35 : 1.05;
    return m;
  }, [theme, cycle, unit]);
  const haloMat = useMemo(() => createSpectralMaterial({ theme, cycle, unit, halo: true }), [theme, cycle, unit]);
  useEffect(() => () => {
    core?.dispose();
    halo?.dispose();
    coreMat.dispose();
    haloMat.dispose();
  }, [core, halo, coreMat, haloMat]);
  const head = useHeroHead(track.total, paused, reduced);
  const vehicle = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const s = head.current.s;
    for (const m of [coreMat, haloMat]) {
      if (!reduced && !paused) m.uniforms.uTime!.value += dt;
      m.uniforms.uHead!.value = s;
    }
    const v = vehicle.current;
    if (v) {
      const smp = sampleTrack(track, Math.min(s, track.total));
      v.position.set(smp.point[0] - d.center.x, 1.2, smp.point[1] - d.center.z);
      v.rotation.y = -smp.angle;
      v.visible = s > 0 && s < track.total;
    }
  });
  if (!core || !halo) return null;
  const pal = SCENE_PALETTE[theme];
  const glow = theme === 'velvet' ? '#75e0ff' : '#0a7ea6';
  const size = d.laneW * 1.9;
  return (
    <group>
      <mesh geometry={core} material={coreMat} frustumCulled={false} renderOrder={2} />
      <mesh geometry={halo} material={haloMat} frustumCulled={false} renderOrder={3} />
      <group ref={vehicle}>
        <mesh position={[0, size * 0.32, 0]}>
          <boxGeometry args={[size * 1.5, size * 0.55, size * 0.78]} />
          <meshStandardMaterial color={pal.vehicle} roughness={0.35} metalness={0.3} />
        </mesh>
        <mesh position={[size * 0.48, size * 0.72, 0]}>
          <boxGeometry args={[size * 0.48, size * 0.42, size * 0.7]} />
          <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>
        <mesh position={[0, size * 0.4, 0]}>
          <sphereGeometry args={[size * 1.6, 16, 12]} />
          <meshBasicMaterial color={glow} transparent opacity={theme === 'velvet' ? 0.16 : 0.12} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
    </group>
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

function Petals({ count = 46, spread, height }: { count?: number; spread: number; height: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const tex = useMemo(() => makePetalTexture(), []);
  const seeds = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: Math.sin(i * 12.9898) * 0.5 * spread,
        y: ((i * 37) % 100) / 100,
        z: Math.cos(i * 78.233) * 0.5 * spread * 0.6,
        speed: 0.04 + ((i * 17) % 10) / 160,
        spin: ((i * 29) % 10) / 10,
        size: (8 + ((i * 13) % 10)) * (spread / 900),
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
      p.set(sd.x + Math.sin(t * 0.6 + i) * spread * 0.03 + life * spread * 0.25, height * (1 - life), sd.z + Math.cos(t * 0.4 + i) * spread * 0.02);
      e.set(t * (0.6 + sd.spin), t * (0.4 + sd.spin), i);
      q.setFromEuler(e);
      s.setScalar(sd.size * (0.4 + 0.6 * Math.sin(life * Math.PI)));
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
/**
 * Camera position for drift angle `a` and pointer height `py`: about 50 degrees down, high enough to see the route
 * between the towers and low enough to read as a city. The city sits right of the hero text.
 */
function heroCameraAt(extent: number, a: number, py: number, out: THREE.Vector3): THREE.Vector3 {
  const r = extent * 0.8;
  return out.set(Math.sin(a) * r - extent * 0.06, extent * (0.95 + py * 0.03), Math.cos(a) * r);
}
const HERO_LOOK = [0.14, 0, 0.02] as const;

/** A slow drift around the district, nudged by the pointer. */
function HeroCameraRig({ extent, paused }: { extent: number; paused: boolean }) {
  const { camera, pointer } = useThree();
  const target = useMemo(() => new THREE.Vector3(), []);
  const t0 = useRef(0);
  useFrame((_, dt) => {
    if (!paused) t0.current += dt;
    heroCameraAt(extent, -0.65 + Math.sin(t0.current * 0.05) * 0.12 + pointer.x * 0.06, pointer.y, target);
    camera.position.lerp(target, 0.04);
    camera.lookAt(extent * HERO_LOOK[0], extent * HERO_LOOK[1], extent * HERO_LOOK[2]);
  });
  return null;
}

/* ---------------------------------------------------------------- scene */
export default function HeroScene({ theme, paused, reduced }: { theme: ThemeName; paused: boolean; reduced: boolean }) {
  const { d, track } = useMemo(() => {
    const graph = heroCity();
    const r = solveChinesePostman(graph);
    const district = buildDistrict(graph, { seed: 4242 });
    return { d: district, track: r.ok ? buildTrack(graph, r.route.steps, { laneWidth: district.laneW }) : null };
  }, []);
  const pal: Pal = theme === 'porcelain' ? { ...SCENE_PALETTE.porcelain, ...HERO_PORCELAIN } : SCENE_PALETTE.velvet;
  const ext = d.extent;
  // Shadows, bloom and full resolution only once the context shows a hardware GPU (see lowPowerFor).
  const [lowPower, setLowPower] = useState(startInLowPower);
  const shadows = !lowPower;
  return (
    <Canvas
      shadows={shadows ? { type: THREE.PCFSoftShadowMap } : false}
      dpr={lowPower ? 1 : [1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
      camera={{ fov: 34, near: 1, far: ext * 10, position: heroCameraAt(ext, -0.65, 0, new THREE.Vector3()).toArray() }}
      frameloop={paused ? 'demand' : 'always'}
      onCreated={({ gl, camera }) => {
        // The first frame already shows the resting view: no swoop in from elsewhere.
        camera.lookAt(ext * HERO_LOOK[0], ext * HERO_LOOK[1], ext * HERO_LOOK[2]);
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = theme === 'velvet' ? 1.08 : 1.0;
        setLowPower(lowPowerFor(gl.getContext()));
      }}
    >
      <PerformanceMonitor onDecline={() => setLowPower(true)} flipflops={2} onFallback={() => setLowPower(true)} />
      <color attach="background" args={[pal.background]} />
      <fog attach="fog" args={[pal.fog, ext * 1.2, ext * (theme === 'velvet' ? 3.2 : 4.2)]} />
      <hemisphereLight args={[pal.hemiSky, pal.hemiGround, theme === 'velvet' ? 1.0 : 1.1]} />
      <directionalLight
        position={[ext * 0.45, ext * 0.9, ext * 0.25]}
        intensity={theme === 'velvet' ? 1.45 : 1.9}
        color={pal.sun}
        castShadow={shadows}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-ext * 0.8}
        shadow-camera-right={ext * 0.8}
        shadow-camera-top={ext * 0.8}
        shadow-camera-bottom={-ext * 0.8}
        shadow-camera-near={1}
        shadow-camera-far={ext * 3}
        shadow-bias={-0.0004}
      />
      {theme === 'velvet' && <pointLight position={[0, ext * 0.25, 0]} intensity={ext * 3} color="#b03476" distance={ext * 1.6} decay={1.6} />}
      <Ground d={d} pal={pal} shadows={shadows} />
      <Streets d={d} pal={pal} shadows={shadows} />
      <Junctions d={d} pal={pal} />
      <Buildings d={d} pal={pal} theme={theme} shadows={shadows} />
      <Trees d={d} pal={pal} shadows={shadows} />
      {track && <HeroRoute track={track} d={d} theme={theme} paused={paused} reduced={reduced} />}
      {!reduced && <Petals spread={ext * 0.9} height={ext * 0.5} />}
      <HeroCameraRig extent={ext} paused={paused} />
      {!lowPower && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={theme === 'velvet' ? 0.9 : 0.35} luminanceThreshold={theme === 'velvet' ? 0.62 : 0.9} luminanceSmoothing={0.22} mipmapBlur />
          <Vignette eskil={false} offset={0.28} darkness={theme === 'velvet' ? 0.55 : 0.2} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
