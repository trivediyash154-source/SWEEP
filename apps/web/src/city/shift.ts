import { create } from 'zustand';
import type { VehiclePose } from './GeoCityScene';

/** Shift clock state: seconds since shift start, playback and the time of day the shift starts. */
interface ShiftState {
  t: number;
  playing: boolean;
  /** Shift start, seconds after midnight (default 06:00). */
  startOfDay: number;
  setT: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setStartOfDay: (s: number) => void;
}

export const useShift = create<ShiftState>((set) => ({
  t: 0,
  playing: false,
  startOfDay: 6 * 3600,
  setT: (t) => set({ t }),
  setPlaying: (playing) => set({ playing }),
  setStartOfDay: (startOfDay) => set({ startOfDay }),
}));

/** Playback runs at a fixed rate: one minute of shift per second. Scrubbing jumps anywhere. */
export const SHIFT_SECONDS_PER_SECOND = 60;

/** Vehicle poses read by the 3D scene every frame. */
export const vehiclePoses: { current: VehiclePose[] } = { current: [] };
