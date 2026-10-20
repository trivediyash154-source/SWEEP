import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import type { District } from './district';
import { createSpectralMaterial } from './materials';
import { SCENE_PALETTE, Buildings, Ground, Junctions, Streets, Trees, UP, buildTube, tmpP, tmpQ, tmpS, useInstances, type Pal } from './districtParts';
import { sampleTrack, pointsBounds, type RouteTrack } from '../lib/routeTrack';
import { lowPowerFor, startInLowPower } from '../lib/webgl';
import type { Highlight } from '../lib/analysis';
import { routeClock } from '../workspace/routeClock';
import { useWorkspace, type CameraCommand } from '../state/workspace';
import type { ThemeName } from '../lib/spectral';

export { SCENE_PALETTE };

/* -------------------------------------------------------- spectral route */
function RouteTube({ track, d, theme, tint, reduced, dimmed }: { track: RouteTrack; d: District; theme: ThemeName; tint: string | null; reduced: boolean; dimmed: boolean }) {
  const unit = d.roadW;
  const core = useMemo(() => buildTube(track, d, 2.6, d.laneW * 0.42), [track, d]);
  const halo = useMemo(() => buildTube(track, d, 2.6, d.laneW * 1.15), [track, d]);
  const cycle = Math.max(unit * 40, track.total / 3);
  const coreMat = useMemo(() => createSpectralMaterial({ theme, cycle, unit, tint, tintMix: 0.5 }), [theme, cycle, unit, tint]);
  const haloMat = useMemo(() => createSpectralMaterial({ theme, cycle, unit, tint, tintMix: 0.5, halo: true }), [theme, cycle, unit, tint]);
  useEffect(() => () => {
    core?.dispose();
    halo?.dispose();
    coreMat.dispose();
    haloMat.dispose();
  }, [core, halo, coreMat, haloMat]);
  useFrame((_, dt) => {
    const head = routeClock.s > 0 || routeClock.playing ? Math.min(routeClock.s, track.total) : track.total + 1;
    for (const m of [coreMat, haloMat]) {
      if (!reduced) m.uniforms.uTime!.value += dt;
      m.uniforms.uHead!.value = head;
      m.uniforms.uIntensity!.value = dimmed ? 0.45 : theme === 'velvet' ? 1.15 : 0.95;
    }
  });
  if (!core || !halo) return null;
  return (
    <group>
      <mesh geometry={core} material={coreMat} frustumCulled={false} raycast={() => null} renderOrder={2} />
      <mesh geometry={halo} material={haloMat} frustumCulled={false} raycast={() => null} renderOrder={3} />
    </group>
  );
}

/* ------------------------------------------------------------- vehicle */
function Vehicle({ track, d, pal, color, index }: { track: RouteTrack; d: District; pal: Pal; color: string; index: number }) {
  const g = useRef<THREE.Group>(null);
  const brush = useRef<THREE.Mesh>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const heading = useRef<number | null>(null);
  const s = d.laneW * 1.9;
  useFrame(({ clock }, dt) => {
    const grp = g.current;
    if (!grp) return;
    const active = routeClock.s > 0 || routeClock.playing;
    const dist = active ? Math.min(routeClock.s, track.total) : 0;
    const smp = sampleTrack(track, dist);
    grp.position.set(smp.point[0] - d.center.x, 1.2, smp.point[1] - d.center.z);
    const target = -smp.angle;
    if (heading.current === null) heading.current = target;
    let diff = target - heading.current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    heading.current += diff * Math.min(1, dt * 10);
    grp.rotation.y = heading.current;
    grp.visible = active ? dist < track.total : true;
    if (brush.current && routeClock.playing) brush.current.rotation.y += dt * 12;
    if (beacon.current) (beacon.current.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * Math.sin(clock.elapsedTime * 6 + index);
    if (index === 0) publishFollowPose(grp.position, heading.current);
  });
  return (
    <group ref={g}>
      <mesh position={[0, s * 0.32, 0]} castShadow>
        <boxGeometry args={[s * 1.5, s * 0.55, s * 0.78]} />
        <meshStandardMaterial color={pal.vehicle} roughness={0.35} metalness={0.3} />
      </mesh>
      <mesh position={[s * 0.48, s * 0.72, 0]} castShadow>
        <boxGeometry args={[s * 0.48, s * 0.42, s * 0.7]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} toneMapped={false} />
      </mesh>
      <mesh ref={brush} position={[s * 0.84, s * 0.12, s * 0.32]}>
        <cylinderGeometry args={[s * 0.22, s * 0.22, s * 0.12, 12]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      <mesh ref={beacon} position={[s * 0.3, s * 1.0, 0]}>
        <sphereGeometry args={[s * 0.13, 12, 8]} />
        <meshBasicMaterial color={color} transparent toneMapped={false} />
      </mesh>
      <mesh position={[0, s * 0.4, 0]}>
        <sphereGeometry args={[s * 1.5, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.1} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Shared follow target: the first vehicle publishes its pose for the camera rig. */
const followPose = { pos: new THREE.Vector3(), heading: 0, valid: false };
function publishFollowPose(pos: THREE.Vector3, heading: number): void {
  followPose.pos.copy(pos);
  followPose.heading = heading;
  followPose.valid = true;
}

/* ----------------------------------------------------------- atmosphere */
function Atmosphere({ track, d, theme, reduced }: { track: RouteTrack | null; d: District; theme: ThemeName; reduced: boolean }) {
  const N = 140;
  const ref = useRef<THREE.Points>(null);
  const seeds = useMemo(() => Array.from({ length: N }, (_, i) => ({ a: (i * 2.39996) % (Math.PI * 2), r: ((i * 37) % 100) / 100, sp: 0.2 + ((i * 13) % 10) / 20, ph: (i * 0.618) % 1 })), []);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const col = new Float32Array(N * 3);
    const stops = theme === 'velvet' ? ['#f3a7c4', '#ffd98c', '#75e0ff', '#b7a6ff'] : ['#d2508a', '#c08a1e', '#0a7ea6', '#6148d1'];
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      c.set(stops[i % stops.length]!);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }, [theme]);
  useEffect(() => () => geo.dispose(), [geo]);
  useFrame(({ clock }) => {
    if (!track || !ref.current) return;
    const t = reduced ? 0 : clock.elapsedTime;
    const active = routeClock.s > 0 || routeClock.playing;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      const sd = seeds[i]!;
      // Motes ride along the route: around the vehicle when playing, spread along the route otherwise.
      const along = active ? Math.max(0, routeClock.s - sd.r * d.roadW * 30) : ((sd.ph + t * 0.01 * sd.sp) % 1) * track.total;
      const p = sampleTrack(track, along).point;
      const life = (sd.ph + t * 0.25 * sd.sp) % 1;
      pos.setXYZ(i, p[0] - d.center.x + Math.cos(sd.a + t * sd.sp) * d.roadW * (0.6 + sd.r), 3 + life * d.roadW * 4, p[1] - d.center.z + Math.sin(sd.a + t * sd.sp) * d.roadW * (0.6 + sd.r));
    }
    pos.needsUpdate = true;
  });
  if (!track) return null;
  return (
    <points ref={ref} geometry={geo} frustumCulled={false} raycast={() => null}>
      <pointsMaterial size={d.roadW * 0.32} vertexColors transparent opacity={theme === 'velvet' ? 0.75 : 0.5} depthWrite={false} blending={theme === 'velvet' ? THREE.AdditiveBlending : THREE.NormalBlending} toneMapped={false} sizeAttenuation />
    </points>
  );
}

/* ------------------------------------------------------------ highlights */
function Highlights({ d, pal, highlight, hoverVertex, hoverEdge, selectedVertex, selectedEdge, reduced }: {
  d: District;
  pal: Pal;
  highlight: Highlight;
  hoverVertex: string | null;
  hoverEdge: string | null;
  selectedVertex: string | null;
  selectedEdge: string | null;
  reduced: boolean;
}) {
  const ring = useRef<THREE.InstancedMesh>(null);
  const strip = useRef<THREE.InstancedMesh>(null);
  const rings = useMemo(() => {
    const list: Array<{ x: number; z: number; color: string; scale: number }> = [];
    for (const [id, mark] of highlight.vertices) {
      const p = d.vertexPos.get(id);
      if (p) list.push({ x: p.x, z: p.z, color: pal.marks[mark], scale: mark === 'focus' || mark === 'matched' ? 1.5 : 1.15 });
    }
    for (const [id, color, sc] of [[hoverVertex, pal.marks.hover, 1.3], [selectedVertex, pal.marks.focus, 1.7]] as const) {
      const p = id ? d.vertexPos.get(id) : undefined;
      if (p) list.push({ x: p.x, z: p.z, color, scale: sc });
    }
    return list;
  }, [d, pal, highlight, hoverVertex, selectedVertex]);
  const strips = useMemo(() => {
    const list: Array<{ i: number; color: string; w: number }> = [];
    const edgeColor = new Map<string, { color: string; w: number }>();
    for (const [id, mark] of highlight.edges) edgeColor.set(id, { color: pal.marks[mark], w: mark === 'focus' ? 0.5 : 0.36 });
    if (hoverEdge) edgeColor.set(hoverEdge, { color: pal.marks.hover, w: 0.42 });
    if (selectedEdge) edgeColor.set(selectedEdge, { color: pal.marks.focus, w: 0.5 });
    d.roads.forEach((r, i) => {
      const c = edgeColor.get(r.edgeId);
      if (c) list.push({ i, ...c });
    });
    return list;
  }, [d, pal, highlight, hoverEdge, selectedEdge]);
  useInstances(ring, rings.length, (i, m, c) => {
    const r = rings[i]!;
    tmpP.set(r.x, 1.8, r.z);
    tmpQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    tmpS.setScalar(d.roadW * r.scale);
    m.compose(tmpP, tmpQ, tmpS);
    c.set(r.color);
  }, [rings, d]);
  useInstances(strip, strips.length, (i, m, c) => {
    const s = strips[i]!;
    const r = d.roads[s.i]!;
    const dx = r.bx - r.ax;
    const dz = r.bz - r.az;
    tmpP.set((r.ax + r.bx) / 2, 4.2, (r.az + r.bz) / 2);
    tmpQ.setFromAxisAngle(UP, -Math.atan2(dz, dx));
    tmpS.set(Math.hypot(dx, dz), 0.6, d.roadW * s.w);
    m.compose(tmpP, tmpQ, tmpS);
    c.set(s.color);
  }, [strips, d]);
  useFrame(({ clock }) => {
    if (reduced || !ring.current) return;
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.72 + Math.sin(clock.elapsedTime * 3) * 0.28;
  });
  return (
    <group>
      {rings.length > 0 && (
        <instancedMesh key={`r${rings.length}`} ref={ring} args={[undefined, undefined, rings.length]} frustumCulled={false} raycast={() => null}>
          <torusGeometry args={[1, 0.12, 8, 36]} />
          <meshBasicMaterial toneMapped={false} transparent />
        </instancedMesh>
      )}
      {strips.length > 0 && (
        <instancedMesh key={`s${strips.length}`} ref={strip} args={[undefined, undefined, strips.length]} frustumCulled={false} raycast={() => null}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial toneMapped={false} transparent opacity={0.9} />
        </instancedMesh>
      )}
      {highlight.labels.size > 0 && highlight.labels.size <= 70 &&
        [...highlight.labels].map(([id, text]) => {
          const p = d.vertexPos.get(id);
          if (!p) return null;
          return (
            <Html key={id} position={[p.x, d.roadW * 2.4, p.z]} center zIndexRange={[4, 0]} className="scene-label-wrap">
              <span className={`scene-label scene-label--${highlight.vertices.get(id) ?? 'even'}`}>{text}</span>
            </Html>
          );
        })}
    </group>
  );
}

/* --------------------------------------------------------------- camera */
function CameraRig({ d, tracks, reduced }: { d: District; tracks: RouteTrack[]; reduced: boolean }) {
  const { camera, size, invalidate } = useThree();
  // Portrait viewports need more distance to fit the district horizontally.
  const portrait = size.width < size.height;
  const fitScale = portrait ? Math.min(2, 0.92 / Math.max(0.42, size.width / size.height)) : 1;
  // Home view direction (× extent). Portrait screens look down more steeply so buildings hide fewer streets.
  const home: readonly [number, number, number] = portrait ? [-0.3, 0.78, 0.52] : [-0.42, 0.5, 0.72];
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const cmd = useWorkspace((s) => s.camera);
  const follow = useWorkspace((s) => s.follow);
  const selection = useWorkspace((s) => s.selection);
  const anim = useRef<{ fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number; dur: number } | null>(null);
  const ext = d.extent;
  const first = useRef(true);

  const go = (toP: THREE.Vector3, toT: THREE.Vector3, dur = 0.9) => {
    if (!controls) return;
    if (reduced) {
      // No camera motion under reduced motion: jump, then draw one frame (the canvas renders on demand).
      anim.current = null;
      camera.position.copy(toP);
      controls.target.copy(toT);
      controls.update();
    } else anim.current = { fromP: camera.position.clone(), toP, fromT: controls.target.clone(), toT, t: 0, dur };
    invalidate();
  };
  useEffect(() => {
    if (!controls) return;
    const c: CameraCommand = cmd.cmd;
    if (first.current) {
      first.current = false;
      camera.position.set(-ext * 0.9 * fitScale, ext * 1.2 * fitScale, ext * 1.4 * fitScale);
      controls.target.set(0, 0, 0);
      go(new THREE.Vector3(home[0] * ext * fitScale, home[1] * ext * fitScale, home[2] * ext * fitScale), new THREE.Vector3(0, 0, 0), 1.8);
      return;
    }
    if (c === 'reset') go(new THREE.Vector3(home[0] * ext * fitScale, home[1] * ext * fitScale, home[2] * ext * fitScale), new THREE.Vector3(0, 0, 0));
    else if (c === 'top') go(new THREE.Vector3(0, ext * 1.15 * fitScale, ext * 0.001), new THREE.Vector3(0, 0, 0));
    else if (c === 'focus-route') {
      const pts = tracks.flatMap((t) => t.points);
      if (pts.length) {
        const b = pointsBounds(pts);
        const cx = (b.minX + b.maxX) / 2 - d.center.x;
        const cz = (b.minY + b.maxY) / 2 - d.center.z;
        const r = Math.max(b.maxX - b.minX, b.maxY - b.minY);
        go(new THREE.Vector3(cx - r * 0.35, r * 0.62, cz + r * 0.62), new THREE.Vector3(cx, 0, cz));
      }
    } else if (c === 'focus-node') {
      const p = selection?.type === 'vertex' ? d.vertexPos.get(selection.id) : undefined;
      if (p) go(new THREE.Vector3(p.x - ext * 0.12, ext * 0.16, p.z + ext * 0.2), new THREE.Vector3(p.x, 0, p.z));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd.nonce, controls]);

  useEffect(() => {
    if (!controls) return;
    const stop = () => {
      anim.current = null;
      if (useWorkspace.getState().follow) useWorkspace.getState().setFollow(false);
    };
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);

  useFrame((_, dt) => {
    if (!controls) return;
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = 1 - Math.pow(1 - a.t, 3);
      camera.position.lerpVectors(a.fromP, a.toP, e);
      controls.target.lerpVectors(a.fromT, a.toT, e);
      controls.update();
      if (a.t >= 1) anim.current = null;
      else invalidate(); // keeps an on-demand canvas drawing until the move ends
      return;
    }
    if (follow && followPose.valid) {
      const h = followPose.heading;
      const back = new THREE.Vector3(-Math.cos(-h), 0, -Math.sin(-h)).multiplyScalar(ext * 0.09);
      const want = followPose.pos.clone().add(back).add(new THREE.Vector3(0, ext * 0.07, 0));
      camera.position.lerp(want, Math.min(1, dt * 3));
      controls.target.lerp(followPose.pos, Math.min(1, dt * 5));
      controls.update();
    }
  });
  return null;
}

/** Redraws an on-demand canvas when the shared route clock moves (scrubbing or stepping while paused). */
function ClockInvalidator() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const off = routeClock.subscribe(() => invalidate());
    return () => {
      off();
    };
  }, [invalidate]);
  return null;
}

/* ---------------------------------------------------------------- scene */
export interface DistrictSceneProps {
  district: District;
  tracks: RouteTrack[];
  trackColors: Array<string | null>;
  theme: ThemeName;
  reduced: boolean;
  highlight: Highlight;
  dimRoute: boolean;
}

export default function DistrictScene({ district: d, tracks, trackColors, theme, reduced, highlight, dimRoute }: DistrictSceneProps) {
  const pal = SCENE_PALETTE[theme];
  const ext = d.extent;
  // Low power (no shadows, bloom or motes; frames only while playing or interacting) until the scene's own context
  // shows a hardware GPU; the `sweep.quality` preference overrides the detection.
  const [lowPower, setLowPower] = useState(startInLowPower);
  const shadows = !lowPower;
  const hover = useWorkspace((s) => s.hover);
  const selection = useWorkspace((s) => s.selection);
  const setHover = useWorkspace((s) => s.setHover);
  const select = useWorkspace((s) => s.select);
  const playing = useWorkspace((s) => s.playing);
  const activeVehicle = useWorkspace((s) => s.activeVehicle);
  const shown = activeVehicle > 0 && tracks.length > 1 ? [activeVehicle - 1] : tracks.map((_, i) => i);
  const vehColor = (i: number) => trackColors[i] ?? (theme === 'velvet' ? '#75e0ff' : '#0a7ea6');
  return (
    <Canvas
      shadows={shadows ? { type: THREE.PCFSoftShadowMap } : false}
      dpr={lowPower ? 1 : [1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
      camera={{ fov: 38, near: 1, far: ext * 12, position: [-ext * 0.42, ext * 0.5, ext * 0.72] }}
      frameloop={(reduced || lowPower) && !playing ? 'demand' : 'always'}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = theme === 'velvet' ? 1.08 : 1.0;
        setLowPower(lowPowerFor(gl.getContext()));
      }}
      onPointerMissed={() => select(null)}
      data-testid="district-canvas"
    >
      <PerformanceMonitor onDecline={() => setLowPower(true)} flipflops={2} onFallback={() => setLowPower(true)} />
      <ClockInvalidator />
      <color attach="background" args={[pal.background]} />
      <fog attach="fog" args={[pal.fog, ext * 1.1, ext * 4.2]} />
      <hemisphereLight args={[pal.hemiSky, pal.hemiGround, theme === 'velvet' ? 1.0 : 1.35]} />
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
      <Streets d={d} pal={pal} shadows={shadows} onHover={(id) => setHover(id ? { type: 'edge', id } : null)} onSelect={(id) => select({ type: 'edge', id })} />
      <Junctions d={d} pal={pal} onHover={(id) => setHover(id ? { type: 'vertex', id } : null)} onSelect={(id) => select({ type: 'vertex', id })} />
      <Buildings d={d} pal={pal} theme={theme} shadows={shadows} />
      <Trees d={d} pal={pal} shadows={shadows} />
      {shown.map((i) => <RouteTube key={`t${i}-${tracks.length}`} track={tracks[i]!} d={d} theme={theme} tint={tracks.length > 1 ? vehColor(i) : null} reduced={reduced} dimmed={dimRoute} />)}
      {shown.map((i) => (
        <Vehicle key={`v${i}-${tracks.length}`} track={tracks[i]!} d={d} pal={pal} color={vehColor(i)} index={i === shown[0] ? 0 : i + 1} />
      ))}
      {!lowPower && <Atmosphere track={tracks[shown[0] ?? 0] ?? null} d={d} theme={theme} reduced={reduced} />}
      <Highlights
        d={d}
        pal={pal}
        highlight={highlight}
        hoverVertex={hover?.type === 'vertex' ? hover.id : null}
        hoverEdge={hover?.type === 'edge' ? hover.id : null}
        selectedVertex={selection?.type === 'vertex' ? selection.id : null}
        selectedEdge={selection?.type === 'edge' ? selection.id : null}
        reduced={reduced}
      />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI * 0.47} minDistance={ext * 0.05} maxDistance={ext * 3} screenSpacePanning={false} />
      <CameraRig d={d} tracks={shown.map((i) => tracks[i]!)} reduced={reduced} />
      {!lowPower && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={theme === 'velvet' ? 0.9 : 0.35} luminanceThreshold={theme === 'velvet' ? 0.62 : 0.9} luminanceSmoothing={0.22} mipmapBlur />
          <Vignette eskil={false} offset={0.28} darkness={theme === 'velvet' ? 0.6 : 0.22} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
