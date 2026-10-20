import { useEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { District } from './district';
import { createBuildingMaterial, createGableGeometry } from './materials';
import { sampleTrack, type RouteTrack } from '../lib/routeTrack';
import type { ThemeName } from '../lib/spectral';

/**
 * The static parts of a procedural district scene, shared by the network lab (`DistrictScene`) and the landing
 * hero (`HeroScene`): palette, ground, streets, junctions, buildings, trees and the route tube geometry. Street
 * and junction handlers are optional, so the hero renders the same district without interaction.
 */

export const SCENE_PALETTE = {
  velvet: {
    background: '#1b0d2b',
    fog: '#22102f',
    ground: '#2b1a40',
    plate: '#33204b',
    grid: 'rgba(233,201,140,0.07)',
    sidewalk: '#4a3666',
    road: '#3d2e55',
    roadRequired: '#4b3a66',
    roadEdge: '#e9c98c',
    dash: '#e9c98c',
    arrow: '#ffd98c',
    junction: '#5a4475',
    building: ['#6d5a8f', '#7a669c', '#8571a6', '#62508a', '#9280b2'],
    roof: ['#a493c4', '#b09fce', '#9787b8'],
    trunk: '#4a2a3a',
    canopy: ['#f3a7c4', '#e98bb0', '#ffc2d6'],
    hemiSky: '#c9b8ff',
    hemiGround: '#3a1838',
    sun: '#ffd9b8',
    vehicle: '#fff1dc',
    marks: { odd: '#b7a6ff', even: '#8b7aa8', surplus: '#ff9d6d', deficit: '#75e0ff', matched: '#ffd98c', focus: '#ffffff', path: '#ffd98c', added: '#ff6d86', hover: '#f3a7c4' },
  },
  porcelain: {
    background: '#f3eee5',
    fog: '#efe8dc',
    ground: '#e9e1d3',
    plate: '#f4efe6',
    grid: 'rgba(64,33,76,0.06)',
    sidewalk: '#fbf8f2',
    road: '#d9cfc0',
    roadRequired: '#c9bba8',
    roadEdge: '#6b5a7a',
    dash: '#ffffff',
    arrow: '#2c1a3a',
    junction: '#e4dacb',
    building: ['#ffffff', '#fbf8f2', '#f6f1e8', '#fdfbf7', '#f1ebe0'],
    roof: ['#f6efe4', '#efe6d8', '#fbf5ec'],
    trunk: '#b8a99a',
    canopy: ['#f4cddc', '#f8dfe8', '#efc1d3'],
    hemiSky: '#ffffff',
    hemiGround: '#d8ccbb',
    sun: '#fff6e8',
    vehicle: '#2c1a3a',
    marks: { odd: '#6148d1', even: '#a99db0', surplus: '#c4572a', deficit: '#0a7ea6', matched: '#9a6d1f', focus: '#2c1a3a', path: '#9a6d1f', added: '#d23c5a', hover: '#c23d78' },
  },
} as const;

type Widen<T> = T extends string ? string : T extends readonly (infer U)[] ? readonly Widen<U>[] : { readonly [K in keyof T]: Widen<T[K]> };
/** A scene palette: the shape of SCENE_PALETTE's themes, with any colours (the landing hero tunes a few). */
export type Pal = Widen<(typeof SCENE_PALETTE)[ThemeName]>;

export const tmpM = new THREE.Matrix4();
export const tmpQ = new THREE.Quaternion();
export const tmpS = new THREE.Vector3();
export const tmpP = new THREE.Vector3();
export const UP = new THREE.Vector3(0, 1, 0);

export function useInstances(ref: React.RefObject<THREE.InstancedMesh | null>, count: number, fill: (i: number, m: THREE.Matrix4, c: THREE.Color) => void, deps: unknown[]) {
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      fill(i, tmpM, c);
      mesh.setMatrixAt(i, tmpM);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* ------------------------------------------------------------------ ground */
export function Ground({ d, pal, shadows }: { d: District; pal: Pal; shadows: boolean }) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = pal.plate;
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = pal.grid;
    g.lineWidth = 2;
    for (let i = 0; i <= 256; i += 32) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 256);
      g.moveTo(0, i);
      g.lineTo(256, i);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(10, 10);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [pal]);
  useEffect(() => () => tex.dispose(), [tex]);
  const size = d.extent * 1.35;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]} receiveShadow={shadows}>
        <planeGeometry args={[d.extent * 9, d.extent * 9]} />
        <meshStandardMaterial color={pal.ground} roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow={shadows}>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial map={tex} roughness={0.95} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------- streets */
export function Streets({ d, pal, shadows, onHover, onSelect }: { d: District; pal: Pal; shadows: boolean; onHover?: (id: string | null) => void; onSelect?: (id: string) => void }) {
  const walk = useRef<THREE.InstancedMesh>(null);
  const road = useRef<THREE.InstancedMesh>(null);
  const dash = useRef<THREE.InstancedMesh>(null);
  const arrow = useRef<THREE.InstancedMesh>(null);
  const n = d.roads.length;
  const place = (i: number, m: THREE.Matrix4, width: number, y: number, h: number, extra = 0) => {
    const r = d.roads[i]!;
    const dx = r.bx - r.ax;
    const dz = r.bz - r.az;
    tmpP.set((r.ax + r.bx) / 2, y, (r.az + r.bz) / 2);
    tmpQ.setFromAxisAngle(UP, -Math.atan2(dz, dx));
    tmpS.set(Math.hypot(dx, dz) + extra, h, width);
    m.compose(tmpP, tmpQ, tmpS);
  };
  useInstances(walk, n, (i, m, c) => {
    const r = d.roads[i]!;
    place(i, m, d.roadW * (r.required ? 2.05 : 1.7), 0.35, 0.7, d.roadW * 0.9);
    c.set(pal.sidewalk);
  }, [d, pal]);
  useInstances(road, n, (i, m, c) => {
    const r = d.roads[i]!;
    place(i, m, d.roadW * (r.required ? 1.0 : 0.72), 0.75, 0.5, d.roadW * 0.55);
    c.set(r.required ? pal.roadRequired : pal.road);
  }, [d, pal]);
  useInstances(dash, d.dashes.length, (i, m, c) => {
    const k = d.dashes[i]!;
    tmpP.set(k.x, 1.04, k.z);
    tmpQ.setFromAxisAngle(UP, -k.rot);
    tmpS.set(k.len, 0.08, d.roadW * 0.07);
    m.compose(tmpP, tmpQ, tmpS);
    c.set(pal.dash);
  }, [d, pal]);
  useInstances(arrow, d.arrows.length, (i, m, c) => {
    const k = d.arrows[i]!;
    tmpP.set(k.x, 1.06, k.z);
    tmpQ.setFromAxisAngle(UP, -k.rot);
    tmpS.set(k.len, 1, k.len * 0.62);
    m.compose(tmpP, tmpQ, tmpS);
    c.set(pal.arrow);
  }, [d, pal]);
  const arrowGeo = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(0.5, 0);
    s.lineTo(-0.5, 0.5);
    s.lineTo(-0.2, 0);
    s.lineTo(-0.5, -0.5);
    s.closePath();
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const ev = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.instanceId !== undefined) onHover?.(d.roads[e.instanceId]?.edgeId ?? null);
  };
  return (
    <group>
      <instancedMesh ref={walk} args={[undefined, undefined, n]} receiveShadow={shadows} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh
        ref={road}
        args={[undefined, undefined, n]}
        receiveShadow={shadows}
        frustumCulled={false}
        onPointerMove={ev}
        onPointerOut={() => onHover?.(null)}
        onClick={(e) => {
          e.stopPropagation();
          if (e.instanceId !== undefined && d.roads[e.instanceId]) onSelect?.(d.roads[e.instanceId]!.edgeId);
        }}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.7} metalness={0.05} />
      </instancedMesh>
      {d.dashes.length > 0 && (
        <instancedMesh ref={dash} args={[undefined, undefined, d.dashes.length]} frustumCulled={false} raycast={() => null}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial toneMapped={false} transparent opacity={0.7} />
        </instancedMesh>
      )}
      {d.arrows.length > 0 && (
        <instancedMesh ref={arrow} args={[arrowGeo, undefined, d.arrows.length]} frustumCulled={false} raycast={() => null}>
          <meshBasicMaterial toneMapped={false} side={THREE.DoubleSide} />
        </instancedMesh>
      )}
    </group>
  );
}

/* ------------------------------------------------------------ junctions */
export function Junctions({ d, pal, onHover, onSelect }: { d: District; pal: Pal; onHover?: (id: string | null) => void; onSelect?: (id: string) => void }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const r = d.roadW * 0.95;
  useInstances(ref, d.junctions.length, (i, m, c) => {
    const j = d.junctions[i]!;
    m.makeTranslation(j.x, 0.9, j.z);
    c.set(pal.junction);
  }, [d, pal]);
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, d.junctions.length]}
      frustumCulled={false}
      onPointerMove={(e) => {
        e.stopPropagation();
        if (e.instanceId !== undefined) onHover?.(d.junctions[e.instanceId]?.id ?? null);
      }}
      onPointerOut={() => onHover?.(null)}
      onClick={(e) => {
        e.stopPropagation();
        if (e.instanceId !== undefined && d.junctions[e.instanceId]) onSelect?.(d.junctions[e.instanceId]!.id);
      }}
    >
      <cylinderGeometry args={[r, r, 0.9, 20]} />
      <meshStandardMaterial roughness={0.6} />
    </instancedMesh>
  );
}

/* ------------------------------------------------------------ buildings */
export function Buildings({ d, pal, theme, shadows }: { d: District; pal: Pal; theme: ThemeName; shadows: boolean }) {
  const boxes = useRef<THREE.InstancedMesh>(null);
  const cyl = useRef<THREE.InstancedMesh>(null);
  const gab = useRef<THREE.InstancedMesh>(null);
  const floorH = Math.max(3, d.extent * (d.style === 'historic' ? 0.0062 : 0.0075));
  const material = useMemo(() => createBuildingMaterial(theme, floorH), [theme, floorH]);
  const roofMat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: theme === 'velvet' ? 0.55 : 0.85, metalness: 0.05 }), [theme]);
  useEffect(() => () => {
    material.dispose();
    roofMat.dispose();
  }, [material, roofMat]);
  const boxGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const cylGeo = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 28).translate(0, 0.5, 0), []);
  const gableGeo = useMemo(() => createGableGeometry(), []);
  const tone = (t: number, list: readonly string[], c: THREE.Color) => c.set(list[Math.floor(t * list.length) % list.length]!);
  useInstances(boxes, d.boxes.length, (i, m, c) => {
    const b = d.boxes[i]!;
    tmpP.set(b.x, b.y, b.z);
    tmpQ.setFromAxisAngle(UP, b.rot);
    tmpS.set(b.w, b.h, b.d);
    m.compose(tmpP, tmpQ, tmpS);
    tone(b.tone, pal.building, c);
  }, [d, pal]);
  useInstances(cyl, d.cylinders.length, (i, m, c) => {
    const b = d.cylinders[i]!;
    tmpP.set(b.x, b.y, b.z);
    tmpQ.identity();
    tmpS.set(b.w, b.h, b.w);
    m.compose(tmpP, tmpQ, tmpS);
    tone(b.tone, pal.building, c);
  }, [d, pal]);
  useInstances(gab, d.gables.length, (i, m, c) => {
    const b = d.gables[i]!;
    tmpP.set(b.x, b.y, b.z);
    tmpQ.setFromAxisAngle(UP, b.rot);
    tmpS.set(b.w, b.h, b.d);
    m.compose(tmpP, tmpQ, tmpS);
    tone(b.tone, pal.roof, c);
  }, [d, pal]);
  return (
    <group>
      {d.boxes.length > 0 && <instancedMesh ref={boxes} args={[boxGeo, material, d.boxes.length]} castShadow={shadows} receiveShadow={shadows} frustumCulled={false} raycast={() => null} />}
      {d.cylinders.length > 0 && <instancedMesh ref={cyl} args={[cylGeo, material, d.cylinders.length]} castShadow={shadows} receiveShadow={shadows} frustumCulled={false} raycast={() => null} />}
      {d.gables.length > 0 && <instancedMesh ref={gab} args={[gableGeo, roofMat, d.gables.length]} castShadow={shadows} receiveShadow={shadows} frustumCulled={false} raycast={() => null} />}
    </group>
  );
}

/* --------------------------------------------------------------- trees */
export function Trees({ d, pal, shadows }: { d: District; pal: Pal; shadows: boolean }) {
  const trunk = useRef<THREE.InstancedMesh>(null);
  const crown = useRef<THREE.InstancedMesh>(null);
  const n = d.trees.length;
  useInstances(trunk, n, (i, m, c) => {
    const t = d.trees[i]!;
    tmpP.set(t.x, t.s * 0.55, t.z);
    tmpQ.identity();
    tmpS.set(t.s * 0.12, t.s * 1.1, t.s * 0.12);
    m.compose(tmpP, tmpQ, tmpS);
    c.set(pal.trunk);
  }, [d, pal]);
  useInstances(crown, n, (i, m, c) => {
    const t = d.trees[i]!;
    tmpP.set(t.x, t.s * 1.35, t.z);
    tmpQ.setFromAxisAngle(UP, t.tone * 6);
    tmpS.set(t.s * 0.82, t.s * 0.66, t.s * 0.82);
    m.compose(tmpP, tmpQ, tmpS);
    c.set(pal.canopy[Math.floor(t.tone * pal.canopy.length) % pal.canopy.length]!);
  }, [d, pal]);
  if (n === 0) return null;
  return (
    <group>
      <instancedMesh ref={trunk} args={[undefined, undefined, n]} castShadow={shadows} frustumCulled={false} raycast={() => null}>
        <cylinderGeometry args={[1, 1.2, 1, 6]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={crown} args={[undefined, undefined, n]} castShadow={shadows} frustumCulled={false} raycast={() => null}>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial roughness={0.7} emissive={pal.canopy[0]} emissiveIntensity={pal === SCENE_PALETTE.velvet ? 0.18 : 0} flatShading />
      </instancedMesh>
    </group>
  );
}

/* -------------------------------------------------------- spectral route */
export function buildTube(track: RouteTrack, d: District, y: number, radius: number) {
  const pts = track.points.map((p) => new THREE.Vector3(p[0] - d.center.x, y, p[1] - d.center.z));
  const path = new THREE.CurvePath<THREE.Vector3>();
  const drawnAt: number[] = [0];
  const distAt: number[] = [track.pointDist[0] ?? 0];
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = pts[i]!.distanceTo(pts[i - 1]!);
    if (len < 1e-6) continue;
    path.add(new THREE.LineCurve3(pts[i - 1]!, pts[i]!));
    run += len;
    drawnAt.push(run);
    distAt.push(track.pointDist[i]!);
  }
  if (path.curves.length === 0) return null;
  const tubular = Math.min(9000, Math.max(160, path.curves.length * 4));
  const radial = 8;
  const geo = new THREE.TubeGeometry(path, tubular, radius, radial, false);
  const count = geo.attributes.position!.count;
  const aDist = new Float32Array(count);
  const aKind = new Float32Array(count);
  let k = 0;
  for (let i = 0; i <= tubular; i++) {
    const target = (i / tubular) * run;
    while (k < drawnAt.length - 2 && drawnAt[k + 1]! < target) k++;
    const span = drawnAt[k + 1]! - drawnAt[k]!;
    const f = span > 0 ? (target - drawnAt[k]!) / span : 0;
    const dist = distAt[k]! + (distAt[k + 1]! - distAt[k]!) * f;
    const st = sampleTrack(track, dist).stepIndex;
    const kind = track.steps[st]?.kind;
    const kv = kind === 'repeat' ? 1 : kind === 'deadhead' ? 2 : 0;
    for (let j = 0; j <= radial; j++) {
      aDist[i * (radial + 1) + j] = dist;
      aKind[i * (radial + 1) + j] = kv;
    }
  }
  geo.setAttribute('aDist', new THREE.BufferAttribute(aDist, 1));
  geo.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1));
  return geo;
}
