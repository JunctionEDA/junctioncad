// format.ts — the board link: how a part studio drives a board.  Pure (no DOM, no kernel): the part studio, its
// worker and the board editor all read the same definitions.
//
// A link is one item of the part studio document (`.jpart`), type "board-link", one per board the studio drives:
//
//   { id, type: "board-link", board: <document id of the .kicad_pcb>,
//     plane: PlaneRef, lift: mm,            where the board's back face lies: a plane or planar face, raised by `lift`
//     anchor: [x, y] mm, rotation: deg,      where that plane's origin lands on the KiCad sheet (transform.ts)
//     feature: <id of a Board feature>,      optional: the board is placed by that feature (it is shown in the model
//                                            there), and plane, lift, anchor and rotation above are not used
//     drives: { <id>: Drive },               what the studio drives on the board; a map, so two people can edit two drives
//     solved: Solved }                       the drives as board geometry, in nanometres: written by a part studio
//                                            page after every rebuild (driver.ts), read by the board editor
//
// The board editor never runs the kernel to follow a link: it reads `solved` and writes the board items it
// describes (web/domains/pcb/mech).  `solved` is the last good answer: a drive whose source is lost keeps its
// geometry and gets a line in `solved.errors`, so a broken reference in the model never deletes a board outline.
//
// Unknown keys are kept (itemdoc rules).  Lengths are millimetres here, except inside `solved`, which is in the
// board's own units (whole nanometres, Y down).
import { addedChange, byOrder, clone, modifiedChange, orderBetween, removedChange, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { GeomRef, PlaneRef } from "../core/geometry";
import type { Placement } from "./transform";

export const BOARD_LINK_TYPE = "board-link";

/** What a drive takes its geometry from: every closed region (or circle) of a sketch, or picked faces. */
export type DriveSource = { kind: "sketch"; feature: string } | { kind: "faces"; refs: GeomRef[] };

interface DriveBase extends JsonObject { name: string; order: string; source: DriveSource }
/** The board's Edge.Cuts: the outer loop of the source, moved inwards by `inset`. */
export interface OutlineDrive extends DriveBase { kind: "outline"; inset: number; /** inner loops of the source become cut-outs */ cutouts: boolean }
/** Mounting holes: one at the centre of every circle of the sketch, or of every picked face (a boss top, a bore). */
export interface HolesDrive extends DriveBase { kind: "holes"; /** drill, mm; 0 takes each circle's or bore's own diameter */ diameter: number; /** copper pad diameter, mm; 0 is an unplated hole */ pad: number }
/**
 * A rule area on the board.  `mode` says what may stand in it:
 *   "none"     no components at all
 *   "height"   components up to `maxHeight`
 *   "ceiling"  components up to the picked face, less `clearance`: the limit follows the model
 */
export interface KeepoutDrive extends DriveBase { kind: "keepout"; mode: "none" | "height" | "ceiling"; maxHeight: number; clearance: number; side: "top" | "bottom" }
export type Drive = OutlineDrive | HolesDrive | KeepoutDrive;
export type DriveKind = Drive["kind"];

/** One curve of an outline, in board nanometres: a line, an arc through three points, or a full circle. */
export type Curve = ["l", number, number, number, number] | ["a", number, number, number, number, number, number] | ["c", number, number, number];
export interface SolvedOutline extends JsonObject { kind: "outline"; curves: Curve[] }
export interface SolvedHoles extends JsonObject { kind: "holes"; /** x, y, drill in nanometres */ holes: [number, number, number][]; pad: number }
export interface SolvedKeepout extends JsonObject {
  kind: "keepout";
  /** closed polygons, x0, y0, x1, y1, … in nanometres */
  loops: number[][];
  side: "top" | "bottom";
  mode: "none" | "height" | "ceiling";
  /** "height": the tallest component allowed, mm */
  max: number;
  /** "ceiling": how far the face is from the board's back face along the board normal (negative: behind the board), mm */
  gap: number;
  clearance: number;
}
/** A Frame (core/geometry.ts) as it is stored. */
export type SolvedFrame = { origin: [number, number, number]; x: [number, number, number]; y: [number, number, number]; normal: [number, number, number] };
export type SolvedDrive = SolvedOutline | SolvedHoles | SolvedKeepout;
export interface Solved extends JsonObject {
  v: 1;
  /** the board's back face in model space, `lift` applied; null until the plane has been resolved once */
  frame: SolvedFrame | null;
  drives: { [id: string]: SolvedDrive };
  /**
   * Where the frame's origin lands on the sheet and how the board is turned, when a Board feature places the
   * board (the link's `feature`): they are that feature's, solved with the frame.  Absent otherwise.
   */
  anchor?: [number, number];
  rotation?: number;
  /** drives (or "plane") that could not be solved from the model as it is; their geometry above is the last good one */
  errors: { [id: string]: string };
}

export interface BoardLinkItem extends Item {
  type: typeof BOARD_LINK_TYPE;
  board: string;
  plane: PlaneRef;
  lift: number;
  anchor: [number, number];
  rotation: number;
  /**
   * The Board feature (features/board-reference.ts) that shows this board in the model.  When it is set the
   * board has ONE placement, that feature's: the link's own plane, lift, anchor and rotation are ignored.
   */
  feature?: string | null;
  drives: { [id: string]: Drive };
  solved: Solved;
}

const num = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);
const obj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export const emptySolved = (): Solved => ({ v: 1, frame: null, drives: {}, errors: {} });

/** The item as a link with every key present, or null when it is not one. */
export function readLink(item: Item | undefined): BoardLinkItem | null {
  if (!item || item.type !== BOARD_LINK_TYPE || typeof item.board !== "string") return null;
  const a = Array.isArray(item.anchor) ? item.anchor : [];
  const s = obj(item.solved) ? item.solved : {};
  const drives: { [id: string]: Drive } = {};
  if (obj(item.drives)) for (const [id, d] of Object.entries(item.drives)) if (obj(d) && (d.kind === "outline" || d.kind === "holes" || d.kind === "keepout") && obj(d.source)) drives[id] = d as unknown as Drive;
  return {
    ...item, type: BOARD_LINK_TYPE, board: item.board,
    plane: (obj(item.plane) ? item.plane : { kind: "plane", plane: "top" }) as PlaneRef,
    lift: num(item.lift, 0), anchor: [num(a[0], 100), num(a[1], 100)], rotation: num(item.rotation, 0), drives,
    solved: { ...s, v: 1, frame: (obj(s.frame) ? s.frame : null) as SolvedFrame | null, drives: (obj(s.drives) ? s.drives : {}) as Solved["drives"], errors: (obj(s.errors) ? s.errors : {}) as Solved["errors"] },
  } as BoardLinkItem;
}

/** The links of a part studio, optionally only those that drive one board. */
export function linksOf(doc: ItemDoc, board?: string): BoardLinkItem[] {
  const out: BoardLinkItem[] = [];
  for (const i of doc.items.values()) { const l = readLink(i); if (l && (!board || l.board === board)) out.push(l); }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The drives of a link in list order. */
export function drivesOf(link: BoardLinkItem): (Drive & { id: string })[] {
  return byOrder(Object.entries(link.drives).map(([id, d]) => ({ ...d, id })));
}

/** Where the board lies, once the plane has been resolved (transform.ts); null before. */
export function placementOf(link: BoardLinkItem): Placement | null {
  const s = link.solved;
  if (!s.frame) return null;
  const a = s.anchor;
  return { frame: s.frame, anchor: Array.isArray(a) && a.length === 2 ? [num(a[0], link.anchor[0]), num(a[1], link.anchor[1])] : link.anchor, rotation: typeof s.rotation === "number" ? s.rotation : link.rotation };
}

/** The tallest component a solved keep-out allows on a board of this thickness, mm; 0 when none may stand there. */
export function keepoutLimit(k: SolvedKeepout, thickness: number): number {
  if (k.mode === "none") return 0;
  if (k.mode === "height") return Math.max(0, k.max);
  return Math.max(0, (k.side === "top" ? k.gap - thickness : -k.gap) - k.clearance);
}

export const DRIVE_TITLES: Record<DriveKind, string> = { outline: "Board outline", holes: "Mounting holes", keepout: "Keep-out" };

export function defaultDrive(kind: DriveKind, source: DriveSource, name: string, order: string): Drive {
  if (kind === "outline") return { kind, name, order, source, inset: 0, cutouts: source.kind === "sketch" };
  if (kind === "holes") return { kind, name, order, source, diameter: source.kind === "sketch" ? 0 : 3.2, pad: 0 };
  return { kind, name, order, source, mode: source.kind === "faces" ? "ceiling" : "height", maxHeight: 5, clearance: 0.5, side: "top" };
}

// ---------------------------------------------------------------- edits (they return changes and apply nothing)

export function addLink(id: string, board: string, plane: PlaneRef, feature?: string): ItemChange[] {
  const item: BoardLinkItem = { id, type: BOARD_LINK_TYPE, board, plane, lift: 0, anchor: [100, 100], rotation: 0, ...(feature ? { feature } : {}), drives: {}, solved: emptySolved() };
  return [addedChange(item)];
}

function modify(doc: ItemDoc, linkId: string, edit: (link: JsonObject) => void): ItemChange[] {
  const before = doc.items.get(linkId);
  if (!before || before.type !== BOARD_LINK_TYPE) return [];
  const after = clone(before);
  edit(after);
  const c = modifiedChange(before, after as Item);
  return c ? [c] : [];
}

export function setLink(doc: ItemDoc, linkId: string, patch: Partial<Pick<BoardLinkItem, "plane" | "lift" | "anchor" | "rotation" | "board" | "feature">>): ItemChange[] {
  return modify(doc, linkId, (l) => { Object.assign(l, clone(patch as JsonObject)); if (l.feature === null) delete l.feature; });
}

export function removeLink(doc: ItemDoc, linkId: string): ItemChange[] {
  const it = doc.items.get(linkId);
  return it && it.type === BOARD_LINK_TYPE ? [removedChange(it)] : [];
}

export function addDrive(doc: ItemDoc, linkId: string, driveId: string, kind: DriveKind, source: DriveSource): ItemChange[] {
  const link = readLink(doc.items.get(linkId)); if (!link) return [];
  const all = drivesOf(link);
  const taken = new Set(all.map((d) => d.name));
  let name = DRIVE_TITLES[kind];
  for (let n = 2; taken.has(name); n++) name = `${DRIVE_TITLES[kind]} ${n}`;
  const drive = defaultDrive(kind, source, name, orderBetween(all.length ? all[all.length - 1].order : null, null));
  return modify(doc, linkId, (l) => { const d = obj(l.drives) ? l.drives : (l.drives = {}); (d as JsonObject)[driveId] = drive; });
}

export function setDrive(doc: ItemDoc, linkId: string, driveId: string, patch: JsonObject): ItemChange[] {
  return modify(doc, linkId, (l) => { const d = obj(l.drives) && obj(l.drives[driveId]) ? (l.drives[driveId] as JsonObject) : null; if (d) Object.assign(d, clone(patch)); });
}

/** Stop driving: the drive and what was solved for it go; the board editor then releases the items it made. */
export function removeDrive(doc: ItemDoc, linkId: string, driveId: string): ItemChange[] {
  return modify(doc, linkId, (l) => {
    if (obj(l.drives)) delete l.drives[driveId];
    if (obj(l.solved)) { if (obj(l.solved.drives)) delete l.solved.drives[driveId]; if (obj(l.solved.errors)) delete l.solved.errors[driveId]; }
  });
}

/** Store a new answer: only the drives that differ are sent. */
export function setSolved(doc: ItemDoc, linkId: string, solved: Solved): ItemChange[] {
  return modify(doc, linkId, (l) => { l.solved = clone(solved); });
}
