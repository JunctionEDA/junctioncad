// wasm.ts — compiling the kernel's WebAssembly module.  No imports: the page uses it too (client.ts compiles the
// module once and hands it to every worker), and must not pull the kernel itself into its bundle.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The kernel's module, compiled while it downloads.  A download that is cut short is tried again (three times,
 * a little later each time, past the browser's cache): several workers starting at once ask for the same 23 MB
 * and now and then one of them is dropped.
 */
export async function compileKernel(url: string): Promise<WebAssembly.Module> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(250 * attempt * attempt);
    try {
      const get = () => fetch(url, { credentials: "same-origin", ...(attempt ? { cache: "no-store" as const } : {}) });
      if (!attempt && typeof WebAssembly.compileStreaming === "function") return await WebAssembly.compileStreaming(get());
      const r = await get();
      if (!r.ok) throw new Error(`the kernel could not be downloaded (${r.status})`);
      return await WebAssembly.compile(await r.arrayBuffer());
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
