// SamSpy — «Слайды»: photo pool from a folder (client only)
//
// The folder holds copies made in «Размножение»: «<original>_<n>.jpg» (1_1 … 1_5, 2_1 …).
// A group = the name without the trailing «_<n>». Slides get photos from DIFFERENT groups,
// picked at random, preferring groups not used in earlier carousels (remembered per folder).
//
//   Chrome / Edge: showDirectoryPicker — the folder handle is kept in IndexedDB, so the
//   next time one click («Открыть …») re-opens it (the browser may ask for permission).
//   Other browsers: <input webkitdirectory> — the folder is picked again every time.
// Only file names are read when the folder opens; a photo is decoded when it is picked.
//
// Version history:
//   v0.1.0 (2026-11-20) — initial: folder pool, groups, random pick of distinct groups,
//                         used-groups memory in localStorage, saved folder handle.

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const USED_KEY = 'samspy.slides.usedGroups.v1';

export interface PoolFile {
  name: string;
  path: string;
  group: string;
  get: () => Promise<File>;
}

export interface Pool {
  key: string; // folder name — key for the used-groups memory
  files: PoolFile[];
  groups: Map<string, PoolFile[]>;
}

/** «1_3.jpg» → «1», «IMG_4521 (2)_5.jpg» → «IMG_4521 (2)», «photo.jpg» → «photo». */
export function groupOf(fileName: string): string {
  const n = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = n.lastIndexOf('.');
  const base = dot > 0 ? n.slice(0, dot) : n;
  const m = /^(.+)_(\d+)$/.exec(base);
  return m ? m[1] : base;
}

function buildPool(key: string, files: PoolFile[]): Pool {
  const sorted = [...files].sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
  );
  const groups = new Map<string, PoolFile[]>();
  for (const f of sorted) {
    const list = groups.get(f.group);
    if (list) list.push(f);
    else groups.set(f.group, [f]);
  }
  return { key, files: sorted, groups };
}

// --- <input webkitdirectory> fallback --------------------------------------------------
export function poolFromFileList(list: FileList | File[] | null | undefined): Pool | null {
  const files = Array.from(list ?? []).filter((f) => !f.name.startsWith('.') && IMAGE_RE.test(f.name));
  if (!files.length) return null;
  const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const key = rel(files[0]).split('/')[0] || 'folder';
  return buildPool(
    key,
    files.map((f) => ({ name: f.name, path: rel(f), group: groupOf(f.name), get: async () => f }))
  );
}

// --- File System Access API (Chrome / Edge) ---------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
export function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';
}

async function walkDir(dir: any, prefix: string, out: PoolFile[]): Promise<void> {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'file' && IMAGE_RE.test(name)) {
      out.push({ name, path: prefix + name, group: groupOf(name), get: () => h.getFile() });
    } else if (h.kind === 'directory') {
      await walkDir(h, `${prefix}${name}/`, out);
    }
  }
}

async function poolFromHandle(handle: any): Promise<Pool | null> {
  const out: PoolFile[] = [];
  await walkDir(handle, '', out);
  return out.length ? buildPool(handle.name, out) : null;
}

// tiny IndexedDB key-value store for the folder handle
function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('samspy', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = run(tx.objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}
const HANDLE_KEY = 'slides.folder';

/** Opens the system folder picker; remembers the folder. null = cancelled / empty. */
export async function pickDirectory(): Promise<Pool | null> {
  let handle: any;
  try {
    handle = await (window as any).showDirectoryPicker({ id: 'samspy-slides', mode: 'read' });
  } catch {
    return null; // cancelled
  }
  try {
    await idb('readwrite', (s) => s.put(handle, HANDLE_KEY));
  } catch {
    /* not remembered — fine */
  }
  return poolFromHandle(handle);
}

/** Name of the remembered folder (Chrome / Edge), or null. */
export async function savedFolderName(): Promise<string | null> {
  if (!canPickDirectory()) return null;
  try {
    const h: any = await idb('readonly', (s) => s.get(HANDLE_KEY));
    return h?.name ?? null;
  } catch {
    return null;
  }
}

/** Re-opens the remembered folder. Call from a click: the browser may ask for permission. */
export async function reopenSaved(): Promise<Pool | null> {
  const h: any = await idb('readonly', (s) => s.get(HANDLE_KEY)).catch(() => null);
  if (!h) return null;
  let perm = await h.queryPermission?.({ mode: 'read' });
  if (perm !== 'granted') perm = await h.requestPermission?.({ mode: 'read' });
  if (perm !== 'granted') return null;
  return poolFromHandle(h);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --- used groups memory ---------------------------------------------------------------------
function readUsed(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(USED_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function usedGroups(poolKey: string): Set<string> {
  return new Set(readUsed()[poolKey] ?? []);
}

export function markUsed(poolKey: string, groups: string[]) {
  if (!groups.length) return;
  const all = readUsed();
  all[poolKey] = Array.from(new Set([...(all[poolKey] ?? []), ...groups]));
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(all));
  } catch {
    /* storage full */
  }
}

export function clearUsed(poolKey: string) {
  const all = readUsed();
  delete all[poolKey];
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// --- picking --------------------------------------------------------------------------------
function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export interface PickResult {
  picks: PoolFile[]; // one file per group, all groups different
  short: number; // how many were needed but no free group was left
  fromUsed: number; // picks taken from groups used in earlier carousels
}

/**
 * `n` random photos from different groups. Groups in `exclude` (already on other slides)
 * are skipped; groups never used before come first, used ones only when those run out.
 */
export function pickPhotos(pool: Pool, n: number, exclude: Set<string>, used: Set<string>): PickResult {
  const free = Array.from(pool.groups.keys()).filter((g) => !exclude.has(g));
  const fresh = shuffle(free.filter((g) => !used.has(g)));
  const old = shuffle(free.filter((g) => used.has(g)));
  const order = [...fresh, ...old].slice(0, n);
  const picks = order.map((g) => {
    const list = pool.groups.get(g)!;
    return list[Math.floor(Math.random() * list.length)];
  });
  return {
    picks,
    short: Math.max(0, n - picks.length),
    fromUsed: order.filter((g) => used.has(g)).length,
  };
}
