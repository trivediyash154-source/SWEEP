import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  title: string;
  body?: string;
  /** How long the toast stays on screen, counted only while it is visible and the page is responsive (0 = until dismissed). */
  ttlMs: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'ttlMs'>, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

let n = 0;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ttlMs = 5200) => {
    const id = ++n;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id, ttlMs }] });
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
}));

export const toast = {
  success: (title: string, body?: string) => useToasts.getState().push({ kind: 'success', title, ...(body ? { body } : {}) }),
  error: (title: string, body?: string) => useToasts.getState().push({ kind: 'error', title, ...(body ? { body } : {}) }, 8000),
  info: (title: string, body?: string) => useToasts.getState().push({ kind: 'info', title, ...(body ? { body } : {}) }),
};
