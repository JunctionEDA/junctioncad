/* SetAnalyse for the WebAssembly ngspice: the progress libngspice reports through its status callback (sharedspice.c,
   what KiCad's simulator shows in its status bar), passed to the page as Module.kcProgress(analysis, permille).
   The page may wait there (the run gives way to the page's events) and answers non-zero to stop: ngspice is then
   interrupted as by Ctrl-C (ft_intrpt), so the analysis ends where it is and keeps the points it computed. */
#include <emscripten.h>
#include <string.h>
#include "ngspice/ngspice.h"
#include "ngspice/bool.h"

extern bool ft_intrpt;

EM_ASYNC_JS(int, kc_progress_js, (const char *analysis, int permille), {
    if (!Module["kcProgress"]) return 0;
    return (await Module["kcProgress"](UTF8ToString(analysis), permille)) ? 1 : 0;
});

void SetAnalyse(const char *analysis, int permille)
{
    static char last[64];
    static int lastPermille = -2;
    if (permille == lastPermille && strncmp(last, analysis, sizeof last - 1) == 0)
        return;
    lastPermille = permille;
    strncpy(last, analysis, sizeof last - 1);
    if (kc_progress_js(analysis, permille))
        ft_intrpt = TRUE;
}
