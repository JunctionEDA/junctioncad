// board-reference.ts — the Board feature: a board of the project, in the part studio, as reference geometry.
//
// The feature's parameters say which board and where it sits.  The board itself is not in the part studio's
// document: the page reads the board document live (board/source.ts) and hands the worker the board as it is
// now in the transient parameter `$board` (board/link.ts adds it to the worker's input; it is never stored).
// When somebody edits the board, `$board` changes and this feature, and whatever was built on it, is rebuilt.
//
// It makes two reference bodies (kernel/types.ts Body.reference: features that act on "every body" leave them
// alone): `<feature id>:board`, the laminate with its cut-outs and holes, and `<feature id>:parts`, an envelope
// for each part tall enough to matter.  board/README.md lists the face names.
import { defineFeature } from "../core/feature";
import type { PlaneRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { buildBoard } from "../board/brep";
import { boardFrame, builtFrames } from "../board/placement";
import type { BoardSnapshotJson } from "../board/snapshot";

export interface BoardReferenceParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  /** the board's document id */
  board: string | null;
  /** the plane the board lies on, and its place on it */
  plane: PlaneRef;
  x: number; y: number; z: number; angle: number; flip: boolean;
  /**
   * The point of the board document (mm, as the board editor shows them) that is the board's origin here.  Set
   * once, to the middle of the outline, when the board is first read, and then kept: the board does not shift
   * in the part studio when its outline grows on one side.
   */
  origin: [number, number] | null;
  /** drills narrower than this are left out of the solid */
  minHole: number;
  /** parts lower than this get no envelope */
  minHeight: number;
  /** the board as it is now (added by the page for the worker; never stored) */
  $board?: BoardSnapshotJson;
}

export const BOARD_FEATURE = "board-reference";

export default defineFeature<BoardReferenceParams>({
  type: BOARD_FEATURE,
  title: "Board",
  icon: '<rect x="4" y="6" width="16" height="12" rx="1.5"/><rect x="7" y="9" width="5" height="4"/><circle cx="16.5" cy="9.5" r="1"/><circle cx="16.5" cy="14.5" r="1"/><path d="M9 13v2.5h4"/>',
  toolbarOrder: 15,
  toolbarSection: "board", toolbarMenu: "Board",
  defaults: () => ({ board: null, plane: { kind: "plane", plane: "top" }, x: 0, y: 0, z: 0, angle: 0, flip: false, origin: null, minHole: 1.5, minHeight: 1.5 }),
  schema: [
    { key: "board", label: "Board", kind: "document", docTypes: ["kicad_pcb"], hint: "A board of this project. The part studio follows it as it is edited." },
    { key: "plane", label: "Lies on", kind: "plane", hint: "The plane or flat face the board's back rests on." },
    { key: "x", label: "Offset X", kind: "number", unit: "mm", step: 1 },
    { key: "y", label: "Offset Y", kind: "number", unit: "mm", step: 1 },
    { key: "z", label: "Height", kind: "number", unit: "mm", step: 1, hint: "How far the board is lifted off the plane." },
    { key: "angle", label: "Turn", kind: "number", unit: "deg", step: 15 },
    { key: "flip", label: "Parts side down", kind: "boolean" },
    { key: "minHole", label: "Holes from", kind: "number", unit: "mm", min: 0, hint: "Drills narrower than this are left out of the solid." },
    { key: "minHeight", label: "Parts from", kind: "number", unit: "mm", min: 0, hint: "Parts lower than this get no envelope." },
  ],

  evaluate(ctx: EvalContext, p: BoardReferenceParams) {
    if (!p.board) throw ctx.fail("Choose a board.");
    const snap = p.$board;
    if (!snap || snap.v !== 1) throw ctx.fail("The board has not been read yet. It appears as soon as it has loaded.");
    const frame = boardFrame(ctx.frameOf(p.plane), p, snap.thickness);
    const built = buildBoard(ctx, snap, frame, ctx.feature.id);
    if (!built.board) throw ctx.fail("The board has no outline to build.");
    ctx.addBody(built.board.shape, built.board.names, { suffix: "board", name: ctx.feature.name, reference: true });
    if (built.parts) ctx.addBody(built.parts.shape, built.parts.names, { suffix: "parts", name: `${ctx.feature.name} parts`, reference: true });
    builtFrames.set(ctx.feature.id, { frame, thickness: snap.thickness });
    const notes: string[] = [];
    if (snap.fallback) notes.push("The board has no closed outline on Edge.Cuts; a box around its contents stands in.");
    else if (snap.open) notes.push(`${snap.open} Edge.Cuts ${snap.open === 1 ? "piece is" : "pieces are"} on no closed loop and ${snap.open === 1 ? "was" : "were"} left out.`);
    if (snap.skippedHoles) notes.push(`${snap.skippedHoles} ${snap.skippedHoles === 1 ? "hole breaks" : "holes break"} the edge or another hole and ${snap.skippedHoles === 1 ? "was" : "were"} left out of the solid.`);
    if (notes.length) ctx.warn(notes.join(" "));
  },
});
