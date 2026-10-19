/// <reference types="vite/client" />
declare const __SWEEP_STATIC__: boolean;

declare module 'earcut' {
  /** Triangulates a polygon given as flat coordinates; returns vertex indices, three per triangle. */
  export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number> | null, dim?: number): number[];
}
