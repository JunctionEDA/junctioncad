// edits.ts — every edit of an assembly as item changes (shared/itemdoc): each function returns the changes and
// applies nothing.  The editor commits them through the session (ui/assembly.ts `commit`), which applies them
// here, sends them and makes them one undo step; a peer's editor applies the same changes.
//
// Items this file adds to the format (document/format.ts lists the first three):
//
//   group      a folder in the instance list   { id, type: "group", name, order, collapsed? }
//              an instance is in a group when its `group` key names one
//   connector  an explicit mate connector, owned by an instance: geometry of the part plus an offset
//              { id, type: "connector", name, order, instance, ref, flip?, offset?: [x, y, z], rotation? }
//              a mate end may name one with `connector: <id>` beside its `ref`
//   position   a named position: the placements of the instances that could move when it was saved
//              { id, type: "position", name, order, transforms: { <instance id>: [12 numbers] } }
//
// Instances keep their place in the list by `order` (shared/itemdoc orderBetween), as features do.
import { addedChange, byOrder, modifiedChange, newId, orderBetween, removedChange, stableJson, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { GeomRef } from "../../mechanical/api";
import { IDENTITY, instancesOf, isInstance, isMate, matesOf, type InstanceItem, type InstanceSource, type MateConnector, type MateItem, type Transform } from "./format";

export interface GroupItem extends Item { type: "group"; name: string; order: string; collapsed?: boolean }
export interface ConnectorItem extends Item { type: "connector"; name: string; order: string; instance: string; ref: GeomRef; flip?: boolean; offset?: number[]; rotation?: number }
export interface PositionItem extends Item { type: "position"; name: string; order: string; transforms: { [instance: string]: number[] } }

export const isGroup = (i: Item | undefined): i is GroupItem => !!i && i.type === "group";
export const isConnector = (i: Item | undefined): i is ConnectorItem => !!i && i.type === "connector" && typeof i.instance === "string" && !!i.ref;
export const isPosition = (i: Item | undefined): i is PositionItem => !!i && i.type === "position" && !!i.transforms;

function ofType<T extends Item & { order?: string }>(doc: ItemDoc, test: (i: Item | undefined) => i is T): T[] { const out: T[] = []; for (const i of doc.items.values()) if (test(i)) out.push(i); return byOrder(out as (T & { id: string })[]); }
export const groupsOf = (doc: ItemDoc): GroupItem[] => ofType(doc, isGroup);
export const connectorsOf = (doc: ItemDoc): ConnectorItem[] => ofType(doc, isConnector);
export const positionsOf = (doc: ItemDoc): PositionItem[] => ofType(doc, isPosition);

const lastOrder = (items: { order?: string }[]): string | null => (items.length ? items[items.length - 1].order || null : null);

/** "Lid 2": the first free name with that stem among `taken`.  A stem that is free is used as it is. */
export function freeName(taken: Iterable<string>, stem: string): string {
  const set = new Set(taken);
  if (!set.has(stem)) return stem;
  for (let n = 2; ; n++) if (!set.has(`${stem} ${n}`)) return `${stem} ${n}`;
}
/** "Revolute 3": numbered from 1, as features are. */
export function numberedName(taken: Iterable<string>, stem: string): string {
  const set = new Set(taken);
  for (let n = 1; ; n++) if (!set.has(`${stem} ${n}`)) return `${stem} ${n}`;
}

function modify<T extends Item>(doc: ItemDoc, id: string, patch: (item: T) => T): ItemChange[] {
  const before = doc.items.get(id) as T | undefined;
  if (!before) return [];
  const c = modifiedChange(before, patch({ ...before }));
  return c ? [c] : [];
}

// ---------------------------------------------------------------- instances
export interface NewInstance { source: InstanceSource; name: string; transform?: Transform; fixed?: boolean; group?: string }

/** Insert instances at the end of the list.  Returns the changes and the new items (for selecting them). */
export function insertInstances(doc: ItemDoc, list: NewInstance[]): { changes: ItemChange[]; items: InstanceItem[] } {
  const existing = instancesOf(doc);
  const names = existing.map((i) => i.name);
  let order = lastOrder(existing);
  const items: InstanceItem[] = [];
  for (const n of list) {
    order = orderBetween(order, null);
    const name = freeName(names, n.name); names.push(name);
    const item: InstanceItem = { id: newId(), type: "instance", name, order, source: { ...n.source } as InstanceItem["source"], transform: (n.transform || IDENTITY).slice() };
    if (n.fixed) item.fixed = true;
    if (n.group) item.group = n.group;
    items.push(item);
  }
  return { changes: items.map(addedChange), items };
}

export const renameItem = (doc: ItemDoc, id: string, name: string): ItemChange[] => modify(doc, id, (i) => ({ ...i, name: name.trim() || (i.name as string) }));

function flag(doc: ItemDoc, ids: readonly string[], key: "fixed" | "hidden" | "suppressed", on: boolean): ItemChange[] {
  return ids.flatMap((id) => modify(doc, id, (i) => { const o = { ...i } as JsonObject; if (on) o[key] = true; else delete o[key]; return o as Item; }));
}
export const setFixed = (doc: ItemDoc, ids: readonly string[], on: boolean): ItemChange[] => flag(doc, ids, "fixed", on);
export const setHidden = (doc: ItemDoc, ids: readonly string[], on: boolean): ItemChange[] => flag(doc, ids, "hidden", on);
export const setSuppressed = (doc: ItemDoc, ids: readonly string[], on: boolean): ItemChange[] => flag(doc, ids, "suppressed", on);

/** New placements, as the solver or a drag left them.  Only instances whose numbers changed are written. */
export function setTransforms(doc: ItemDoc, transforms: ReadonlyMap<string, readonly number[]>, eps = 1e-9): ItemChange[] {
  const out: ItemChange[] = [];
  for (const [id, t] of transforms) {
    const item = doc.items.get(id);
    if (!isInstance(item)) continue;
    const old = item.transform;
    if (Array.isArray(old) && old.length === 12 && old.every((v, i) => Math.abs((v as number) - t[i]) <= eps)) continue;
    out.push({ id, kind: "MODIFIED", typeName: "instance", props: [{ path: ["transform"], value: t.map(clean) }] });
  }
  return out;
}
/**
 * The values each mate has now (document/format.ts MateItem.values), to be committed with the placements.
 * Only mates whose values changed are written; a mate that is not in the document yet (it is added by an
 * earlier change of the same commit) is written too.
 */
export function setMateValues(doc: ItemDoc, values: ReadonlyMap<string, { [key: string]: number }>): ItemChange[] {
  const out: ItemChange[] = [];
  for (const [id, v] of values) {
    const rounded: { [key: string]: number } = {};
    for (const k of Object.keys(v)) { const r = Math.round(v[k] * 1e6) / 1e6; rounded[k] = Object.is(r, -0) ? 0 : r; }
    const item = doc.items.get(id);
    if (item && !isMate(item)) continue;
    if (item && stableJson(item.values) === stableJson(rounded)) continue;
    if (item && item.values === undefined && !Object.keys(rounded).length) continue;
    out.push({ id, kind: "MODIFIED", typeName: "mate", props: [{ path: ["values"], value: rounded }] });
  }
  return out;
}

/** Numbers as they are stored: rounded to a nanometre (and a billionth of a turn), so equal placements are equal text. */
const clean = (v: number): number => { const r = Math.round(v * 1e9) / 1e9; return Object.is(r, -0) ? 0 : r; };

/** Point an instance at other geometry (Replace).  Its mates keep their names: one whose geometry is gone says so. */
export const replaceSource = (doc: ItemDoc, id: string, source: InstanceSource): ItemChange[] => modify<InstanceItem>(doc, id, (i) => ({ ...i, source: { ...source } as InstanceItem["source"] }));

/** Delete instances, and with them the mates, connectors and saved placements that need them. */
export function deleteInstances(doc: ItemDoc, ids: readonly string[]): ItemChange[] {
  const gone = new Set(ids);
  const out: ItemChange[] = [];
  for (const m of matesOf(doc)) if (gone.has(m.a.instance) || gone.has(m.b.instance)) out.push(removedChange(m));
  for (const c of connectorsOf(doc)) if (gone.has(c.instance)) out.push(removedChange(c));
  for (const p of positionsOf(doc)) {
    const props = Object.keys(p.transforms).filter((k) => gone.has(k)).map((k) => ({ path: ["transforms", k], del: true }));
    if (props.length) out.push({ id: p.id, kind: "MODIFIED", typeName: "position", props });
  }
  for (const id of ids) { const i = doc.items.get(id); if (isInstance(i)) out.push(removedChange(i)); }
  return out;
}

/** Copies of instances, each moved by `step` × (1 … count): a linear pattern, written as plain instances. */
export function copyInstances(doc: ItemDoc, ids: readonly string[], count: number, step: readonly [number, number, number]): { changes: ItemChange[]; items: InstanceItem[] } {
  const list: NewInstance[] = [];
  const names = new Set(instancesOf(doc).map((i) => i.name));
  for (let n = 1; n <= count; n++) for (const id of ids) {
    const i = doc.items.get(id);
    if (!isInstance(i)) continue;
    const t = (Array.isArray(i.transform) && i.transform.length === 12 ? i.transform.slice() : IDENTITY.slice()) as Transform;
    t[3] += step[0] * n; t[7] += step[1] * n; t[11] += step[2] * n;
    // a copy of "Lid 2" (itself a copy of "Lid") is "Lid 3"; a copy of "Part 1" (its own name) is "Part 1 2"
    const stem = i.name.replace(/ \d+$/, "");
    list.push({ source: i.source, name: stem !== i.name && names.has(stem) ? stem : i.name, transform: t, group: typeof i.group === "string" ? i.group : undefined });
  }
  return insertInstances(doc, list);
}

// ---------------------------------------------------------------- groups
/** Put instances in a new group (a folder in the list). */
export function groupInstances(doc: ItemDoc, ids: readonly string[], name?: string): { changes: ItemChange[]; group: GroupItem } {
  const groups = groupsOf(doc);
  const first = ids.map((id) => doc.items.get(id)).find(isInstance);
  const group: GroupItem = { id: newId(), type: "group", name: name || numberedName(groups.map((g) => g.name), "Group"), order: first ? first.order : orderBetween(lastOrder(groups), null) };
  const changes: ItemChange[] = [addedChange(group)];
  for (const id of ids) changes.push(...modify(doc, id, (i) => ({ ...i, group: group.id })));
  return { changes, group };
}
/** Dissolve a group: its instances stay, at the top level. */
export function ungroup(doc: ItemDoc, groupId: string): ItemChange[] {
  const g = doc.items.get(groupId);
  if (!isGroup(g)) return [];
  const out: ItemChange[] = [];
  for (const i of instancesOf(doc)) if (i.group === groupId) out.push(...modify(doc, i.id, (x) => { const o = { ...x } as JsonObject; delete o.group; return o as Item; }));
  out.push(removedChange(g));
  return out;
}
export const setCollapsed = (doc: ItemDoc, groupId: string, on: boolean): ItemChange[] => modify(doc, groupId, (g) => { const o = { ...g } as JsonObject; if (on) o.collapsed = true; else delete o.collapsed; return o as Item; });

// ---------------------------------------------------------------- mates
export interface NewMate { mateType: string; name: string; a: MateConnector; b: MateConnector; params: JsonObject }
export function addMate(doc: ItemDoc, m: NewMate, id: string = newId()): { changes: ItemChange[]; item: MateItem } {
  const item: MateItem = { id, type: "mate", mateType: m.mateType, name: m.name, order: orderBetween(lastOrder(matesOf(doc)), null), a: m.a, b: m.b, params: m.params };
  return { changes: [addedChange(item)], item };
}
export function updateMate(doc: ItemDoc, id: string, patch: Partial<Pick<MateItem, "name" | "a" | "b" | "params" | "mateType">>): ItemChange[] {
  return modify<MateItem>(doc, id, (m) => ({ ...m, ...patch }));
}
export function deleteItems(doc: ItemDoc, ids: readonly string[]): ItemChange[] {
  const instances = ids.filter((id) => isInstance(doc.items.get(id)));
  const out = deleteInstances(doc, instances);
  const done = new Set(out.map((c) => c.id));
  for (const id of ids) {
    const i = doc.items.get(id);
    if (!i || done.has(id)) continue;
    if (isGroup(i)) out.push(...ungroup(doc, id));
    else if (isConnector(i)) { for (const m of matesOf(doc)) if ((m.a.connector === id || m.b.connector === id) && !done.has(m.id)) { out.push(removedChange(m)); done.add(m.id); } out.push(removedChange(i)); }
    else if (isMate(i) || isPosition(i)) out.push(removedChange(i));
  }
  return out;
}

// ---------------------------------------------------------------- explicit connectors and named positions
export function addConnector(doc: ItemDoc, c: { instance: string; ref: GeomRef; name?: string; flip?: boolean; offset?: number[]; rotation?: number }): { changes: ItemChange[]; item: ConnectorItem } {
  const all = connectorsOf(doc);
  const item: ConnectorItem = { id: newId(), type: "connector", name: c.name || numberedName(all.map((x) => x.name), "Mate connector"), order: orderBetween(lastOrder(all), null), instance: c.instance, ref: c.ref };
  if (c.flip) item.flip = true;
  if (c.offset && c.offset.some((v) => v)) item.offset = c.offset.slice(0, 3);
  if (c.rotation) item.rotation = c.rotation;
  return { changes: [addedChange(item)], item };
}

/** Move, turn or flip an explicit connector on its geometry. */
export function updateConnector(doc: ItemDoc, id: string, patch: { offset?: number[]; rotation?: number; flip?: boolean }): ItemChange[] {
  return modify<ConnectorItem>(doc, id, (c) => {
    const o = { ...c } as ConnectorItem;
    if (patch.offset) { if (patch.offset.some((v) => v)) o.offset = patch.offset.slice(0, 3); else delete o.offset; }
    if (patch.rotation !== undefined) { if (patch.rotation) o.rotation = patch.rotation; else delete o.rotation; }
    if (patch.flip !== undefined) { if (patch.flip) o.flip = true; else delete o.flip; }
    return o;
  });
}

export function savePosition(doc: ItemDoc, transforms: ReadonlyMap<string, readonly number[]>, name?: string): { changes: ItemChange[]; item: PositionItem } {
  const all = positionsOf(doc);
  const map: { [id: string]: number[] } = {};
  for (const [id, t] of transforms) map[id] = t.map(clean);
  const item: PositionItem = { id: newId(), type: "position", name: name || numberedName(all.map((x) => x.name), "Position"), order: orderBetween(lastOrder(all), null), transforms: map };
  return { changes: [addedChange(item)], item };
}
