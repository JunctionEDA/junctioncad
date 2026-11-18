/* The XSPICE code model libraries linked into ngspice itself (WebAssembly has no dlopen of a plain file).
   `codemodel .../analog.cm` (spinit) asks load_opus for the library; load_opus asks here first and registers the
   devices and user-defined nodes found, as it does with what a library's CMdevs and CMudns return.  The code models
   call ngspice's own functions directly, so the core interface (CMgetCoreItfPtr) has nothing to do. */
#include <string.h>
#include "kc_static_cm_table.c"

int kc_static_cm(const char *name, int *ndev, SPICEdev ***devs, int *nudn, Evt_Udn_Info_t ***udns)
{
    const char *base = strrchr(name, '/');
    size_t i, n;
    base = base ? base + 1 : name;
    for (i = 0; i < sizeof kc_cm_libs / sizeof kc_cm_libs[0]; i++) {
        size_t len = strlen(kc_cm_libs[i].name);
        if (strncmp(base, kc_cm_libs[i].name, len) != 0 || strcmp(base + len, ".cm") != 0)
            continue;
        for (n = 0; kc_cm_libs[i].devs[n]; n++) ;
        *ndev = (int) n; *devs = kc_cm_libs[i].devs;
        for (n = 0; kc_cm_libs[i].udns[n]; n++) ;
        *nudn = (int) n; *udns = kc_cm_libs[i].udns;
        return 1;
    }
    return 0;
}
