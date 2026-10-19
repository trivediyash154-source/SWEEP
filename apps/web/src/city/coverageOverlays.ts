import type { SceneOverlays } from './GeoCityScene';

const EMPTY = { paths: [], highlights: [], markers: [], zone: null, vehicles: undefined } as const;

/** Coverage and fleet layers (filled in by the coverage workspace). */
export function useCoverageOverlays(): Pick<SceneOverlays, 'paths' | 'highlights' | 'markers' | 'zone'> & { vehicles: SceneOverlays['vehicles'] | undefined } {
  return EMPTY as unknown as Pick<SceneOverlays, 'paths' | 'highlights' | 'markers' | 'zone'> & { vehicles: undefined };
}
