// board-placement.ts — where the Board features of the model put their boards: `await kernel.call(
// "board-placement", {})` returns `{ [featureId]: { frame, thickness } }` for the boards that are built.
// The page draws each board's display model in that frame (board/link.ts); for a board on a face of the model
// only the worker knows it.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { builtFrames } from "../board/placement";
import { defineService } from "../kernel/service";

export default defineService({
  name: "board-placement",
  run(ctx) {
    const out: { [id: string]: Json } = {};
    for (const b of ctx.state.bodies) {
      const f = builtFrames.get(b.createdBy);
      if (f && !out[b.createdBy]) out[b.createdBy] = { frame: f.frame as unknown as Json, thickness: f.thickness };
    }
    return out;
  },
});
