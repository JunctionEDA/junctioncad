// cache.ts — tessellated parts kept between visits, in IndexedDB, keyed by the document's content.
//
// Opening an assembly whose part studios have not changed since they were last built here costs no kernel at
// all: the meshes come from this cache, and the 23 MB kernel is not even fetched.  One entry per part studio
// (the newest content), so the cache cannot grow without bound.  Everything here fails soft: no IndexedDB, a
// full disk or a private window just mean the kernel runs.
import type { BodyMesh } from "../../mechanical/api";

export interface CachedBody { id: string; name: string; mesh: BodyMesh; reference?: boolean }
interface Entry { hash: string; bodies: CachedBody[]; at: number }

const DB = "junction-cad", STORE = "part-meshes";
let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return opening;
}

/** A short, stable fingerprint of a string (two 32-bit FNV-1a hashes): enough to tell one version from another. */
export function fingerprint(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b) + 0x9e3779b9; }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0") + text.length.toString(16);
}

export async function readCached(docId: string, hash: string): Promise<CachedBody[] | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(docId);
      req.onsuccess = () => { const e = req.result as Entry | undefined; resolve(e && e.hash === hash && Array.isArray(e.bodies) ? e.bodies : null); };
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

export async function writeCached(docId: string, hash: string, bodies: CachedBody[]): Promise<void> {
  const d = await db();
  if (!d) return;
  try { d.transaction(STORE, "readwrite").objectStore(STORE).put({ hash, bodies, at: Date.now() } satisfies Entry, docId); } catch (e) { /* the cache is a convenience */ }
}
