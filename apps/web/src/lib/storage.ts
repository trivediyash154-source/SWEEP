import type { Graph } from '@sweep/engine';

/** Browser storage helpers. Every access is guarded: storage may be unavailable. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export interface LocalScenario {
  id: string;
  name: string;
  graph: Graph;
  updatedAt: number;
}

const KEY = 'sweep.localScenarios.v1';

export function listLocalScenarios(): LocalScenario[] {
  const list = readJson<LocalScenario[]>(KEY, []);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.id === 'string' && s.graph && Array.isArray(s.graph.vertices)) : [];
}

export function saveLocalScenario(s: LocalScenario): boolean {
  const list = listLocalScenarios().filter((x) => x.id !== s.id);
  list.unshift(s);
  return writeJson(KEY, list.slice(0, 50));
}

export function deleteLocalScenario(id: string): void {
  writeJson(KEY, listLocalScenarios().filter((x) => x.id !== id));
}

export function newId(prefix = 'local'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'sweep';
}
