// exchange-cache.ts — imported files, kept as B-rep in this browser.
//
// Reading a STEP file is slow: the file is downloaded (it may be tens of megabytes) and translated entity by
// entity, on every reload and for every collaborator.  What comes out is the same every time, so the Import
// feature keeps it: each body as OpenCascade's own BREP text, with its name, in IndexedDB.  The next evaluation
// of that feature in this browser, in any tab, reads the BREP back (many times faster than the translation) and
// does not download the file at all.
//
//   key     the file's document id, its size and path, and how the feature splits it.  A file stored with the
//           project is never rewritten in place (a new upload is a new document), so the id names its content.
//   kept    the newest few files (KEEP); a browser that refuses the storage simply reads the file each time.
//
// The page and the worker both have IndexedDB; node (the tests, the assistant's host) has none and reads the
// file.  A test supplies a store of its own as `globalThis.__junctionImportCache`.
export interface CachedImport { v: 1; bodies: { brep: string; name: string }[]; sheets: number }
export interface ImportCache { get(key: string): Promise<CachedImport | null>; set(key: string, value: CachedImport): Promise<void> }

const DB = "junction-cad-imports", STORE = "shapes", KEEP = 6;

export function importKey(file: { docId: string; path: string; bytes?: number }, split: string): string {
  return `1|${file.docId}|${file.bytes ?? "?"}|${file.path}|${split}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const done = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

const idb: ImportCache = {
  async get(key) {
    const db = await open();
    try {
      const row = await done(db.transaction(STORE, "readonly").objectStore(STORE).get(key)) as { at: number; value: CachedImport } | undefined;
      return row && row.value && row.value.v === 1 ? row.value : null;
    } finally { db.close(); }
  },
  async set(key, value) {
    const db = await open();
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      await done(store.put({ at: Date.now(), value }, key));
      // the oldest go once there are more than a few: these are large
      const keys = await done(store.getAllKeys()) as string[];
      if (keys.length > KEEP) {
        const rows = await Promise.all(keys.map(async (k) => ({ k, at: ((await done(store.get(k))) as { at?: number } | undefined)?.at || 0 })));
        rows.sort((a, b) => a.at - b.at);
        for (const r of rows.slice(0, rows.length - KEEP)) store.delete(r.k);
      }
    } finally { db.close(); }
  },
};

/** The store to use here, or null when there is none (node). */
export function importCache(): ImportCache | null {
  const hook = (globalThis as { __junctionImportCache?: ImportCache }).__junctionImportCache;
  if (hook) return hook;
  return typeof indexedDB !== "undefined" ? idb : null;
}
