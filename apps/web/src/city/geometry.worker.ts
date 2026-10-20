/// <reference lib="webworker" />
import { buildBuildingChunks, buildRibbons, type BuildingInput } from './geometry';

/** Builds city meshes off the main thread; buffers are transferred, not copied. */
export interface GeometryRequest {
  buildings: BuildingInput;
  roads: { pts: Float64Array; off: Int32Array; widths: Float32Array; ranks: Float32Array };
}

self.onmessage = (ev: MessageEvent<GeometryRequest>) => {
  const t0 = performance.now();
  const chunks = buildBuildingChunks(ev.data.buildings);
  const t1 = performance.now();
  const r = ev.data.roads;
  const roads = buildRibbons(r.pts, r.off, r.widths, r.ranks, 0.12);
  const t2 = performance.now();
  const transfer: Transferable[] = [];
  for (const c of chunks) transfer.push(c.positions.buffer, c.normals.buffer, c.part.buffer, c.shade.buffer, c.facadeU.buffer, c.estimated.buffer, c.index.buffer, c.triBuilding.buffer);
  transfer.push(roads.positions.buffer, roads.rank.buffer, roads.along.buffer, roads.across.buffer, roads.index.buffer, roads.triSeg.buffer);
  (self as unknown as Worker).postMessage({ chunks, roads, ms: { buildings: t1 - t0, roads: t2 - t1 } }, transfer);
};
