// load.ts — starting the constraint solver.  Kept apart from solve.ts so that the translation can be read (and
// type-checked) without the WebAssembly module.
//
// PlaneGCS is FreeCAD's 2D geometric constraint solver; @salusoft89/planegcs is its WebAssembly build with a
// thin wrapper (LGPL-2.1-or-later: compatible with this program's GPLv3).  The .wasm (0.5 MB) is carried in the
// bundle as base64 (generated/planegcs-wasm.ts, written by scripts/gen-cad-registry.mjs), so nothing is fetched
// and the server needs no route for it.  Starting it takes a few milliseconds; it is started when the first
// sketch is opened, never for a part studio that is only looked at.
import { Algorithm, GcsWrapper, init_planegcs_module } from "@salusoft89/planegcs";
import wasmBase64 from "../../generated/planegcs-wasm";
import { SketchSolver } from "./solve";

function bytes(b64: string): Uint8Array {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let loading: Promise<SketchSolver> | null = null;
let ready: SketchSolver | null = null;

/** The solver, started on first use.  The same instance every time. */
export function loadSolver(): Promise<SketchSolver> {
  if (!loading) {
    loading = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await (init_planegcs_module as any)({
        print: () => {}, printErr: () => {},
        // this build of the glue has no `wasmBinary` option: hand it the instance instead of letting it fetch one
        instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) => {
          void WebAssembly.instantiate(bytes(wasmBase64), imports).then((r) => done((r as unknown as WebAssembly.WebAssemblyInstantiatedSource).instance));
          return {};
        },
      });
      const wrapper = new GcsWrapper(new mod.GcsSystem(), mod);
      wrapper.debug_mode = 0;   // DebugMode.NoDebug: the solver logs every solve otherwise
      wrapper.set_max_iterations(200);
      ready = new SketchSolver({ wrapper, Algorithm });
      return ready;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** The solver if it has started, else null (and it is started for next time). */
export function solverNow(): SketchSolver | null {
  if (!ready) void loadSolver().catch(() => {});
  return ready;
}
