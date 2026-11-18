# server/web: the browser app

TypeScript and React, bundled by esbuild into `server/static` (`npm run build`; the entry points are in
`server/package.json`). The tree has three areas:

```
web/
  main.tsx            the React chrome's entry (static/dist/ui.js)
  shared/             used by every area: the store contract, theme, keys, units, menus, the UI kit, styles
    components/       menu bar, toolbars, docks, panes, selects, dialogs' widgets
    styles/           the Tailwind entry and home.css
    itemdoc/          JSON item documents (.jpart, .jasm): the format, item changes, the live session
    viewport3d/       the 3D viewport the modelling domains draw in
  platform/           what every kind of project shares
    home/             projects list, upload, sharing (ShareDialog), time page
    landing/          the public home page and its demos
    onboarding/       first-run guide
    github/           GitHub sync
    review/           version compare and review (a domain's own documents through a renderer it registers)
    history/          versions, branches and merging for the editor of any document that is not KiCad's
    mcp/              what a domain hands the headless tool host so an AI assistant can work on its documents
    wakatime/         time tracking
    documents/        how the shell hands a document to a domain's own editor
    doctabs/          the shell of an open project: its tab bar, what an element and a PCB are, the project's own document
    projecthome/      the Home tab: the file tree, create, import, who is where
    admin/, styleguide/
  domains/            one folder per kind of design work
    registry.ts       what each domain is, which files it opens and which domains it reads
    mcp-tools.ts      the domains that bring AI tools of their own (each from its mcp/ folder)
    pcb/              electronics: schematic, symbols, board, footprints, fab, simulation (shipped)
    mechanical/       part studios: sketcher, features, history tree, boards in and out, on OpenCascade (CONTRACT.md)
    assembly/         assemblies: instances of parts and boards, mates and their solver, interference, BOM
    physics/  silicon/  robotics/  manufacturing/   (planned)
```

Rules of thumb:

- `shared/` and `platform/` should not grow new imports from `domains/`. Some imports already go that way (the
  chrome mounts the electronics editor's menus and toolbars, and `platform/review` diffs KiCad documents). Untangling
  them is on the roadmap. Don't add more.
- A domain may import from `shared/` and `platform/`, but never from another domain's internals. Share through
  `shared/` or the domain's documented exports instead.
- Files under `domains/pcb/generated/` are written by `server/scripts/gen_*.py` from the C++ sources. Don't edit
  them by hand.
- `domains/mechanical/generated/` and `domains/assembly/generated/` are written by
  `scripts/gen-cad-registry.mjs` (`npm run gen:cad`, which `check`, `build` and the tests run) from the files in
  those domains' `features/`, `tools/`, `panels/`, `services/` and `mates/` folders. They are not committed.
- A project is a Home tab and any number of elements, one tab each: PCBs, part studios, assemblies
  (`platform/doctabs`, `platform/projecthome`). `domains/registry.ts` says which document kinds exist and which
  bundle draws each; a domain's editor registers itself through `platform/documents/host.ts`.
- A PCB is a KiCad project in a folder of its own, and the schematic and board editor sees one PCB at a time:
  `project.docs` is that PCB's documents with paths relative to its folder, `project.allDocs` is the whole
  project. Code outside the electronics editor reads `allDocs`. `platform/doctabs/pcbs.ts` has the rules; the
  section "Document tabs and the shell" of `domains/mechanical/CONTRACT.md` has the rest.

The tests in `server/static/tests` find modules with `webPath()` (`static/tests/web-path.js`), which knows
which area each top-level folder lives in.

See [STYLE.md](STYLE.md) for how the chrome is written, and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
for the whole repository.
