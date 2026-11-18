// anchor.ts — how a comment thread is pinned to geometry, in the fields the platform's comments already have
// (server/src/http.rs: a root comment carries `x`, `y` and an optional anchor { kind, id, label, item }).  Pure.
//
// The platform's anchor kinds are "item" (an item of the document, by id) and "net".  A part studio is a
// document of items, so:
//
//   a feature          { kind: "item", id: <feature id>,              label: "Extrude 1" }
//   a face / an edge   { kind: "item", id: "face:<name>",             label: "Face of Extrude 1", item: <body id> }
//   / a vertex                         "edge:<name>", "vertex:<name>"
//
// `name` is the geometry's stable name (CONTRACT.md "Geometry names"), so the pin follows the face through
// rebuilds.  The server allows 300 characters for `id` and 100 for `item`; a name that does not fit (deeply
// derived geometry) is pinned to the feature that made the body instead, at the point that was clicked.
//
// `x` and `y` are two integers.  They carry the model-space point the thread was started at, in micrometres:
// x = X · 2^26 + (Y + 2^25), y = Z.  That is exact for ±33 m, fits a double, and (0, 0) means "no point".  The
// point is where the pin is drawn when the geometry it names no longer exists.
import type { V3 } from "./presence";

export type CommentTarget =
  | { kind: "feature"; featureId: string }
  | { kind: "face" | "edge" | "vertex"; body: string; name: string };

export interface PlatformAnchor { kind: string; id: string; label?: string | null; item?: string | null }

const HALF = 2 ** 25, SPAN = 2 ** 26;

export function packPoint3(p: V3 | null): { x: number; y: number } {
  if (!p) return { x: 0, y: 0 };
  const um = p.map((v) => Math.max(-HALF + 1, Math.min(HALF - 1, Math.round(v * 1000))));
  return { x: um[0] * SPAN + (um[1] + HALF), y: um[2] };
}

export function unpackPoint3(x: number, y: number): V3 | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
  const X = Math.floor(x / SPAN), Y = x - X * SPAN - HALF;
  if (Math.abs(X) >= HALF || Math.abs(Y) >= HALF || Math.abs(y) >= HALF) return null;
  return [X / 1000, Y / 1000, y / 1000];
}

const GEOM = ["face", "edge", "vertex"] as const;

/**
 * The platform anchor for a target.  `createdBy` is the feature that made the target's body: the fallback when
 * the geometry's name is too long to store.
 */
export function anchorFor(target: CommentTarget, label: string, createdBy?: string | null): PlatformAnchor | null {
  const text = label.trim().slice(0, 300);
  if (target.kind === "feature") return target.featureId ? { kind: "item", id: target.featureId, label: text } : null;
  const id = `${target.kind}:${target.name}`;
  if (id.length <= 300 && target.body.length <= 100) return { kind: "item", id, label: text, item: target.body };
  return createdBy ? { kind: "item", id: createdBy, label: text } : null;
}

/** What a stored anchor points at, or null for one this editor does not understand (a net, an empty id). */
export function targetOf(anchor: PlatformAnchor | null | undefined): CommentTarget | null {
  if (!anchor || anchor.kind !== "item" || !anchor.id) return null;
  for (const k of GEOM) {
    if (anchor.id.startsWith(k + ":")) return anchor.item ? { kind: k, body: anchor.item, name: anchor.id.slice(k.length + 1) } : null;
  }
  return { kind: "feature", featureId: anchor.id };
}

export const targetKey = (t: CommentTarget): string => (t.kind === "feature" ? `feature:${t.featureId}` : `${t.kind}:${t.body}:${t.name}`);
