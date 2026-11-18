// sweep-apply.ts — what Sweep and Loft do with the solids they make: a new body each, joined to the bodies they
// touch, or cut from them.  The same rules as Extrude (features/extrude.ts), for features that cannot share its
// code without editing it.
import type { NamedResult } from "../occ";
import type { Body, EvalContext, NamedShape, Shape } from "../types";

export type Operation = "new" | "add" | "remove";

export function applyOperation(ctx: EvalContext, tools: readonly NamedResult[], op: Operation, targets: readonly string[], suffixes: readonly (string | undefined)[] = []): void {
  const k = ctx.k, id = ctx.feature.id;
  if (op === "new") { tools.forEach((t, i) => ctx.addBody(t.shape, t.names, { suffix: suffixes[i] })); return; }
  const scope = (b: Body) => !targets || !targets.length || targets.includes(b.id);
  const faces = (t: NamedResult): NamedShape[] => k.namedFaces(t.shape, t.names, id);
  if (op === "remove") {
    const bodies = ctx.bodies().filter(scope);
    if (!bodies.length) throw ctx.fail("There is no body to remove material from.");
    let changed = false;
    for (let body of bodies) {
      for (const t of tools) {
        const r = k.boolean("cut", { shape: body.shape, faces: body.topo.faces }, { shape: t.shape, faces: faces(t) }, id, ctx.own);
        const was = k.volume(body.shape), now = k.volume(r.shape);
        if (Math.abs(was - now) <= 1e-9 * Math.max(1, was)) continue;
        changed = true;
        const solids = k.solids(r.shape);
        if (!solids.length) { ctx.removeBody(body); break; }
        const whole = body;
        body = ctx.replaceBody(body, solids[0], r.names);
        solids.slice(1).forEach((s: Shape, n: number) => ctx.addBody(s, r.names, { suffix: `${whole.id}.piece${n + 2}`, name: `${whole.name} (${n + 2})` }));
      }
    }
    if (!changed) ctx.warn("Nothing was removed: the shape does not reach into a body.");
    return;
  }
  tools.forEach((t, i) => {
    let host: Body | null = null;
    for (const body of ctx.bodies().filter(scope)) {
      const r: NamedResult = host
        ? k.boolean("fuse", { shape: host.shape, faces: host.topo.faces }, { shape: body.shape, faces: body.topo.faces }, id, ctx.own)
        : k.boolean("fuse", { shape: body.shape, faces: body.topo.faces }, { shape: t.shape, faces: faces(t) }, id, ctx.own);
      const solids = k.solids(r.shape);
      if (solids.length !== 1) continue;
      if (host) { ctx.removeBody(body); host = ctx.replaceBody(host, solids[0], r.names); }
      else host = ctx.replaceBody(body, solids[0], r.names);
    }
    if (!host) ctx.addBody(t.shape, t.names, { suffix: suffixes[i] });
  });
}

/** The common Result and Bodies fields of Sweep and Loft. */
export const operationFields = [
  { key: "operation", label: "Result", kind: "enum" as const, options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }, { value: "remove", label: "Remove" }] },
  { key: "targets", label: "Bodies to change", kind: "bodies" as const, hint: "Leave empty for every body.", visible: (p: { [k: string]: unknown }) => p.operation !== "new" },
];
