// boolean.ts — the Boolean feature: join bodies, subtract some bodies from others, or keep where they overlap.
// The tool bodies are used up unless "Keep tools" is on.
//
// Names: the faces of the bodies being changed keep their names, and so do the tools' faces that end up on the
// result (CONTRACT.md "Geometry names": the body being changed goes first).
import { defineFeature } from "../core/feature";
import type { Body, EvalContext } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BooleanParams { [key: string]: any; operation: "union" | "subtract" | "intersect"; targets: string[]; tools: string[]; keepTools: boolean }

export default defineFeature<BooleanParams>({
  type: "boolean",
  title: "Boolean",
  icon: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>',
  toolbarOrder: 40,
  toolbarSection: "solid", toolbarMenu: "Boolean",
  defaults: () => ({ operation: "union", targets: [], tools: [], keepTools: false }),
  schema: [
    { key: "operation", label: "Operation", kind: "enum", options: [{ value: "union", label: "Union" }, { value: "subtract", label: "Subtract" }, { value: "intersect", label: "Intersect" }] },
    { key: "targets", label: "Bodies", kind: "bodies", hint: "Union: the bodies to join (empty: every body). Subtract, intersect: the bodies to change." },
    { key: "tools", label: "Tools", kind: "bodies", hint: "The bodies to subtract or intersect with.", visible: (p) => p.operation !== "union" },
    { key: "keepTools", label: "Keep tools", kind: "boolean", visible: (p) => p.operation !== "union" },
  ],

  evaluate(ctx: EvalContext, p: BooleanParams) {
    const k = ctx.k, id = ctx.feature.id;
    const find = (ids: readonly string[], what: string): Body[] => ids.map((b) => { const body = ctx.body(b); if (!body) throw ctx.fail(`A ${what} body is gone. Edit the feature and pick it again.`); return body; });
    if (p.operation === "union") {
      const bodies = p.targets && p.targets.length ? find(p.targets, "") : ctx.bodies().slice();
      if (bodies.length < 2) throw ctx.fail("Pick at least two bodies to join.");
      let host = bodies[0];
      let joined = 0;
      // join repeatedly: a body that touches none yet may touch the growing result later
      let rest = bodies.slice(1);
      for (let pass = 0; rest.length && pass < bodies.length; pass++) {
        const left: Body[] = [];
        for (const b of rest) {
          const r = k.boolean("fuse", { shape: host.shape, faces: host.topo.faces }, { shape: b.shape, faces: b.topo.faces }, id, ctx.own);
          const solids = k.solids(r.shape);
          if (solids.length !== 1) { left.push(b); continue; }
          ctx.removeBody(b);
          host = ctx.replaceBody(host, solids[0], r.names);
          joined++;
        }
        if (left.length === rest.length) break;
        rest = left;
      }
      if (!joined) throw ctx.fail("The bodies do not touch, so they cannot be joined.");
      if (rest.length) ctx.warn(`${rest.length} ${rest.length === 1 ? "body does" : "bodies do"} not touch the others and stayed apart.`);
      return;
    }
    if (!p.targets || !p.targets.length) throw ctx.fail(p.operation === "subtract" ? "Pick the bodies to subtract from." : "Pick the bodies to intersect.");
    if (!p.tools || !p.tools.length) throw ctx.fail("Pick the tool bodies.");
    const targets = find(p.targets, "target"), tools = find(p.tools, "tool");
    if (targets.some((t) => tools.includes(t))) throw ctx.fail("A body cannot be both a target and a tool.");
    for (const start of targets) {
      let body: Body | null = start;
      for (const tool of tools) {
        if (!body) break;
        const r = k.boolean(p.operation === "subtract" ? "cut" : "common", { shape: body.shape, faces: body.topo.faces }, { shape: tool.shape, faces: tool.topo.faces }, id, ctx.own);
        const solids = k.solids(r.shape);
        if (!solids.length) { ctx.removeBody(body); body = null; ctx.warn(`${start.name} was used up.`); break; }
        const whole: Body = body;
        body = ctx.replaceBody(body, solids[0], r.names);
        solids.slice(1).forEach((s, n) => ctx.addBody(s, r.names, { suffix: `${whole.id}.piece${n + 2}`, name: `${whole.name} (${n + 2})` }));
      }
    }
    if (!p.keepTools) for (const t of tools) { const now = ctx.body(t.id); if (now) ctx.removeBody(now); }
  },
});
