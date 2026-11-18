#!/usr/bin/env python3
"""Build server/seed/devboard-demo.zip, the "Devboard Demo" project every new account starts with.

It is a snapshot of the hardware folder of github.com/notaroomba/cyberboard: the schematic, the board, the
project file, both library tables and the project's own library (lib/lcsc.kicad_sym, lib/lcsc.pretty,
lib/lcsc.3dshapes with every STEP and WRL model).  Production outputs, the panel, logs, backups, the local
settings file (.kicad_prl), the footprint cache and the 20 MB whole-board STEP export are left out.

Two changes are made, nothing else in the design is touched:
  * The files take the project's name (Devboard_Demo.kicad_*), and so do the three places a KiCad project
    spells its own file name inside its files: the project file's "filename" entries, each symbol's
    (instances (project "...")) and each footprint's (sheetfile "....kicad_sch").  This is what
    server/src/templates.rs `renamed` does for the starter templates.
  * The lcsc parts name their models "/lib/lcsc.3dshapes/X.wrl", an absolute path that only resolves on the
    machine that wrote it; they become "${KIPRJMOD}/lib/lcsc.3dshapes/X.wrl" so KiCad desktop finds the
    model inside the project (the web viewer already reads the STEP beside it).

Usage: python3 scripts/seed/devboard-demo.py <cyberboard checkout> [out.zip]
"""
import os
import sys
import zipfile

OLD, NEW = "Cyberboard", "Devboard_Demo"
BAD_MODEL = '(model "/lib/lcsc.3dshapes/'
GOOD_MODEL = '(model "${KIPRJMOD}/lib/lcsc.3dshapes/'


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    hw = os.path.join(sys.argv[1], "hardware")
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "..", "..", "seed", "devboard-demo.zip")

    def text(name: str) -> str:
        with open(os.path.join(hw, name), encoding="utf-8") as f:
            return f.read()

    files: list[tuple[str, bytes]] = []
    pro = text(f"{OLD}.kicad_pro")
    for ext in ("kicad_pro", "kicad_sch"):
        pro = pro.replace(f'"filename": "{OLD}.{ext}"', f'"filename": "{NEW}.{ext}"')
    sch = text(f"{OLD}.kicad_sch").replace(f'(project "{OLD}"', f'(project "{NEW}"')
    pcb = text(f"{OLD}.kicad_pcb").replace(f'(sheetfile "{OLD}.kicad_sch")', f'(sheetfile "{NEW}.kicad_sch")')
    pcb = pcb.replace(BAD_MODEL, GOOD_MODEL)
    assert f'(project "{OLD}"' not in sch and f'(sheetfile "{OLD}' not in pcb and BAD_MODEL not in pcb
    files += [(f"{NEW}.kicad_pro", pro.encode()), (f"{NEW}.kicad_sch", sch.encode()), (f"{NEW}.kicad_pcb", pcb.encode())]
    files += [(t, text(t).encode()) for t in ("sym-lib-table", "fp-lib-table")]
    files.append(("lib/lcsc.kicad_sym", text("lib/lcsc.kicad_sym").encode()))

    for sub in ("lib/lcsc.pretty", "lib/lcsc.3dshapes"):
        for name in sorted(os.listdir(os.path.join(hw, sub))):
            path = f"{sub}/{name}"
            if name.startswith("."):
                continue
            if name.endswith(".kicad_mod"):
                files.append((path, text(path).replace(BAD_MODEL, GOOD_MODEL).encode()))
            elif name.lower().endswith((".step", ".stp", ".wrl")):
                with open(os.path.join(hw, path), "rb") as f:
                    files.append((path, f.read()))

    # The two fonts the schematic and board text use (face "Blender Pro Bold" and "Cynatar"), from the repo's
    # docs/fonts.  They are not project documents: demo.rs stores them as the project's fonts (project_font_files),
    # where the web editor, plots and the desktop fetch a face that is not installed.
    for name, face in (("BlenderProBold.ttf", "Blender Pro Bold"), ("Cynatar.otf", "Cynatar")):
        assert f'(face "{face}")' in sch + pcb
        with open(os.path.join(sys.argv[1], "docs", "fonts", name), "rb") as f:
            files.append((f"fonts/{face}/{name}", f.read()))

    # Every model a footprint names must be in the project.
    names = {p for p, _ in files}
    for path, data in files:
        if path.endswith((".kicad_pcb", ".kicad_mod")):
            for line in data.decode().split("\n"):
                if GOOD_MODEL in line:
                    model = line.split('"')[1].replace("${KIPRJMOD}/", "")
                    if model in names:
                        continue
                    # The board must find every model; a library footprint the board does not use may lack one
                    # (cyberboard's lcsc.pretty has a few whose model was never downloaded).
                    assert path.endswith(".kicad_mod"), f"{path} names {model}, which is not in the project"
                    print(f"note: {path} names {model}, which cyberboard does not have either")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path, data in files:
            info = zipfile.ZipInfo(path, date_time=(2026, 11, 16, 0, 0, 0))  # byte-stable output
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data, compresslevel=9)
    print(f"{out}: {len(files)} files, {sum(len(d) for _, d in files)} bytes, {os.path.getsize(out)} zipped")


if __name__ == "__main__":
    main()
