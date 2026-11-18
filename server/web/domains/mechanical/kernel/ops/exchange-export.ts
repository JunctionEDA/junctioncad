// exchange-export.ts — what the export services share: which bodies to export, under which names, and how a
// binary result travels back to the page.
//
// A service returns JSON; a file is returned as a Uint8Array inside that JSON.  The worker hands every
// ArrayBuffer it finds in a service's result to postMessage's transfer list (kernel/worker.ts), so a 20 MB file
// crosses to the page without being copied or base64-encoded.
import type { ServiceContext } from "../service";
import type { Body } from "../types";
import type { ExportPart } from "./exchange-step";

export interface ExportSelection {
  /** the body ids to export; null or empty: every body */
  bodies?: string[] | null;
  /** names to write instead of the bodies' own (the dialog lets a person edit them) */
  names?: { [bodyId: string]: string } | null;
  /** sRGB colours, 0..1, by body id */
  colors?: { [bodyId: string]: [number, number, number] } | null;
}

export function selectedBodies(ctx: ServiceContext, sel: ExportSelection): Body[] {
  const all = ctx.state.bodies;
  if (!all.length) throw ctx.fail("There is nothing to export: the part studio has no parts.");
  if (!sel.bodies || !sel.bodies.length) return all.slice();
  const picked = all.filter((b) => sel.bodies!.includes(b.id));
  if (!picked.length) throw ctx.fail("The parts chosen for export no longer exist.");
  return picked;
}

export function exportParts(ctx: ServiceContext, sel: ExportSelection): ExportPart[] {
  return selectedBodies(ctx, sel).map((b) => ({
    id: b.id, shape: b.shape,
    name: (sel.names && sel.names[b.id]) || b.name,
    color: (sel.colors && sel.colors[b.id]) || null,
  }));
}

/** Every ArrayBuffer in a value (typed arrays included), for postMessage's transfer list. */
export function transferables(value: unknown, out: ArrayBuffer[] = [], depth = 0): ArrayBuffer[] {
  if (!value || typeof value !== "object" || depth > 4) return out;
  if (ArrayBuffer.isView(value)) { const b = value.buffer; if (b instanceof ArrayBuffer && !out.includes(b)) out.push(b); return out; }
  if (value instanceof ArrayBuffer) { if (!out.includes(value)) out.push(value); return out; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) transferables(v, out, depth + 1);
  return out;
}
