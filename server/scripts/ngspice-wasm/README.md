# ngspice for the web

`build.sh` compiles ngspice 45.2 (the release KiCad 9 ships) to WebAssembly with XSPICE and its code models. The
simulator frame (`web/domains/pcb/sim/frame.ts`), the plugin runtime (`plugins/python/kicad_spice.py`) and the assistant's
`simulate` tool (`web/domains/pcb/mcp/simulate.ts`) all run this build.

## What is committed

| file | what it is |
| --- | --- |
| `vendor/ngspice/ngspice-core.mjs.br` | emscripten's ES module with the WebAssembly embedded (SINGLE_FILE), brotli-compressed: about 1.5 MB (7.7 MB unpacked) |
| `vendor/ngspice/build-meta.json` | the ngspice tag and commit, the emscripten version, the code model libraries, and the size and sha256 of the unpacked module |
| `scripts/ngspice-wasm/*` | the recipe: `build.sh`, the emscripten pre-js, the static code-model registry and the progress hook |

`npm run build` (`scripts/build-python.mjs`) unpacks the module and bundles it with `web/domains/pcb/plugins/ngspice-module.ts`
(the `Simulation` class every caller uses) into `static/dist/pyodide/ngspice.mjs`, about 8.9 MB. The server serves
it as `/static/pyodide/ngspice.mjs` (`pcm::runtime`, compressed on the wire). That file is generated and is never
committed. The worker loads it from there, and so do the plugin frame and `scripts/plugin-spice.mjs`.

## Rebuilding

```
server/scripts/ngspice-wasm/build.sh          # scratch in /dev/shm/ngspice-wasm-build; WORK=... to move it
KEEP=1 server/scripts/ngspice-wasm/build.sh   # keep the scratch folder
```

The build needs bash, git, gcc, make, autotools, bison, flex, python3 and node. It also needs network access to
github.com and storage.googleapis.com (for emsdk 7.0.0). It uses about 2.5 GB of scratch space and takes 10-15
minutes on 4 cores. At the end it writes both vendored files.

The build is reproducible. ngspice's build date is the tag's commit time (`SOURCE_DATE_EPOCH`), and the scratch
folder's path is mapped out of `__FILE__` (`-ffile-prefix-map`), so two runs give the sha256 recorded in
`build-meta.json`.

## How it differs from KiCad's ngspice

It has the devices and code models of the ngspice KiCad 9 bundles, HICUM L2 (a BJT of `level=8`) among them, with
these differences:

* **No OSDI.** ngspice is configured with `--disable-osdi` and the init script runs `unset osdi_enabled`. OSDI
  models (Verilog-A compiled by OpenVAF, loaded with `pre_osdi`) are native shared libraries, and WebAssembly cannot
  load them. A netlist that needs one fails here and runs in KiCad.
* **No d_cosim.** The verilog and vhdl libraries d_cosim loads (Icarus Verilog, GHDL) are not built.
* **No `plot` window.** `plot` in a `.control` block does nothing, as with the desktop's libngspice.

## The patches

* **The EEcircuit-Engine patches (MIT), but with hicum2.** The interactive prompt hands control to the page before
  it reads each command typed at the terminal (but not the lines of a script it sources). EEcircuit-Engine leaves
  hicum2 out; here it is built, as in KiCad's ngspice: HICUM L2 is C++ that catches no exceptions, so it only needs
  emscripten's C++ library at the link (`-lstdc++ -sDEFAULT_TO_CXX`) and cppduals' `std::is_compound` specialization
  allowed (`-Wno-invalid-specialization`).
* **XSPICE.** `cmpp` is built natively and preprocesses the code models: analog, digital, spice2poly, xtradev,
  xtraevt, table and tlines. Their objects are linked into ngspice. `codemodel <lib>.cm` (from spinit) registers a
  library from the static table instead of `dlopen()`ing it (`kc_static_cm.c`). verilog and vhdl (d_cosim's shared
  libraries) are not built.
* **Progress and Stop.** `SetAnalyse` (libngspice's status callback, which KiCad's status bar shows) calls the page
  (`kc_progress.c`). When the page answers "halt", ngspice sets `ft_intrpt`: the analysis stops where it is and keeps
  its points, as `NGSPICE::Stop` does.
* **Unknown model parameters.** musl's `strtod` sets `EINVAL` when it finds no number. Without a fix, a model
  parameter the device does not know would be a fatal error instead of "unrecognized parameter - ignored"
  (`inpgmod.c`).
* **`plot` without a graphics device.** It is a no-op, as it is in the desktop's libngspice. The "error" display
  device's entries are cast to every signature, and WebAssembly traps on that kind of call (`plotit.c`).
