// boards.ts — board instances as they look: for every instance of a board the mechanical domain's BoardDisplay
// (the laminate, the face images, a mesh per part) is drawn at the instance's placement, and follows the board
// while it is edited, a moved footprint at a time.  The instance's solids (sources/board.ts) are ghosts under
// it: they are what the pointer, the mates and the interference check use.
import { BoardDisplay, type BoardDelta, type Frame } from "../../mechanical/api";
import type { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import type { SourceManager } from "../sources/manager";

interface Shown { display: BoardDisplay; docId: string; drawn: boolean; stop: () => void }

const frameOf = (t: readonly number[]): Frame => ({ origin: [t[3], t[7], t[11]], x: [t[0], t[4], t[8]], y: [t[1], t[5], t[9]], normal: [t[2], t[6], t[10]] });

export class BoardPictures {
  private readonly shown = new Map<string, Shown>();
  constructor(private readonly viewport: Viewport3D, private readonly sources: SourceManager) {}

  /** How many board pictures are on screen, and how many of them have been drawn (tests). */
  get stats(): { boards: number; drawn: number } { let drawn = 0; for (const s of this.shown.values()) if (s.drawn && s.display.group.visible) drawn++; return { boards: this.shown.size, drawn }; }

  private redraw(s: Shown, delta: BoardDelta | null): void {
    const reader = this.sources.handle("board", s.docId)?.board?.()?.reader();
    if (!reader) return;
    s.display.update(reader, [0, 0], s.drawn ? delta : null);
    s.drawn = true;
  }

  /** Make the pictures match these board instances, each where `transformOf` says it stands. */
  sync(instances: readonly { id: string; docId: string; hidden: boolean }[], transformOf: (id: string) => readonly number[] | null): void {
    const seen = new Set<string>();
    for (const i of instances) {
      seen.add(i.id);
      let s = this.shown.get(i.id);
      if (s && s.docId !== i.docId) { s.stop(); s.display.dispose(); this.shown.delete(i.id); s = undefined; }
      if (!s) {
        const board = this.sources.handle("board", i.docId)?.board?.();
        if (!board) continue;
        const display = new BoardDisplay(this.viewport);
        const made: Shown = { display, docId: i.docId, drawn: false, stop: () => {} };
        made.stop = board.subscribe((delta) => this.redraw(made, delta));
        // the parts' 3D models arrive one by one; their measured sizes refine the envelopes of the solids
        display.onMeasured = () => board.measured();
        display.setVisible(false);
        this.shown.set(i.id, made);
        s = made;
      }
      if (!s.drawn) this.redraw(s, null);
      const t = transformOf(i.id);
      if (t && s.drawn) s.display.setFrame(frameOf(t));
      s.display.setVisible(!!t && s.drawn && !i.hidden);
    }
    for (const [id, s] of Array.from(this.shown)) if (!seen.has(id)) { s.stop(); s.display.dispose(); this.shown.delete(id); }
  }

  dispose(): void { for (const s of this.shown.values()) { s.stop(); s.display.dispose(); } this.shown.clear(); }
}
