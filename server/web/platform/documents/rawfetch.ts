// rawfetch.ts — the browser's own `fetch`, for the shell's requests.
//
// While a PCB in a folder of its own is open, the schematic and board editor wraps `window.fetch` so that the
// paths it sends are put under that folder (web/domains/pcb/editor/pcbscope.ts).  The shell (the document tabs,
// the Home tab) names files by their place in the whole project and must not be rewritten: it asks through this.
type RawFetch = typeof fetch;
declare global { interface Window { __junctionRawFetch?: RawFetch } }

export function rawFetch(): RawFetch {
  if (typeof window !== "undefined" && window.__junctionRawFetch) return window.__junctionRawFetch;
  return (input, init) => fetch(input, init);
}
