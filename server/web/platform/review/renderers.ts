// review/renderers.ts — how the Compare window shows two versions of a document that is not KiCad's.
//
// The window (Compare.tsx) draws schematics and boards itself.  For any other kind of document it draws only the
// frame (which versions, the footer) and hands the two versions to a renderer the document's own domain brings:
// the domain's editor bundle (the one web/domains/registry.ts names for the kind) registers a CompareRenderer
// here as it loads, exactly as it registers its document editor (web/platform/documents/host.ts).  The renderer
// is given an empty element and the two files as text; what a difference is, and how to draw it, is its own.
import { documentKind } from "../../domains/registry";

export interface CompareSide {
  /** what the version is called in the window ("Version 3", "Current") */
  label: string;
  /** the document's file at that version */
  text: string;
}

export interface CompareContext {
  /** The element to draw in: the body of the window, empty on entry. */
  el: HTMLElement;
  /** the older and the newer side */
  a: CompareSide; b: CompareSide;
  doc: { docId: string; path: string; docType: string };
  /** One line for the window's footer ("3 features changed, 120 mm³ added"). */
  setSummary(text: string): void;
}

export interface CompareView {
  /** Stop everything and leave the element empty. */
  close(): void;
}

export interface CompareRenderer {
  /** the server's document types this renderer compares ("part_studio") */
  docTypes: string[];
  mount(ctx: CompareContext): CompareView;
}

declare global {
  interface Window { JunctionCompareRenderers?: CompareRenderer[]; __kcAssetV?: string }
}

/** Called by a domain's editor bundle as it loads. */
export function registerCompareRenderer(renderer: CompareRenderer): void {
  const list = (window.JunctionCompareRenderers = window.JunctionCompareRenderers || []);
  for (const t of renderer.docTypes) { const i = list.findIndex((r) => r.docTypes.includes(t)); if (i >= 0) list.splice(i, 1); }
  list.push(renderer);
}

export function compareRendererFor(docType: string): CompareRenderer | undefined {
  return (window.JunctionCompareRenderers || []).find((r) => r.docTypes.includes(docType));
}

/** True for a document kind whose own bundle draws it (and so may bring a renderer). */
export function isHostedKind(docType: string): boolean {
  const kind = documentKind(docType);
  return !!kind && !!kind.bundle;
}

const loading = new Map<string, Promise<void>>();
/** The renderer for a kind, loading the kind's bundle if it is not on the page yet.  Rejects when the bundle brings none. */
export async function loadCompareRenderer(docType: string): Promise<CompareRenderer> {
  const have = compareRendererFor(docType);
  if (have) return have;
  const kind = documentKind(docType);
  if (!kind || !kind.bundle) throw new Error("This kind of document cannot be compared yet.");
  const src = kind.bundle;
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = src + (window.__kcAssetV ? "?v=" + window.__kcAssetV : "");
      tag.onload = () => resolve();
      tag.onerror = () => { tag.remove(); loading.delete(src); reject(new Error(`could not load ${src}`)); };
      document.head.appendChild(tag);
    });
    loading.set(src, p);
  }
  await p;
  const r = compareRendererFor(docType);
  if (!r) throw new Error(`Comparing a ${kind.title.toLowerCase()} is not available yet.`);
  return r;
}
