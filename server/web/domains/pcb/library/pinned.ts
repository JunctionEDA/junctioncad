// library/pinned.ts — the pinned libraries every library tree of a kind shares (PROJECT::PinLibrary over the common
// settings' session pinned_symbol_libs / pinned_footprint_libs, read by every LIB_TREE_MODEL_ADAPTER): a library pinned
// in the symbol chooser is pinned in the Symbol Editor's tree too, and the same for footprints.  Kept per viewer.
export type PinKind = "symbol" | "footprint";
const KEY = (k: PinKind): string => "kui.libtree.pinned." + k;
// the keys the editors' trees kept before they shared the chooser's: read once and folded in
const OLD: Record<PinKind, string> = { symbol: "kui.symedit.pinned", footprint: "kui.fpedit.pinned" };

function read(key: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
export function loadPinnedLibs(kind: PinKind): Set<string> {
  const s = new Set(read(KEY(kind)));
  const old = read(OLD[kind]);
  if (old.length) { for (const n of old) s.add(n); savePinnedLibs(kind, s); try { localStorage.removeItem(OLD[kind]); } catch { /* no storage */ } }
  return s;
}
export function savePinnedLibs(kind: PinKind, s: Set<string>): void { try { localStorage.setItem(KEY(kind), JSON.stringify([...s])); } catch { /* private window */ } }
export function setLibPinned(kind: PinKind, nick: string, on: boolean): Set<string> {
  const s = loadPinnedLibs(kind); if (on) s.add(nick); else s.delete(nick); savePinnedLibs(kind, s); return s;
}
