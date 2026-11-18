// itemdoc.ts — JSON item documents: the file format and change model of every document that is not KiCad's
// (a part studio `.jpart`, an assembly `.jasm`, and whatever later domains add).
//
// A document is `{ "junction": <kind>, "version": 1, "items": [ ... ] }`.  Every item is a plain object with a
// stable string `id` and a `type`; the rest is the owning domain's.  Edits are item changes, the same shape KiCad
// documents use on the wire (server/protocol: `id`, `kind`), so they ride the existing collaboration path
// unchanged: sequenced and stored by the server, broadcast to peers, replayed on join.
//
//   ADDED     { id, kind, typeName, item }      the whole item; an id that exists is replaced
//   MODIFIED  { id, kind, typeName, props }     props: [{ path: ["params","depth"], value }, { path, del: true }]
//   REMOVED   { id, kind, typeName }
//
// Changes apply in the server's sequence order and the last writer of a path wins.  A change to an id that is
// not there does nothing (a delete beats a concurrent modify).  The server applies the same rules to the stored
// file in server/src/itemdoc.rs: keep the two in step.
//
// Pure: no DOM, no network.  The session that carries the changes is sync.ts.

/** JSON, with absent object keys allowed to be written as `undefined` (they are dropped when the document is sent or stored). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export type JsonObject = { [key: string]: Json | undefined };

/** One item of a document.  `id` is stable for the item's life and unique in the document. */
export interface Item extends JsonObject { id: string; type: string }

export interface PropChange { path: string[]; value?: Json; del?: boolean }
export interface AddedChange { id: string; kind: "ADDED"; typeName: string; item: Item }
export interface ModifiedChange { id: string; kind: "MODIFIED"; typeName?: string; props: PropChange[] }
export interface RemovedChange { id: string; kind: "REMOVED"; typeName?: string }
export type ItemChange = AddedChange | ModifiedChange | RemovedChange;

/** A document in memory: the head keys of the file and its items by id. */
export interface ItemDoc {
  /** the file's `junction` key: which kind of document this is ("part-studio", "assembly") */
  kind: string;
  version: number;
  /** any other top-level key of the file, kept as it was read */
  head: JsonObject;
  items: Map<string, Item>;
}

export const ITEMDOC_VERSION = 1;

export function newItemDoc(kind: string, items: Item[] = []): ItemDoc {
  return { kind, version: ITEMDOC_VERSION, head: {}, items: new Map(items.map((i) => [i.id, i])) };
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read a document file.  Throws with a message a person can act on when the text is not one. */
export function parseItemDoc(text: string, expectKind?: string): ItemDoc {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error("This file is not a Junction document (it is not JSON)."); }
  if (!isObject(raw) || typeof raw.junction !== "string") throw new Error("This file is not a Junction document.");
  if (expectKind && raw.junction !== expectKind) throw new Error(`This file is a ${raw.junction}, not a ${expectKind}.`);
  const version = typeof raw.version === "number" ? raw.version : 1;
  if (version > ITEMDOC_VERSION) throw new Error("This document was written by a newer Junction. Reload the page to update.");
  const doc: ItemDoc = { kind: raw.junction, version, head: {}, items: new Map() };
  for (const [k, v] of Object.entries(raw)) if (k !== "junction" && k !== "version" && k !== "items") doc.head[k] = v;
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (isObject(item) && typeof item.id === "string" && item.id) doc.items.set(item.id, { ...item, type: typeof item.type === "string" ? item.type : "" } as Item);
  }
  return doc;
}

/** JSON with object keys in order, so the same value is always the same text. */
export function stableJson(v: Json | undefined): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (isObject(v)) return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}

/** Write a document file: one item per line in id order, as the server's fold writes it (itemdoc.rs). */
export function serializeItemDoc(doc: ItemDoc): string {
  const head: JsonObject = { ...doc.head, junction: doc.kind, version: doc.version };
  let out = "{" + Object.keys(head).sort().map((k) => JSON.stringify(k) + ":" + stableJson(head[k])).join(",") + ",\"items\":[";
  const ids = Array.from(doc.items.keys()).sort();
  ids.forEach((id, i) => { out += (i ? ",\n" : "\n") + stableJson(doc.items.get(id)!); });
  return out + "\n]}\n";
}

export function clone<T extends Json>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

/** The value at a path of object keys, or undefined. */
export function getPath(root: Json | undefined, path: readonly string[]): Json | undefined {
  let at: Json | undefined = root;
  for (const key of path) { if (!isObject(at)) return undefined; at = at[key]; }
  return at;
}

function setPath(root: JsonObject, path: readonly string[], value: Json | undefined): void {
  let at: JsonObject = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = at[path[i]];
    if (isObject(next)) at = next;
    else { if (value === undefined) return; const made: JsonObject = {}; at[path[i]] = made; at = made; }
  }
  const last = path[path.length - 1];
  if (value === undefined) delete at[last]; else at[last] = value;
}

/**
 * Apply one change.  Returns false when it changed nothing (an unknown id, an empty change).
 * Items are replaced, never mutated in place: a reference to an item taken before the change still shows the
 * item as it was, which is what lets a view compare old and new by identity.
 */
export function applyChange(doc: ItemDoc, change: ItemChange): boolean {
  if (!change || typeof change.id !== "string") return false;
  if (change.kind === "ADDED") {
    if (!isObject(change.item)) return false;
    doc.items.set(change.id, { ...clone(change.item), id: change.id } as Item);
    return true;
  }
  if (change.kind === "REMOVED") return doc.items.delete(change.id);
  if (change.kind === "MODIFIED") {
    const before = doc.items.get(change.id);
    if (!before) return false;
    const item = clone(before);
    let any = false;
    for (const p of change.props || []) {
      if (!p || !Array.isArray(p.path) || !p.path.length || (p.path.length === 1 && p.path[0] === "id")) continue;   // the id is the item's identity
      setPath(item, p.path, p.del ? undefined : clone(p.value === undefined ? null : p.value));
      any = true;
    }
    if (any) doc.items.set(change.id, item);
    return any;
  }
  return false;
}

/** Apply changes in order; returns the ids that changed. */
export function applyChanges(doc: ItemDoc, changes: readonly ItemChange[] | null | undefined): Set<string> {
  const touched = new Set<string>();
  for (const c of changes || []) if (applyChange(doc, c)) touched.add(c.id);
  return touched;
}

/**
 * The change that undoes `change` on `doc` as it is now (call it before applying), or null when the change
 * would do nothing.  An undo is an ordinary change: it is sent like any other, so peers see it too.
 */
export function invertChange(doc: ItemDoc, change: ItemChange): ItemChange | null {
  const before = doc.items.get(change.id);
  if (change.kind === "ADDED") return before ? { id: change.id, kind: "ADDED", typeName: before.type, item: clone(before) } : { id: change.id, kind: "REMOVED", typeName: change.typeName };
  if (!before) return null;
  if (change.kind === "REMOVED") return { id: change.id, kind: "ADDED", typeName: before.type, item: clone(before) };
  const props: PropChange[] = [];
  for (const p of change.props || []) {
    const was = getPath(before, p.path);
    props.push(was === undefined ? { path: p.path.slice(), del: true } : { path: p.path.slice(), value: clone(was) });
  }
  return { id: change.id, kind: "MODIFIED", typeName: before.type, props: props.reverse() };
}

/**
 * The smallest set of path changes that turns `before` into `after`: it descends into plain objects and treats
 * everything else (numbers, strings, arrays) as one value.  This is what makes two people editing different
 * parameters of one feature, or different entities of one sketch, both keep their edit.
 */
export function diffProps(before: Json | undefined, after: Json | undefined, base: string[] = []): PropChange[] {
  if (isObject(before) && isObject(after)) {
    const out: PropChange[] = [];
    for (const k of Object.keys(before)) if (!(k in after) || after[k] === undefined) out.push({ path: [...base, k], del: true });
    for (const k of Object.keys(after)) { if (after[k] === undefined) continue; out.push(...diffProps(before[k], after[k], [...base, k])); }
    return out;
  }
  if (after === undefined) return base.length ? [{ path: base, del: true }] : [];
  if (before !== undefined && stableJson(before) === stableJson(after)) return [];
  return base.length ? [{ path: base, value: clone(after) }] : [];
}

/** A MODIFIED change from two versions of an item, or null when they are the same. */
export function modifiedChange(before: Item, after: Item): ModifiedChange | null {
  const props = diffProps(before, after).filter((p) => !(p.path.length === 1 && p.path[0] === "id"));
  return props.length ? { id: before.id, kind: "MODIFIED", typeName: before.type, props } : null;
}

export function addedChange(item: Item): AddedChange { return { id: item.id, kind: "ADDED", typeName: item.type, item: clone(item) }; }
export function removedChange(item: { id: string; type?: string }): RemovedChange { return { id: item.id, kind: "REMOVED", typeName: item.type }; }

/** A new item id: a UUID, as KiCad items have. */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && c.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => { const r = Math.random() * 16 | 0; return (ch === "x" ? r : (r & 3) | 8).toString(16); });
}

// ---------------------------------------------------------------- order keys
// An ordered list whose members are separate items (the features of a part studio) keeps each member's place in
// a string `order` key.  Moving a member changes that one key, so a move and an edit elsewhere never collide,
// and two inserts at the same place both survive (ties sort by id).  Keys compare as plain strings.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A key that sorts after `a` and before `b`; either may be absent (the start or the end of the list). */
export function orderBetween(a?: string | null, b?: string | null): string {
  const lo = a || "", hi = b || "";
  if (hi && lo >= hi) return orderBetween(lo, null);   // callers pass neighbours in order; a tie still yields a key after `a`
  // The keys are digits after a point, base 62.  Walk both until there is room for a digit between them.
  let out = "", bounded = !!hi;
  for (let i = 0; ; i++) {
    const x = i < lo.length ? Math.max(0, DIGITS.indexOf(lo[i])) : 0;
    const y = bounded && i < hi.length ? Math.max(0, DIGITS.indexOf(hi[i])) : DIGITS.length;
    if (y - x > 1) return out + DIGITS[(x + y) >> 1];   // never "0": a key does not end in the lowest digit
    out += DIGITS[x];
    if (y - x === 1) bounded = false;                   // below `hi` from here on: anything above the rest of `lo` will do
  }
}

/** Items in list order: by `order`, ties by id. */
export function byOrder<T extends { id: string; order?: Json }>(items: Iterable<T>): T[] {
  return Array.from(items).sort((p, q) => {
    const a = typeof p.order === "string" ? p.order : "", b = typeof q.order === "string" ? q.order : "";
    return a < b ? -1 : a > b ? 1 : p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
  });
}
