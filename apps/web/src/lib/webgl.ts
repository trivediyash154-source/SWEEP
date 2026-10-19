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

let software: boolean | null = null;

/**
 * Whether WebGL is rasterised in software (SwiftShader, llvmpipe, Microsoft Basic Render…),
 * as on machines without GPU acceleration. The 3D scene then starts in low-power mode.
 */
export function softwareRenderer(): boolean {
  if (software !== null) return software;
  software = false;
  try {
    const gl = (document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')) as WebGLRenderingContext | null;
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    software = false;
  }
  return software;
}

/** Initial 3D quality: the `sweep.quality` preference ('full' | 'low') wins, otherwise low on software renderers. */
export function startInLowPower(): boolean {
  try {
    const q = localStorage.getItem('sweep.quality');
    if (q === 'full') return false;
    if (q === 'low') return true;
  } catch {
    // storage unavailable: fall through to detection
  }
  return softwareRenderer();
}
