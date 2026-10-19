import type { CityBundle, CityModel } from './types.js';

export class CityFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CityFormatError';
  }
}

const isIntArray = (a: unknown, len?: number): a is number[] => Array.isArray(a) && (len === undefined || a.length === len) && a.every((x) => Number.isInteger(x));

/** Validate a serialized city dataset and decode it into typed arrays (metres). */
export function decodeCityBundle(raw: unknown): CityModel {
  if (!raw || typeof raw !== 'object') throw new CityFormatError('Not a city dataset.');
  const b = raw as CityBundle;
  if (b.format !== 'sweep-city/1') throw new CityFormatError(`Unsupported city format "${String((b as { format?: unknown }).format)}".`);
  const net = b.network;
  const bl = b.buildings;
  if (!net || !bl) throw new CityFormatError('Missing network or buildings.');
  const nN = net.nodeOsm?.length ?? 0;
  const nS = net.segU?.length ?? 0;
  const nB = bl.osm?.length ?? 0;
  const checks: [unknown, number | undefined, string][] = [
    [net.nodeE7, nN * 2, 'nodeE7'],
    [net.nodeDm, nN * 2, 'nodeDm'],
    [net.segV, nS, 'segV'],
    [net.segLenDm, nS, 'segLenDm'],
    [net.segWay, nS, 'segWay'],
    [net.segOneway, nS, 'segOneway'],
    [net.segShapeOff, nS + 1, 'segShapeOff'],
    [net.shapeDm, undefined, 'shapeDm'],
    [bl.ringOff, nB + 1, 'ringOff'],
    [bl.ringDm, undefined, 'ringDm'],
    [bl.heightDm, nB, 'heightDm'],
    [bl.heightSrc, nB, 'heightSrc'],
    [bl.levels, nB, 'levels'],
    [bl.kind, nB, 'kind'],
  ];
  for (const [arr, len, name] of checks) if (!isIntArray(arr, len)) throw new CityFormatError(`Field ${name} is malformed.`);
  for (let i = 0; i < nS; i++) {
    const u = net.segU[i]!;
    const v = net.segV[i]!;
    if (u < 0 || u >= nN || v < 0 || v >= nN) throw new CityFormatError(`Segment ${i} references a missing node.`);
    if (net.segWay[i]! < 0 || net.segWay[i]! >= net.ways.length) throw new CityFormatError(`Segment ${i} references a missing way.`);
  }
  if (net.segShapeOff[nS] !== net.shapeDm.length / 2) throw new CityFormatError('Shape offsets do not match the shape array.');
  if (bl.ringOff[nB] !== bl.ringDm.length / 2) throw new CityFormatError('Ring offsets do not match the ring array.');

  const nodeX = new Float64Array(nN);
  const nodeY = new Float64Array(nN);
  const nodeLon = new Float64Array(nN);
  const nodeLat = new Float64Array(nN);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nN; i++) {
    nodeX[i] = net.nodeDm[2 * i]! / 10;
    nodeY[i] = net.nodeDm[2 * i + 1]! / 10;
    nodeLon[i] = net.nodeE7[2 * i]! / 1e7;
    nodeLat[i] = net.nodeE7[2 * i + 1]! / 1e7;
    if (nodeX[i]! < minX) minX = nodeX[i]!;
    if (nodeX[i]! > maxX) maxX = nodeX[i]!;
    if (nodeY[i]! < minY) minY = nodeY[i]!;
    if (nodeY[i]! > maxY) maxY = nodeY[i]!;
  }
  // Segment polylines including both endpoints.
  const segPtOff = new Int32Array(nS + 1);
  for (let i = 0; i < nS; i++) segPtOff[i + 1] = segPtOff[i]! + 2 + (net.segShapeOff[i + 1]! - net.segShapeOff[i]!);
  const segXY = new Float64Array(segPtOff[nS]! * 2);
  for (let i = 0; i < nS; i++) {
    let k = segPtOff[i]! * 2;
    const u = net.segU[i]!;
    const v = net.segV[i]!;
    segXY[k++] = nodeX[u]!;
    segXY[k++] = nodeY[u]!;
    for (let j = net.segShapeOff[i]!; j < net.segShapeOff[i + 1]!; j++) {
      segXY[k++] = net.shapeDm[2 * j]! / 10;
      segXY[k++] = net.shapeDm[2 * j + 1]! / 10;
    }
    segXY[k++] = nodeX[v]!;
    segXY[k++] = nodeY[v]!;
  }
  const bRingXY = new Float32Array(bl.ringDm.length);
  for (let i = 0; i < bl.ringDm.length; i++) bRingXY[i] = bl.ringDm[i]! / 10;
  for (let i = 0; i < bRingXY.length; i += 2) {
    if (bRingXY[i]! < minX) minX = bRingXY[i]!;
    if (bRingXY[i]! > maxX) maxX = bRingXY[i]!;
    if (bRingXY[i + 1]! < minY) minY = bRingXY[i + 1]!;
    if (bRingXY[i + 1]! > maxY) maxY = bRingXY[i + 1]!;
  }
  const kx = (Math.PI / 180) * 6_371_008.8 * Math.cos((b.origin[1] * Math.PI) / 180);
  const ky = (Math.PI / 180) * 6_371_008.8;
  const [rs, rw, rn, re] = b.provenance.bbox;
  const region = { minX: (rw - b.origin[0]) * kx, maxX: (re - b.origin[0]) * kx, minY: -(rn - b.origin[1]) * ky, maxY: -(rs - b.origin[1]) * ky };
  const focus = b.focus ? { ...b.focus, xy: [(b.focus.lonlat[0] - b.origin[0]) * kx, -(b.focus.lonlat[1] - b.origin[1]) * ky] as [number, number] } : undefined;
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    origin: b.origin,
    ...(focus ? { focus } : {}),
    provenance: b.provenance,
    stats: b.stats,
    bounds: { minX, minY, maxX, maxY },
    region,
    nodeCount: nN,
    nodeOsm: Float64Array.from(net.nodeOsm),
    nodeLon,
    nodeLat,
    nodeX,
    nodeY,
    segCount: nS,
    segU: Int32Array.from(net.segU),
    segV: Int32Array.from(net.segV),
    segLen: Float64Array.from(net.segLenDm, (x) => x / 10),
    segWay: Int32Array.from(net.segWay),
    segOneway: Uint8Array.from(net.segOneway),
    segPtOff,
    segXY,
    ways: net.ways,
    restrictions: net.restrictions ?? [],
    buildingCount: nB,
    bOsm: Float64Array.from(bl.osm),
    bRingOff: Int32Array.from(bl.ringOff),
    bRingXY,
    bHeight: Float32Array.from(bl.heightDm, (x) => x / 10),
    bHeightSrc: Uint8Array.from(bl.heightSrc),
    bLevels: Int16Array.from(bl.levels),
    bKind: Uint16Array.from(bl.kind),
    bKinds: bl.kinds,
  };
}
