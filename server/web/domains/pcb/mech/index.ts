// mech — the board editor's side of the board link: a part studio drives this board's outline, mounting holes
// and keep-outs, and the board is shown in its enclosure.  Part of the editor bundle (imported by
// editor/index.ts); README.md in this folder says how the pieces fit.
//
//   links.ts       the project's part studios, watched for links that name the open board
//   boarditems.ts  what a link asks for as KiCad items, and the changes that make the board hold them (pure)
//   sync.ts        the reconciler and the enclosure check, on the board's own change path
//   check.ts       components against the keep-outs' height limits (pure)
//   enclosure.ts   the linked studios' bodies in the 3D viewer, from a headless modelling worker
//   panel.ts       the "Driven by …" badge and panel over the canvas
import { enclosure } from "./enclosure";
import { installMechPanel } from "./panel";
import { mech } from "./sync";
import { mmH, mmW, mmX0, mmY0, world } from "../editor/view";

installMechPanel();

// for tests and the console
(window as unknown as { JunctionBoardMech?: unknown }).JunctionBoardMech = {
  mech, enclosure,
  /** where a board position (mm) is on screen: the inverse of the editor's worldMm */
  clientOf(x: number, y: number): { x: number; y: number } { const r = world.getBoundingClientRect(); return { x: r.left + (x - mmX0()) / mmW() * r.width, y: r.top + (y - mmY0()) / mmH() * r.height }; },
};

export { mech, enclosure };
