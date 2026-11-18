#!/usr/bin/env bash
# ngspice compiled to WebAssembly with XSPICE and its code models, for the web simulator (web/domains/pcb/sim/frame.ts), the
# plugin runtime (plugins/python/kicad_spice.py) and the assistant's simulate tool (web/domains/pcb/mcp/simulate.ts).
#
# The result is server/vendor/ngspice/ngspice-core.mjs.br: emscripten's ES module with the WebAssembly inside it
# (SINGLE_FILE, UTF-8 embedded; about 7.7 MB), brotli-compressed to about 1.5 MB, and build-meta.json beside it.
# scripts/build-python.mjs bundles it with web/domains/pcb/plugins/ngspice-module.ts (the Simulation class every caller uses)
# into static/dist/pyodide/ngspice.mjs, which the server hands out as /static/pyodide/ngspice.mjs.
#
# What it takes:  bash, git, gcc, make, autoconf, automake, libtool, bison, flex, python3, xz, and network access to
# github.com (ngspice's mirror, emsdk) and storage.googleapis.com (emscripten's prebuilt toolchain).  About 2.5 GB of
# scratch space (the default is a folder under /dev/shm; set WORK to put it elsewhere), 10-15 minutes on 4 cores.
#
#   server/scripts/ngspice-wasm/build.sh            # builds and copies the module into server/vendor/ngspice
#   KEEP=1 server/scripts/ngspice-wasm/build.sh     # leaves the scratch folder for another run
#
# The recipe:
#   * ngspice 45.2 (the release KiCad 9 bundles), from the GitHub mirror of ngspice's git (tag ngspice-45.2);
#   * emscripten 7.0.0 (emsdk), ASYNCIFY so ngspice's interactive loop can wait for its next command without blocking;
#   * the patches EEcircuit-Engine (MIT) applies to build ngspice for the web (the prompt waits for the page between
#     commands), but not its leaving out hicum2: HICUM L2 (C++) is built and linked with emscripten's C++ library;
#   * OSDI is off: its models are native shared libraries (OpenVAF's .osdi files), which WebAssembly cannot load;
#   * XSPICE on: cmpp is built for this machine, preprocesses the code models (analog, digital, spice2poly, xtradev,
#     xtraevt, table, tlines), and their objects are linked into ngspice itself; `codemodel <lib>.cm` registers a
#     library from that table instead of dlopen()ing a file (kc_static_cm.c, the load_opus patch);
#   * progress: ngspice's SetAnalyse (the libngspice status callback KiCad's status bar shows) reaches the page, which
#     can answer "halt" (ft_intrpt, ngspice's Ctrl-C) so Stop ends an analysis and keeps what it computed (kc_progress.c).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$(cd "$HERE/../.." && pwd)"
WORK="${WORK:-/dev/shm/ngspice-wasm-build}"
NG_TAG="${NG_TAG:-ngspice-45.2}"
EM_VERSION="${EM_VERSION:-7.0.0}"
OUT="$SERVER/vendor/ngspice"
JOBS="${JOBS:-$(nproc)}"
CMLIBS="analog digital spice2poly xtradev xtraevt table tlines"

mkdir -p "$WORK"
cd "$WORK"

# ---- emscripten
if [ ! -x emsdk/emsdk ]; then git clone --depth 1 https://github.com/emscripten-core/emsdk.git; fi
if [ ! -f "emsdk/.installed-$EM_VERSION" ]; then
  (cd emsdk && ./emsdk install "$EM_VERSION" && ./emsdk activate "$EM_VERSION" && rm -rf downloads/* && touch ".installed-$EM_VERSION")
fi
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null

# ---- ngspice source, patched
rm -rf ngspice
git clone --depth 1 -b "$NG_TAG" https://github.com/imr/ngspice.git ngspice
cd ngspice
# the build date ngspice prints (NGSPICEBUILDDATE, __DATE__) is the tag's: the same source gives the same bytes
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"; export SOURCE_DATE_EPOCH

# hicum2 (HICUM L2, the BJT's level=8) is C++ that catches no exceptions: it is built, as KiCad's ngspice has it, and
# the link takes emscripten's C++ library
sed -i 's/-Wno-unused-but-set-variable/-Wno-unused-const-variable/g' configure.ac
sed -i 's/AC_CHECK_FUNCS(\[time getrusage\])/AC_CHECK_FUNCS([time])/g' configure.ac

# the interactive prompt hands control to the page before it reads each command from the terminal (not the lines of
# a script it sources, such as spinit): Module.handleThings
python3 - <<'PY'
p = "src/frontend/control.c"
s = open(p).read()
hack = """#include <emscripten.h>

EM_ASYNC_JS(void, eesim_sleep_hack, (), {
    if (Module["handleThings"]) {
        await new Promise((resolve) => {
            Module["handleThings"]();
        });
    }
});

"""
s = s.replace('#include "ngspice/ngspice.h"', hack + '#include "ngspice/ngspice.h"', 1)
a = "freewl = wlist = getcommand(string);"
assert a in s
s = s.replace(a, "if (!string && (!cp_inp_cur || cp_inp_cur == cp_in))\n\t\t\teesim_sleep_hack();\n\n\t\t" + a, 1)
open(p, "w").write(s)
PY
grep -q eesim_sleep_hack src/frontend/control.c

# progress reports (SetAnalyse) in this build too: kc_progress.c
python3 - <<'PY'
import re
p = "src/include/ngspice/ngspice.h"
s = open(p).read()
s = s.replace('#ifdef HAS_WINGUI\n#include "ngspice/wstdio.h"', '#ifdef __EMSCRIPTEN__\n#define HAS_PROGREP\nextern void SetAnalyse(const char *Analyse, int Percent);\n#endif\n\n#ifdef HAS_WINGUI\n#include "ngspice/wstdio.h"', 1)
assert "__EMSCRIPTEN__" in s
open(p, "w").write(s)
# codemodel <lib>.cm: the code models linked into ngspice (kc_static_cm.c) before any file
p = "src/spicelib/devices/dev.c"
s = open(p).read()
s = s.replace("int load_opus(const char *name)\n{", "extern int kc_static_cm(const char *name, int *ndev, SPICEdev ***devs, int *nudn, Evt_Udn_Info_t ***udns);\n\nint load_opus(const char *name)\n{", 1)
s = s.replace("    lib = dlopen(name, RTLD_NOW);\n//", "    {\n        int sn, su; SPICEdev **sd; Evt_Udn_Info_t **suu;\n        if (kc_static_cm(name, &sn, &sd, &su, &suu)) { add_device(sn, sd, 1); add_udn(su, suu); return 0; }\n    }\n    lib = dlopen(name, RTLD_NOW);\n//", 1)
assert "kc_static_cm(name" in s
open(p, "w").write(s)
# musl's strtod sets EINVAL when there is no number at all (glibc does not): a model parameter the device does not
# have is then fatal instead of "unrecognized parameter (x) - ignored", as on the desktop
p = "src/spicelib/parser/inpgmod.c"
s = open(p).read()
a = "if ((errno == ERANGE && dval == HUGE_VAL) || errno != 0) {"
assert a in s
s = s.replace(a, "if (endptr != parm && ((errno == ERANGE && dval == HUGE_VAL) || errno != 0)) {", 1)
open(p, "w").write(s)
# `plot` with no graphics device: the "error" device's entries are a no-op cast to every signature, which a native
# build calls harmlessly and WebAssembly traps on (a call through a pointer of another type).  The plot is left out,
# as it draws nothing on the desktop's libngspice either (KiCad's demos have plot lines in their .control blocks).
p = "src/frontend/plotting/plotit.c"
s = open(p).read()
a = "bool plotit(wordlist *wl, const char *hcopy, const char *devname)\n{\n"
assert a in s
s = s.replace(a, a + "    if (!hcopy && !devname && dispdev && strcmp(dispdev->name, \"error\") == 0)\n        return FALSE;\n", 1)
s = s.replace('#include "ngspice/ngspice.h"', '#include "ngspice/ngspice.h"\n#include "ngspice/ftedev.h"', 1)
open(p, "w").write(s)
PY
# cmpp runs here (built for this machine below) and the code models are linked into ngspice: neither is made by
# ngspice's own makefiles.  verilog and vhdl are the shared libraries d_cosim loads (Icarus, GHDL): not on the web.
sed -i 's/^SUBDIRS = mif cm enh evt ipc idn cmpp icm verilog vhdl/SUBDIRS = mif cm enh evt ipc idn/' src/xspice/Makefile.am
grep -q '^SUBDIRS = mif cm enh evt ipc idn$' src/xspice/Makefile.am

./autogen.sh >/dev/null

# ---- cmpp for this machine
mkdir -p ../cmpp && (
  cd src/xspice/cmpp
  bison -d -o "$WORK/cmpp/ifs_yacc.c" ifs_yacc.y && bison -d -o "$WORK/cmpp/mod_yacc.c" mod_yacc.y
  flex -o "$WORK/cmpp/ifs_lex.c" ifs_lex.l && flex -o "$WORK/cmpp/mod_lex.c" mod_lex.l
  gcc -O1 -w -I. -I"$WORK/cmpp" -o "$WORK/cmpp/cmpp" main.c file_buffer.c pp_ifs.c pp_lst.c pp_mod.c read_ifs.c writ_ifs.c util.c \
    "$WORK/cmpp/ifs_yacc.c" "$WORK/cmpp/mod_yacc.c" "$WORK/cmpp/ifs_lex.c" "$WORK/cmpp/mod_lex.c"
)
CMPP="$WORK/cmpp/cmpp"

# ---- configure and build ngspice's libraries
mkdir -p release && cd release
# the build folder's path (in __FILE__ of ngspice's assertions) is left out, so any WORK gives the same bytes
PREFIX_MAP="-ffile-prefix-map=$WORK=/ngspice-wasm"
# cppduals (hicum2's automatic differentiation) specializes std::is_compound, which libc++ refuses unless told not to
emconfigure ../configure --host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu CC_FOR_BUILD=gcc CPPFLAGS="$PREFIX_MAP" \
  CXXFLAGS="-O2 -Wno-invalid-specialization" \
  --disable-debug --disable-openmp --enable-xspice --disable-osdi --without-x --with-readline=no >/dev/null

# ---- the code models: cmpp's sources, compiled with emcc
ICM_SRC=../src/xspice/icm
CMOBJ="$WORK/cmobj"; rm -rf "$CMOBJ"; mkdir -p "$CMOBJ"
CMFLAGS="-O2 $PREFIX_MAP -I$PWD/src/include -I../src/include -I../src/xspice/tlines -w"
for t in ../src/xspice/tlines/msline_common.c ../src/xspice/tlines/tline_common.c; do
  emcc $CMFLAGS -c "$t" -o "$CMOBJ/$(basename "$t" .c).o"
done
REG="$CMOBJ/kc_static_cm_table.c"
: > "$REG"
for cm in $CMLIBS; do
  gen="$WORK/cmgen/$cm"; rm -rf "$gen"; mkdir -p "$gen"
  (cd "$gen" && CMPP_IDIR="$OLDPWD/$ICM_SRC/$cm" CMPP_ODIR=. "$CMPP" -lst)
  for m in $("$CMPP" -p "$ICM_SRC/$cm/modpath.lst"); do
    mkdir -p "$gen/$m"
    (cd "$gen/$m" && CMPP_IDIR="$OLDPWD/$ICM_SRC/$cm/$m" CMPP_ODIR=. "$CMPP" -ifs && CMPP_IDIR="$OLDPWD/$ICM_SRC/$cm/$m" CMPP_ODIR=. "$CMPP" -mod)
    for f in cfunc ifspec; do
      emcc $CMFLAGS -I"$gen" -I"$ICM_SRC/$cm" -I"$ICM_SRC/$cm/$m" -c "$gen/$m/$f.c" -o "$CMOBJ/${cm}__${m}__$f.o"
    done
  done
  for u in $("$CMPP" -p "$ICM_SRC/$cm/udnpath.lst"); do
    emcc $CMFLAGS -I"$gen" -I"$ICM_SRC/$cm" -I"$ICM_SRC/$cm/$u" -c "$ICM_SRC/$cm/$u/udnfunc.c" -o "$CMOBJ/${cm}__${u}__udnfunc.o"
  done
  # the library's tables, as its dlmain.c has them, under names of their own
  {
    echo "/* $cm.cm */"
    cat "$gen/cmextrn.h" "$gen/udnextrn.h"
    echo "static SPICEdev *kc_${cm}_devs[] = {"; cat "$gen/cminfo.h"; echo "NULL };"
    echo "static Evt_Udn_Info_t *kc_${cm}_udns[] = {"; cat "$gen/udninfo.h"; echo "NULL };"
  } >> "$REG"
done
{
  echo "static const struct { const char *name; SPICEdev **devs; Evt_Udn_Info_t **udns; } kc_cm_libs[] = {"
  for cm in $CMLIBS; do echo "  { \"$cm\", kc_${cm}_devs, kc_${cm}_udns },"; done
  echo "};"
} >> "$REG"
emcc $CMFLAGS -I"$CMOBJ" -include "$HERE/kc_static_cm_head.h" -c "$HERE/kc_static_cm.c" -o "$CMOBJ/kc_static_cm.o"
emcc $CMFLAGS -c "$HERE/kc_progress.c" -o "$CMOBJ/kc_progress.o"
# the helpers dlmain.c itself defines for the code models (fopen_with_path, cm_message_printf, cm_is_inertial); the
# rest of it forwards to ngspice's core, which the models reach directly here
{ grep '^#include' "$ICM_SRC/dlmain.c" | grep -v -e extrn.h -e info.h; sed -n '/^#define DFLT_BUF_SIZE/,$p' "$ICM_SRC/dlmain.c"
  # cm_getvar is the core's cp_getvar under the code models' name (cmexport.c)
  echo 'bool cm_getvar(char *name, enum cp_types type, void *retval, size_t rsize) { return cp_getvar(name, type, retval, rsize); }'; } > "$CMOBJ/kc_cm_helpers.c"
grep -q '^cm_message_printf' "$CMOBJ/kc_cm_helpers.c"
emcc $CMFLAGS -c "$CMOBJ/kc_cm_helpers.c" -o "$CMOBJ/kc_cm_helpers.o"

# ---- link: ngspice with the code models, as an ES module with the WebAssembly inside it
EXTRA_OBJS="$(ls "$CMOBJ"/*.o | tr '\n' ' ')"
# -lstdc++ -sDEFAULT_TO_CXX: emscripten's C++ library for hicum2, which an emcc link leaves out otherwise
LINK="-lstdc++ -sDEFAULT_TO_CXX=1 -O2 -s ASYNCIFY=1 -s ASYNCIFY_ADVISE=0 -s ASYNCIFY_IGNORE_INDIRECT=0 -s ASYNCIFY_STACK_SIZE=65536 -s STACK_SIZE=2097152 -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=2147483648 -s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 -s EXPORTED_RUNTIME_METHODS=[\"FS\",\"Asyncify\",\"callMain\",\"UTF8ToString\"] --pre-js $HERE/pre.js -o spice.mjs"
sed -i "s|\$(ngspice_LDADD) \$(LIBS)|\$(ngspice_LDADD) $EXTRA_OBJS \$(LIBS) $LINK|" src/Makefile
grep -q "SINGLE_FILE" src/Makefile
emmake make -j"$JOBS" >/dev/null 2> "$WORK/make-errors.log" || { tail -40 "$WORK/make-errors.log"; exit 1; }

mkdir -p "$OUT"
# kept compressed (brotli, which node reads without anything else): build-python.mjs unpacks it as it bundles
node -e 'const z=require("zlib"),fs=require("fs");const b=fs.readFileSync(process.argv[1]);fs.writeFileSync(process.argv[2],z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:11,[z.constants.BROTLI_PARAM_LGWIN]:24,[z.constants.BROTLI_PARAM_SIZE_HINT]:b.length}}))' src/spice.mjs "$OUT/ngspice-core.mjs.br"
{
  echo "{"
  echo "  \"ngspice\": \"$NG_TAG\","
  echo "  \"ngspiceCommit\": \"$(git -C .. rev-parse HEAD)\","
  echo "  \"emscripten\": \"$EM_VERSION\","
  echo "  \"codeModels\": \"$(echo $CMLIBS)\","
  echo "  \"bytes\": $(stat -c %s src/spice.mjs),"
  echo "  \"sha256\": \"$(sha256sum src/spice.mjs | cut -d' ' -f1)\""
  echo "}"
} > "$OUT/build-meta.json"
ls -l "$OUT"
cd "$WORK"
if [ -z "${KEEP:-}" ]; then rm -rf "$WORK/ngspice" "$WORK/cmobj" "$WORK/cmgen" "$WORK/cmpp"; fi
