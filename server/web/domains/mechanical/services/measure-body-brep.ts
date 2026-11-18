// measure-body-brep.ts — the "body-brep" service: bodies of the model on screen as BRep text with their exact
// boxes, so another worker can check them against each other (the assembly's interference check sends them to
// the "interference" and "clearance" services; see assembly/services/interference.ts).
//
//   await kernel.call("body-brep", { bodies: ["<body id>"] | null })
//   → { bodies: [{ id, name, rev, brep, bbox }] }
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { boxOf, brepOf } from "./_measure-kernel";

export default defineService({
  name: "body-brep",
  run(ctx, args) {
    const wanted = (args as { bodies?: string[] | null } | null)?.bodies;
    const bodies = wanted && wanted.length ? ctx.state.bodies.filter((b) => wanted.includes(b.id)) : ctx.state.bodies;
    return { bodies: bodies.map((b) => ({ id: b.id, name: b.name, rev: b.rev, brep: brepOf(ctx.k, b.shape), bbox: boxOf(ctx.k, b.shape) })) } as unknown as Json;
  },
});
