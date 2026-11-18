// thumbnail.ts — sending a picture of a document to the server, for the project's card on the projects page, the
// project page and the document tabs.
//
// The server draws nothing itself.  An editor that has the document on screen renders a small picture and posts
// it to the same place the electronics editor posts its boards and sheets (POST /api/docs/{id}/preview, the
// doc_previews table; web/domains/pcb/editor/thumbpush.ts).  The store holds SVG documents, so the picture
// travels as an SVG with one <image>.  Only someone who may edit can post (the server refuses anyone else).
//
//   const t = new ThumbnailPusher(docId, () => canvasOrNull);   // the editor's own render, at any size
//   t.dirty();                                                   // the document changed: send once it is quiet
//   t.stop();

const QUIET_MS = 4000;        // wait this long after the last change
const MIN_GAP_MS = 20000;     // and never send more often than this
export const THUMB_LONG_SIDE = 960;

export function previewUrl(docId: string, stamp?: string | number): string {
  return `/api/docs/${docId}/preview.svg` + (stamp !== undefined ? `?v=${encodeURIComponent(String(stamp))}` : "");
}

/** Post a canvas as the document's picture.  Resolves true when the server took it. */
export async function postThumbnail(docId: string, canvas: HTMLCanvasElement): Promise<boolean> {
  const w = canvas.width, h = canvas.height;
  if (!(w > 8 && h > 8)) return false;
  const data = canvas.toDataURL("image/png");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image width="${w}" height="${h}" href="${data}"/></svg>`;
  // previews are ordered by `seq`, newest wins; these documents have no single counter to give, so the clock does
  const seq = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch(`/api/docs/${docId}/preview?seq=${seq}&fit=true`, { method: "POST", credentials: "same-origin", headers: { "content-type": "image/svg+xml" }, body: svg });
    return r.ok;
  } catch (e) { return false; }
}

export class ThumbnailPusher {
  private timer = 0;
  private lastSent = 0;
  private sending = false;
  private stopped = false;
  private last = "";

  /** `render` draws the document as it is now and returns the canvas, or null when there is nothing to show (or the person may not edit). */
  constructor(private readonly docId: string, private readonly render: () => HTMLCanvasElement | null, private readonly key: () => string = () => String(Date.now())) {}

  /** The document on screen changed (or was just opened). */
  dirty(): void {
    if (this.stopped) return;
    window.clearTimeout(this.timer);
    const wait = this.lastSent ? Math.max(QUIET_MS, MIN_GAP_MS - (Date.now() - this.lastSent)) : QUIET_MS;
    this.timer = window.setTimeout(() => { void this.send(); }, wait);
  }

  /** Send now if anything changed since the last one (for tests, and for the moment a tab is left). */
  async send(): Promise<boolean> {
    if (this.stopped || this.sending) return false;
    const key = this.key();
    if (key === this.last) return false;
    let canvas: HTMLCanvasElement | null = null;
    try { canvas = this.render(); } catch (e) { console.warn("thumbnail not drawn", e); }
    if (!canvas) return false;
    this.sending = true;
    const ok = await postThumbnail(this.docId, canvas);
    this.sending = false;
    if (ok) { this.last = key; this.lastSent = Date.now(); }
    return ok;
  }

  stop(): void { this.stopped = true; window.clearTimeout(this.timer); }
}
