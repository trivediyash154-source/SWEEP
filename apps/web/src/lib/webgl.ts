let cached: boolean | null = null;

/** Whether WebGL can be used (feature-detected once, never throws). */
export function webglAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    const c = document.createElement('canvas');
    cached = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    cached = false;
  }
  return cached;
}
