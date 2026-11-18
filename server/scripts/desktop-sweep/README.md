# Desktop sweep

Opens projects from a local test server in a packaged Junction the way a person does, and
records everything the app says. It found the missing project libraries, the font warning on
every open and the upload size limits; `desktop-load-check.mjs` (one folder up) is the fast
check for CI, this is the slow one with real windows.

For each demo in `demos/` and each variant (`desktop`, `web`, `edited`) it uploads the project,
presses Open in the project manager's Online Projects panel, loads the schematic and board
editors (they join the server), runs `kicad-cli` netlist, SVG and DRC, and writes one JSON line
per run to `$SWEEP_OUT/results.jsonl` with dialogs, info bars and library complaints.
Screenshots go to `$SWEEP_OUT/shots`.

## Needs

- macOS, with Accessibility and Screen Recording allowed for the terminal that runs it.
  Buttons are pressed through accessibility by process id, so the test windows never need the
  pointer or the keyboard focus.
- A packaged app (`packaging/macos/package_macos.py <build> <out> --app-only`). It is checked
  by `preflight.sh` first: every bundled library reference must resolve and `kicad-cli` must
  start. An app that fails is not launched.
- A local server (`KC_BIND_ADDR=127.0.0.1 KC_DEV_LOGIN=1 JWT_SECRET=… DATABASE_URL=… PORT=8125`),
  a user row in its database and a token for that user signed with the same secret.
- For the `edited` variant: `npm i playwright-core` next to `webedit.mjs`, and Chrome.
- A settings folder that has been through first-run setup at `$SWEEP_OUT/config/10.99`
  (otherwise the setup wizard is in the way).

## Run

```
SWEEP_OUT=/tmp/sweep JUNCTION_APP=/tmp/pkg/staging/Junction.app \
SWEEP_SERVER=http://127.0.0.1:8125 SWEEP_TOKEN=<test token> \
python3 sweep.py [demo name parts…]
```

`VARIANTS=desktop,web,edited` picks the variants (default `desktop,web`). Runs already in
`results.jsonl` are skipped, so a stopped sweep carries on where it was.

Test instances get `KICAD_CONFIG_HOME`, `KICAD_DOCUMENTS_HOME`, `KICAD_CACHE_HOME`,
`KICAD_COLLAB_SERVER` and `KICAD_COLLAB_TOKEN` under `$SWEEP_OUT`, so they never use the
settings, projects or sign-in of the person at the machine, and each is killed by its pid.

## Files

- `sweep.py`: the sweep.
- `webedit.mjs`: one edit per document from the web editor, then a download that folds it.
- `ax.swift`: list a process's windows, texts and buttons; press a button; select a list row.
- `wins.swift`: window ids of a process, for `screencapture -l`.
- `preflight.sh`: refuse a bundle with a dangling library reference.
