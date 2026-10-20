import { create } from 'zustand';
import { readJson, writeJson } from '../lib/storage';

export type Theme = 'velvet' | 'porcelain';
export type MotionPref = 'system' | 'full' | 'reduced';

interface PrefsState {
  theme: Theme;
  motion: MotionPref;
  petals: boolean;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setMotion: (m: MotionPref) => void;
  setPetals: (on: boolean) => void;
}

const initialTheme = (): Theme => {
  const attr = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  return attr === 'porcelain' ? 'porcelain' : 'velvet';
};

function applyMotion(m: MotionPref): void {
  const root = document.documentElement;
  if (m === 'reduced') root.setAttribute('data-motion', 'reduced');
  else root.removeAttribute('data-motion');
}

export const usePrefs = create<PrefsState>((set, get) => ({
  theme: initialTheme(),
  motion: readJson<MotionPref>('sweep.motion', 'system'),
  petals: readJson<boolean>('sweep.petals', true),
  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'velvet' ? '#1D0F2E' : '#F4F0E8');
    try {
      localStorage.setItem('sweep.theme', theme);
    } catch {
      /* storage unavailable */
    }
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'velvet' ? 'porcelain' : 'velvet'),
  setMotion: (motion) => {
    writeJson('sweep.motion', motion);
    applyMotion(motion);
    set({ motion });
  },
  setPetals: (petals) => {
    writeJson('sweep.petals', petals);
    set({ petals });
  },
}));

if (typeof document !== 'undefined') applyMotion(usePrefs.getState().motion);

/** True when animation should be minimised (system setting or user override). */
export function useReducedMotion(): boolean {
  const motion = usePrefs((s) => s.motion);
  const system = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (motion === 'reduced') return true;
  if (motion === 'full') return false;
  return !!system;
}
