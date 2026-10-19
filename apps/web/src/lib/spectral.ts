/**
 * The spectral signature: one shared palette for the 3D route shader, the 2D
 * projection, the playback progress indicator and selected route segments.
 * It identifies the route and its motion and is not used for anything else.
 */
export type ThemeName = 'velvet' | 'porcelain';

export const SPECTRAL_STOPS: Record<ThemeName, string[]> = {
  // rose → gold → cyan → lavender → coral
  velvet: ['#f3a7c4', '#ffd98c', '#75e0ff', '#b7a6ff', '#ff7a93'],
  porcelain: ['#d2508a', '#c08a1e', '#0a7ea6', '#6148d1', '#d23c5a'],
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RGB: Record<ThemeName, Array<[number, number, number]>> = {
  velvet: SPECTRAL_STOPS.velvet.map(hexToRgb),
  porcelain: SPECTRAL_STOPS.porcelain.map(hexToRgb),
};

/** Colour at loop position u (any real number; the palette repeats every 1). */
export function spectralRgb(u: number, theme: ThemeName): [number, number, number] {
  const stops = RGB[theme];
  const t = ((u % 1) + 1) % 1;
  const f = t * stops.length;
  const i = Math.floor(f);
  const a = stops[i % stops.length]!;
  const b = stops[(i + 1) % stops.length]!;
  const k = f - i;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function spectralCss(u: number, theme: ThemeName, alpha = 1): string {
  const [r, g, b] = spectralRgb(u, theme);
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}

/** Distinct, theme-tuned colours for fleet vehicles (index 0 = vehicle 1). */
export const VEHICLE_COLORS: Record<ThemeName, string[]> = {
  velvet: ['#75e0ff', '#f3a7c4', '#ffd98c', '#b7a6ff', '#8ef0c4', '#ff9d6d', '#e2b6ff', '#9fd0ff', '#ffc2d6', '#d6f28e', '#ffe3a3', '#a6fff0'],
  porcelain: ['#0a7ea6', '#c23d78', '#9a6d1f', '#5b42c6', '#1d8a5c', '#c4572a', '#8a3fb0', '#2f6fb8', '#b0335e', '#5f8a1d', '#a87418', '#178a86'],
};

export function vehicleColor(i: number, theme: ThemeName): string {
  const list = VEHICLE_COLORS[theme];
  return list[i % list.length]!;
}
