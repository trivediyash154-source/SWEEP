/**
 * WebGL capability helpers.
 *
 * No throwaway context is created to probe the GPU. On software rasterisers
 * (SwiftShader, llvmpipe) a probe context that was created and then lost before
 * the scene created its own made the page's main thread block inside a
 * synchronous GPU call: about 1 in 6 page loads of /workspace in headless
 * Chromium stalled with JavaScript unresponsive, and none did once the probe was
 * removed (60 loads each). The renderer is identified from the scene's own
 * context instead, right after it is created.
 */

/** Whether the WebGL API exists. Context creation can still fail; scenes are wrapped in `WebGLBoundary`. */
export function webglAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window.WebGL2RenderingContext || window.WebGLRenderingContext);
  } catch {
    return false;
  }
}

/** Whether a live context is rasterised in software (SwiftShader, llvmpipe, Microsoft Basic Render…). */
export function isSoftwareContext(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

/** The `sweep.quality` preference: 'full', 'low', or null for automatic. */
export function qualityPreference(): 'full' | 'low' | null {
  try {
    const q = localStorage.getItem('sweep.quality');
    return q === 'full' || q === 'low' ? q : null;
  } catch {
    return null;
  }
}

/**
 * Initial 3D quality, before the renderer is known: the preference if set,
 * otherwise low power (the safe choice on software rasterisers). A scene leaves
 * low power through `lowPowerFor` once its own context shows a hardware GPU.
 */
export function startInLowPower(): boolean {
  return qualityPreference() !== 'full';
}

/** Quality for a scene whose context now exists: the preference wins, otherwise low only on software rasterisers. */
export function lowPowerFor(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  const q = qualityPreference();
  return q === null ? isSoftwareContext(gl) : q === 'low';
}
