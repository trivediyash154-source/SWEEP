let probed: { available: boolean; software: boolean } | null = null;

/**
 * One feature probe per page: whether WebGL works, and whether it is rasterised in
 * software (SwiftShader, llvmpipe, Microsoft Basic Render…), as on machines without
 * GPU acceleration. The probe context is released straight away, so pages never
 * hold more than the scene's own context.
 */
function probe(): { available: boolean; software: boolean } {
  if (probed) return probed;
  probed = { available: false, software: false };
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      probed = { available: true, software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name) };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // no WebGL: keep the defaults
  }
  return probed;
}

/** Whether WebGL can be used (feature-detected once, never throws). */
export function webglAvailable(): boolean {
  return probe().available;
}

/** Whether WebGL is rasterised in software; the 3D scene then starts in low-power mode. */
export function softwareRenderer(): boolean {
  return probe().software;
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
