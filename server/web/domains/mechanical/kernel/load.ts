// load.ts — fetching and starting OpenCascade.  Kept apart from occ.ts so that code which is handed a kernel
// (the regeneration engine, features, tests) does not pull the loader into its bundle.
import { Kernel } from "./occ";
import { compileKernel } from "./wasm";

/** How a kernel is found: its bytes (node, tests), a compiled module (handed on by the page), or where to fetch it. */
export type KernelSource = { wasmBinary: ArrayBuffer | Uint8Array } | { wasmUrl: string; module?: WebAssembly.Module | null };

/** Load the kernel. */
export async function loadKernel(source: KernelSource): Promise<Kernel> {
  const init = (await import("replicad-opencascadejs")).default;
  if (!("wasmUrl" in source)) return new Kernel(await init({ wasmBinary: source.wasmBinary }));
  const url = source.wasmUrl;
  // node (the assistant's host) is told a path: the generated loader reads the file itself
  if (!/^https?:/.test(url) || typeof fetch !== "function") return new Kernel(await init({ locateFile: () => url }));
  // In a browser the module is instantiated here rather than by the generated loader: from the module the page
  // compiled once for all its workers when it sent one (client.ts), else compiled here with the retries above.
  let failed: (e: unknown) => void = () => {};
  const failure = new Promise<never>((_, reject) => { failed = reject; });
  const started = init({
    locateFile: () => url,
    instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
      void (async () => {
        const module = source.module || await compileKernel(url);
        receive(await WebAssembly.instantiate(module, imports), module);
      })().catch(failed);
      return {};
    },
  } as never);
  return new Kernel(await Promise.race([started, failure]));
}
