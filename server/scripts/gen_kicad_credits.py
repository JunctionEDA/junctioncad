#!/usr/bin/env python3
"""Generate server/web/domains/pcb/generated/kicad-credits.json: the contributor lists of KiCad's About dialog
(common/dialog_about/AboutDialog_main.cpp s_developers, s_docWriters, s_translators, s_librarians, s_artists and
s_packagers) with the category each is listed under (buildKicadAboutBanner), in the source's order.

    python3 server/scripts/gen_kicad_credits.py
"""
import json
import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SRC = os.path.join(ROOT, "common", "dialog_about", "AboutDialog_main.cpp")
OUT = os.path.join(ROOT, "server", "web", "domains", "pcb", "generated", "kicad-credits.json")

DEV_CATEGORIES = {"LEAD_DEV": "Lead Development Team", "FORMER_DEV": "Lead Development Alumni", "CONTRIB_DEV": "Additional Contributions By"}
LIB_CATEGORIES = {"LIBRARIAN_TEAM": "Librarian Team", "MODELS_3D_CONTRIBUTION": "3D models", "SYMBOL_LIB_CONTRIBUTION": "Symbols", "FOOTPRINT_LIB_CONTRIBUTION": "Footprints"}
STR = r'wx[TS]\(\s*"((?:[^"\\]|\\.)*)"\s*\)'


def block(text, name):
    m = re.search(r"static const [^\n]*\b" + name + r"\[\]\s*=\s*\{(.*?)\n\};", text, re.S)
    if not m:
        raise SystemExit("no " + name + " in " + SRC)
    return re.sub(r"(?m)^\s*//[^\n]*", "", m.group(1))


def unq(s):
    return bytes(s, "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8") if "\\" in s else s


def main():
    text = open(SRC, encoding="utf-8").read()
    out = {"developers": [], "docWriters": [], "translators": [], "librarians": [], "artists": [], "packagers": []}
    for m in re.finditer(r"\{\s*" + STR + r"\s*,\s*(\w+)\s*\}", block(text, "s_developers")):
        out["developers"].append({"name": unq(m.group(1)), "category": DEV_CATEGORIES.get(m.group(2), m.group(2))})
    for m in re.finditer(STR, block(text, "s_docWriters")):
        out["docWriters"].append({"name": unq(m.group(1)), "category": "Documentation Team"})
    for m in re.finditer(r"\{\s*" + STR + r"\s*,\s*" + STR + r"\s*\}", block(text, "s_translators")):
        out["translators"].append({"name": unq(m.group(1)), "category": unq(m.group(2))})
    for m in re.finditer(r"\{\s*" + STR + r"\s*,\s*(\w+)\s*(?:,\s*" + STR + r"\s*)?\}", block(text, "s_librarians")):
        e = {"name": unq(m.group(1)), "category": LIB_CATEGORIES.get(m.group(2), m.group(2))}
        if m.group(3):
            e["url"] = unq(m.group(3))
        out["librarians"].append(e)
    for m in re.finditer(STR, block(text, "s_artists")):
        out["artists"].append({"name": unq(m.group(1)), "category": "Icons"})
    for m in re.finditer(STR, block(text, "s_packagers")):
        out["packagers"].append({"name": unq(m.group(1)), "category": "Package Developers"})
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(OUT, {k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
