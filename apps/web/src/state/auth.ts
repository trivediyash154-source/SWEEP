import { create } from 'zustand';
import { api, ApiRequestError, serverAvailable } from '../lib/api';

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
}

interface AuthState {
  status: 'unknown' | 'loading' | 'signed-in' | 'signed-out' | 'unavailable';
  user: User | null;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: User | null) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'unknown',
  user: null,
  refresh: async () => {
    if (!(await serverAvailable())) {
      set({ status: 'unavailable', user: null });
      return;
    }
    if (get().status === 'unknown') set({ status: 'loading' });
    try {
      const d = await api<{ user: User | null }>('/auth/me');
      set({ user: d.user, status: d.user ? 'signed-in' : 'signed-out' });
    } catch (err) {
      set({ user: null, status: err instanceof ApiRequestError && err.status === 0 ? 'unavailable' : 'signed-out' });
    }
  },
  signIn: async (email, password) => {
    const d = await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } });
    set({ user: d.user, status: 'signed-in' });
  },
  register: async (email, password, displayName) => {
    const d = await api<{ user: User }>('/auth/register', { method: 'POST', body: { email, password, displayName } });
    set({ user: d.user, status: 'signed-in' });
  },
  signOut: async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } finally {
      set({ user: null, status: 'signed-out' });
    }
  },
  setUser: (user) => set({ user, status: user ? 'signed-in' : 'signed-out' }),
}));
