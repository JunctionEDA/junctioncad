// boardlink-solve.ts — the board link's worker service: each link's drives as board geometry, from the model on
// screen.  `await kernel.call("boardlink-solve", { links })` → `{ <link id>: Solved }` (boardlink/format.ts).
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { solveLinks } from "../boardlink/solve";

export default defineService({
  name: "boardlink-solve",
  run(ctx, args) { return solveLinks(ctx, args) as unknown as Json; },
});
