// web-path.js — where a server/web module lives for the tests that bundle or read one directly.
// server/web is split into shared/, platform/ and domains/<domain>/ (see server/web/README.md); a test names
// a module by its path inside its area ("editor/ruler.ts", "generated/kicad-menu-spec.json") and webPath
// finds the area from the first segment.  A path that already starts at an area is taken as it is.
const path = require("path");

const WEB = path.join(__dirname, "..", "..", "web");
const AREA = {};
for (const d of ["ai", "calculator", "canvas", "dialogs", "editor", "fab", "generated", "harness", "importgfx", "library", "mcp", "parts",
                 "plugins", "router", "sim", "symedit", "symview", "tools", "viewer3d", "actions.ts", "ctxspec.ts", "fonts-used.ts",
                 "iconpack.ts", "menuspec.ts", "panels-api.ts", "spec.ts", "tables.ts"]) AREA[d] = "domains/pcb";
for (const d of ["home", "landing", "onboarding", "github", "review", "wakatime", "admin", "styleguide"]) AREA[d] = "platform";
for (const d of ["components", "styles", "brand.ts", "keys.ts", "menufit.ts", "store.ts", "theme.ts", "tooltip.ts", "units.ts", "util.ts"]) AREA[d] = "shared";

/** webPath("editor", "ruler.ts") or webPath("editor/ruler.ts") -> .../server/web/domains/pcb/editor/ruler.ts */
function webPath(...segments) {
  const rel = path.join(...segments).split(path.sep);
  const area = AREA[rel[0]];
  return path.join(WEB, ...(area ? area.split("/") : []), ...rel);
}

module.exports = { WEB, webPath };
