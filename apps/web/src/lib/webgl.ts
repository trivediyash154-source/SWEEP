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

/**
 * Resolves once the page's text no longer needs new fonts: every Latin web-font face the app declares has loaded
 * (or failed), and two frames have been laid out with them. Start a 3D scene's code after this, not before.
 *
 * Why: on Linux, Chromium lays out text in a web font that is still loading with a system fallback font, and asks
 * for that font's settings through a synchronous font-service call. The call runs on the renderer's thread pool.
 * While the large 3D chunks compile, every pool worker can be a V8 background compile waiting for the main thread
 * to collect garbage, and the main thread is waiting for the font call: neither moves again (native stacks taken
 * during a stall showed exactly this). Loading the fonts first means no such call coincides with the compile.
 * The timeout keeps a font that never loads from holding the scene back.
 */
export function whenTextSettled(timeoutMs = 4000): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const frames = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const settled = (async () => {
    const latin = [...document.fonts].filter((f) => f.status === 'unloaded' && /U\+0000-00FF/i.test(f.unicodeRange));
    await Promise.all(latin.map((f) => f.load().catch(() => undefined)));
    await document.fonts.ready;
    await frames();
  })();
  return Promise.race([settled, new Promise<void>((done) => setTimeout(done, timeoutMs))]);
}

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
