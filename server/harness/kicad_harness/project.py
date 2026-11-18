"""Projects, schematic sheets and boards as plain Python objects.

Nothing here writes KiCad file text.  Each method turns into one or a few edits for the design
engine (the editor's own code), which keeps the files valid and, on an online project, sends the
edits to everyone in the document.  Results are short summaries: references, counts and what
went wrong, never file contents.
"""
from __future__ import annotations

import contextlib
import json
import math
import os
import random
import re
import shutil
import uuid as _uuid

from .transport import HarnessError, Transport

GRID = 1.27
STUB = 2.54
_PAD = 3.81      # between a frame and what it holds
_HEAD = 6.35     # the strip a frame's heading takes
_TITLE = 2.54    # heading text height
_LINE = 2.286    # pitch of note lines
# A3 (11 x 17 in) is the smallest sheet a design is drawn on: nobody prints these, and white space is what separates blocks
_PAPERS = [("A3", 420.0, 297.0), ("A2", 594.0, 420.0), ("A1", 841.0, 594.0), ("A0", 1189.0, 841.0)]
_STAGE = (1524.0, 127.0)   # blocks are drawn off the page first, measured, then moved into place
_DIR = {"left": (-1, 0), "right": (1, 0), "top": (0, -1), "bottom": (0, 1)}
_LABEL_ROT = {"left": 180, "right": 0, "top": 90, "bottom": 270}
_SHAPE = {"output": "output", "power_out": "output", "input": "input", "power_in": "input", "bidirectional": "bidirectional", "tri_state": "bidirectional",
          "open_collector": "bidirectional", "open_emitter": "bidirectional"}     # a global label's shape from the pin it stands on
_GND_ROT = {"bottom": 0, "right": 90, "top": 180, "left": 270}
_SUPPLY_ROT = {"top": 0, "left": 90, "bottom": 180, "right": 270}
_GROUND = re.compile(r"^(A|D|P)?(GND|VSS|VEE)|^GND|^-\d|^Earth", re.I)
# names that read as a supply although KiCad's power library has no symbol for them; a measurement or control net named after one is not
_SUPPLY = re.compile(r"^(\+.+|[AD]?V(DD|CC|BUS|BAT|BATT|SYS|IN|OUT|REF|IO|PP|AA|M|CORE|REG|USB|DC|MAIN|RTC|SPI)(_?[A-Z0-9+.]+)*)$")
_NOT_SUPPLY = re.compile(r"SENSE|ADC|MON|DIV|DET|_EN$|_OK$|_PG$|FB|_ON$", re.I)
_POWER = re.compile(r"^(\+?\d+V\d*|\+\d.*|-\d+V\d*|GND\w*|VCC\w*|VDD\w*|VSS\w*|VEE\w*|VBUS|VBAT|VAA|VPP|\+BATT|-BATT|Earth\w*|[ADP]GND\w*)$")


def _snap(v: float, g: float = GRID) -> float:
    return round(round(v / g) * g, 4)


def _r(v: float) -> float:
    return round(v + 0.0, 4)


def _on_segment(p, a, b, eps=1e-3) -> bool:
    (px, py), (ax, ay), (bx, by) = p, a, b
    if abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) > eps * max(1.0, math.hypot(bx - ax, by - ay)):
        return False
    return min(ax, bx) - eps <= px <= max(ax, bx) + eps and min(ay, by) - eps <= py <= max(ay, by) + eps


def _num(v: float) -> str:
    """A coordinate as the file writes it: 43.18, 96.5, 100."""
    return ("%.4f" % v).rstrip("0").rstrip(".")


def _wire_is(sexpr: str, w) -> bool:
    """Is this wire's text the wire (x0, y0, x1, y1), in either direction?"""
    pts = [(float(x), float(y)) for x, y in re.findall(r"\(xy ([-0-9.]+) ([-0-9.]+)\)", sexpr)]
    return len(pts) == 2 and ((_same(pts[0], (w[0], w[1])) and _same(pts[1], (w[2], w[3]))) or (_same(pts[1], (w[0], w[1])) and _same(pts[0], (w[2], w[3]))))


def _same(p, q, eps=1e-3) -> bool:
    return abs(p[0] - q[0]) < eps and abs(p[1] - q[1]) < eps


def _overlap(a, b, c, d, eps=1e-3) -> bool:
    """Two segments lie along the same line and share more than a point."""
    if not (_on_line(c, a, b, eps) and _on_line(d, a, b, eps)):
        return False
    k = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
    lo, hi = sorted((a[k], b[k]))
    lo2, hi2 = sorted((c[k], d[k]))
    return min(hi, hi2) - max(lo, lo2) > eps


def _on_line(p, a, b, eps=1e-3) -> bool:
    return abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) <= eps * max(1.0, math.hypot(b[0] - a[0], b[1] - a[1]))


def _simplify(pts):
    out = []
    for p in pts:
        p = (_r(p[0]), _r(p[1]))
        if out and _same(out[-1], p):
            continue
        if len(out) >= 2 and _on_line(p, out[-2], out[-1]) and _on_segment(out[-1], out[-2], p):
            out[-1] = p
            continue
        out.append(p)
    return out


class Pin(dict):
    """One pin of a placed symbol: number, name, type, x, y, side, net."""

    @property
    def at(self):
        return (self["x"], self["y"])

    def __repr__(self):
        return f"{self['ref']}.{self['number']}({self['name']}) at {self.at} net {self['net'] or '-'}"


class Project:
    """A design: its schematic sheets and its board."""

    def __init__(self, transport: Transport):
        self.transport = transport
        info = getattr(transport, "documents", None) or transport.call("documents")
        self.name = info.get("project", "")
        self._docs = info.get("documents", [])
        self._open: dict = {}
        self.log: list = []
        self.footprints: dict = {}   # generated footprints by id, handed to the board when it syncs
        self.custom_power: dict = {}  # power symbols made for supply names KiCad's power library does not have: name -> symbol text
        self.net_pins: dict = {}     # net name given to build -> one of its pins, for nets that carry no label on the sheet
        self.refused: list = []      # why the checks refuse the design as it stands (board.design fills it): it is not drawn or saved while this is not empty
        self.dry_run = False         # run_python with dry_run: nothing is drawn, so a refusal is reported instead of raised

    def refusal(self) -> str:
        """The refusal as one message: what is wrong and that nothing was kept."""
        return ("The layout was refused and nothing was drawn: a board with these faults is not shown to anyone. Fix what is named (in the placement where it says so) and run again; "
                "use dry_run until nothing is refused.\n" + "\n".join("- " + r for r in self.refused[:12]) + (f"\n- and {len(self.refused) - 12} more" if len(self.refused) > 12 else ""))

    # ---- documents
    def documents(self) -> list:
        return [d["path"] for d in self._docs]

    def schematic(self, name: str | None = None) -> "Schematic":
        return self._doc(name, "schematic")

    def stored_net_pins(self) -> dict:
        """Names of nets wired without a label, as build() left them in the parts' hidden "Net names" fields: name -> "REF.pin".
        Read once per script, so a board script that did not draw the sheet can still name those nets."""
        if not self.__dict__.get("_stored_names"):
            self._stored_names = True
            for d in self._docs:
                if d["type"] != "schematic":
                    continue
                try:
                    rows = self.transport.call("list_components", {"document": d["path"]}).get("components", [])
                except HarnessError:
                    continue
                for c in rows:
                    for pair in str(c.get("net_names") or "").split():
                        num, _, name = pair.partition("=")
                        if num and name:
                            self.net_pins.setdefault(name, f"{c['ref']}.{num}")
        return self.net_pins

    sheet = schematic

    def board(self) -> "Board":
        return self._doc(None, "board")

    def _doc(self, name, kind):
        hits = [d for d in self._docs if d["type"] == kind and (not name or name.lower() in (d["path"].lower(), d["path"].lower().rsplit("/", 1)[-1], re.sub(r"\.kicad_\w+$", "", d["path"].lower().rsplit("/", 1)[-1])))]
        if not hits:
            raise HarnessError(f"This project has no {kind}{' named ' + name if name else ''}. Its documents are: {', '.join(self.documents()) or 'none'}.")
        path = hits[0]["path"]
        if path not in self._open:
            self._open[path] = (Schematic if kind == "schematic" else Board)(self, path)
        return self._open[path]

    # ---- life cycle
    def commit(self) -> None:
        """Send every queued edit to the engine."""
        for d in self._open.values():
            d.flush()

    def publish(self) -> int:
        """Draw what has been planned so far for the people watching.  Inside run_python the edits of a script are worked
        out in the host's copy of each document (every read sees them) and drawn live, each item once at its final place,
        when the script ends.  Nothing in the harness calls this by itself: a script is one planned change, drawn once, and a
        dry run draws nothing.  Call it only where a finished stage should be seen before a long one starts (the sheet
        before the board is routed).  Returns how many items were drawn (0 elsewhere, and in a dry run)."""
        self.commit()
        if getattr(self.transport, "kind", "") != "host":
            return 0
        return int((self.transport.call("publish", {}) or {}).get("drawn") or 0)

    def save(self, force: bool = False) -> list:
        """Commit, then write changed files back (local projects; an online project is always saved).  A layout the
        checks refuse (board.design) is not written unless force=True."""
        self.commit()
        if self.refused and not force:
            raise HarnessError(self.refusal())
        return self.transport.save()

    def close(self) -> None:
        self.transport.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.save()
        finally:
            self.close()

    def note(self, text: str) -> None:
        self.log.append(text)

    def summary(self) -> str:
        return "\n".join(self.log)


class _Doc:
    def __init__(self, project: Project, path: str):
        self.project = project
        self.path = path
        self._q: list = []
        self._keys: set = set()
        self._geom = None

    # ---- engine calls
    def _call(self, tool: str, **args):
        self.flush()
        args["document"] = self.path
        return self.project.transport.call(tool, args)

    def _edit(self, edit: dict, key: str | None = None) -> None:
        """Queue one edit.  Two edits of the same item cannot share a batch, so the queue is sent first."""
        if key is not None:
            if key in self._keys:
                self.flush()
            self._keys.add(key)
        self._q.append(edit)
        if len(self._q) >= 300:
            self.flush()

    def flush(self) -> dict | None:
        if not self._q:
            return None
        edits, self._q, self._keys, self._geom = self._q, [], set(), None
        res = self.project.transport.call("apply", {"document": self.path, "edits": edits})
        for line in res.get("connectivity") or []:
            self._connectivity.append(line)
        self._last = res
        if self.__dict__.get("_track") is not None:     # free_pins keeps what an attempt added, to take it back
            self._track.extend(res.get("added") or [])
        return res

    _connectivity: list = []
    _last: dict | None = None

    def geometry(self) -> dict:
        self.flush()
        if self._geom is None:
            self._geom = self._call("get_geometry")
        return self._geom

    @contextlib.contextmanager
    def unchanged(self):
        """A guard around a change of looks: `with sch.unchanged(): ...` (moving parts, redrawing wires, tidying) or
        `with board.unchanged(): ...` (clean-up, silkscreen, moving tracks).  When the block ends, the circuit must be
        what it was: on a sheet every net joins the same pins under the same name (nets KiCad names after a pin may
        be renamed) and the ERC has no more errors; on a board every pad is on the same net, no connection that was
        made is open, and the DRC has no more errors.  Anything else raises HarnessError saying exactly what
        differs, which ends a run before its changes are kept."""
        self.flush()
        board = hasattr(self, "unrouted")
        auto = lambda n: n.startswith("Net-(") or n.startswith("unconnected-(")
        def state():
            nets = self.nets()
            pins = {n: sorted(v["pads"] if board else v) for n, v in nets.items()}
            return pins, ({n: v["unrouted"] for n, v in nets.items() if v["unrouted"]} if board else {}), self.check()["errors"]
        pins0, open0, err0 = state()
        yield self
        self.flush()
        pins1, open1, err1 = state()
        diffs = []
        groups0 = {frozenset(v): n for n, v in pins0.items()}
        groups1 = {frozenset(v): n for n, v in pins1.items()}
        for g, n in groups0.items():
            if g not in groups1:
                now = sorted({m for m, v in pins1.items() if set(v) & g})
                diffs.append(f"net {n} ({', '.join(sorted(g)[:6])}{'...' if len(g) > 6 else ''}) is now {'split or joined into ' + ', '.join(now) if now else 'gone'}")
            elif groups1[g] != n and not (auto(n) and auto(groups1[g])):
                diffs.append(f"net {n} is now called {groups1[g]}")
        for g, n in groups1.items():
            if g not in groups0 and not any(set(v) & g for v in pins0.values()):
                diffs.append(f"net {n} ({', '.join(sorted(g)[:6])}) is new")
        for n, c in open1.items():
            if c > open0.get(n, 0):
                diffs.append(f"net {n} has {c - open0.get(n, 0)} connection{'s' if c - open0.get(n, 0) > 1 else ''} open that {'were' if c - open0.get(n, 0) > 1 else 'was'} made before")
        if err1 > err0:
            first = self.check(limit=3)["first"]
            diffs.append(f"the rules check has {err1 - err0} more error{'s' if err1 - err0 > 1 else ''} ({'; '.join(first)})")
        if diffs:
            raise HarnessError("The circuit changed inside a block that must leave it as it was: " + "; ".join(diffs[:8]) + (f"; and {len(diffs) - 8} more" if len(diffs) > 8 else "") + ".")

    def check(self, limit: int = 6, kind: str | None = None, warnings: bool = False) -> dict:
        """Run the rules check (ERC on a sheet, DRC on the board): counts by kind and the first few violations, errors first.
        `kind` lists only that kind ("unconnected_items", "clearance"); `warnings=True` lists warnings after the errors.
        What lies wholly inside one footprint (its own pads, holes, silk or courtyard, as its maker drew it) is not reported."""
        r = self._call("run_checks")
        kinds, wkinds = {}, {}
        for v in r.get("violations", []):
            d = kinds if v["severity"] == "error" else wkinds
            d[v["code"]] = d.get(v["code"], 0) + 1
        if r.get("by_kind") is not None:      # counted over every row (the list itself stops at 200)
            kinds, wkinds = dict(r["by_kind"]), dict(r.get("warnings_by_kind") or {})
        rows = [v for v in r.get("violations", []) if (v["code"] == kind if kind else v["severity"] == "error" or warnings)]
        rows.sort(key=lambda v: v["severity"] != "error")
        first = [f"{v['severity']} {v['code']}: {v['message']}" + (f" [{', '.join(v['refs'])}]" if v.get("refs") else "") + f" at ({v['x']}, {v['y']})" for v in rows[:limit]]
        out = {"check": r.get("check"), "errors": r.get("errors", 0), "warnings": r.get("warnings", 0), "by_kind": kinds, "first": first}
        if warnings or kind:
            out["warnings_by_kind"] = wkinds
        return out

    def clear(self, keep: tuple = ()) -> int:
        """Take everything off this sheet or board, for a rebuild from nothing.  `keep` names kinds of item to leave
        (on a board the outline stays unless outline=False is given to Board.clear).  Returns how many items were removed."""
        self.flush()
        count, skip = 0, set()
        for _ in range(400):   # get_items answers in pages: take a page off, ask again
            got = self._call("get_items", near={"x": 0, "y": 0, "radius": 1e7})
            todo = [it for it in got.get("items", []) if it["id"] not in skip]
            for it in todo:
                if it.get("kind") in keep or self._kept(it):
                    skip.add(it["id"])
                    continue
                self._edit({"op": "remove", "id": it["id"]})
                count += 1
            self.flush()
            if not todo or not any(it["id"] not in skip for it in todo):
                break
        if count:
            self.project.note(f"{getattr(self, 'path', None) or 'board'}: cleared {count} items")
        return count

    def _kept(self, it: dict) -> bool:
        return False

    def remove(self, *refs: str) -> None:
        """Delete parts by reference, or single items (a track segment, a via) by the id whats_at() or get_items gives."""
        for ref in refs:
            self._edit({"op": "remove", "ref": ref} if not re.fullmatch(r"[0-9a-f-]{36}", ref) else {"op": "remove", "id": ref}, "item:" + ref)

    def set(self, ref: str, **fields) -> None:
        """Set fields of a part: value=, footprint=, datasheet=, or any field name."""
        for name, value in fields.items():
            self._edit({"op": "set_field", "ref": ref, "field": {"value": "Value", "footprint": "Footprint", "datasheet": "Datasheet", "reference": "Reference"}.get(name, name), "value": str(value)}, "item:" + ref)
            self.flush()   # one item may take several fields: each is its own batch

    def text(self, text: str, at, size: float | None = None, bold: bool = False, italic: bool = False) -> None:
        """Free text; `at` is its bottom left.  On a sheet `size` is the height in mm (1.27 by default) and `bold` makes a heading."""
        e = {"op": "add_text", "text": text, "x": _r(at[0]), "y": _r(at[1])}
        if size:
            e["size"] = size
        if bold:
            e["bold"] = True
        if italic:
            e["italic"] = True
        self._edit(e)

    def svg(self, path: str | None = None, box=None, zones: bool = True, hide=None, copper_only: bool = False) -> str:
        """The sheet or the board as an SVG drawing, the way the editor shows it (local projects).  Written to `path` when given.
        zones=False leaves the pours out (to see a fan-out under a ground fill); hide=["B.Cu", "In1.Cu"] leaves those layers out
        copper_only=True leaves silkscreen, fab and courtyard drawings out, to read a fine-pitch fan-out."""
        r = self._call("render", **({"copper_only": True} if copper_only else {}), **({"box": list(box)} if box else {}), **({"zones": False} if not zones else {}), **({"hide": list(hide)} if hide else {}))
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(r["svg"])
        return r["svg"]

    def highlight(self, refs=None, nets=None, area=None, at=None, note: str | None = None, seconds: int | None = None, ids=None) -> dict:
        """Point at parts, nets, a region [x0, y0, x1, y1] or a point [x, y] for the people who have the document open:
        outlined live on their canvas with the note beside the assistant's name tag, cleared after `seconds` (45).
        On local files there is nobody to show, and the call does nothing."""
        one = lambda v: [v] if isinstance(v, str) else list(v) if v else None  # noqa: E731
        args = {"refs": one(refs), "nets": one(nets), "ids": one(ids), "area": list(area) if area else None, "at": list(at) if at else None, "note": note, "seconds": seconds}
        return self._call("highlight", **{k: v for k, v in args.items() if v is not None})

    def clear_highlight(self) -> dict:
        """Take the highlight off now instead of waiting for it to clear."""
        return self._call("highlight", clear=True)

    def trace(self, net: str, highlight: bool = False, note: str | None = None) -> dict:
        """One net end to end: on the board its pads, routed length per layer, vias, islands and open connections;
        on a sheet its pins and labels.  `highlight=True` also lights it up for the people in the document."""
        args = {"net": net}
        if highlight:
            args["highlight"] = True
        if note:
            args["note"] = note
        return self._call("trace_net", **args)

    def add_item(self, sexpr: str) -> None:
        """Escape hatch for an item the other calls do not cover: one complete KiCad s-expression."""
        self._edit({"op": "add_item", "sexpr": sexpr})


class Schematic(_Doc):
    """One schematic sheet."""

    def __init__(self, project, path):
        super().__init__(project, path)
        self._facts: dict = {}
        self._connectivity = []
        self._auto_net = 0

    # ---- reading
    def parts(self, include_power: bool = False) -> list:
        """The parts on the sheet as short rows: ref, value, lib_id, x, y, rotation."""
        return [{k: p[k] for k in ("ref", "value", "lib_id", "x", "y", "rotation")} for p in self.geometry()["parts"] if include_power or not p.get("power")]

    def refs(self) -> list:
        return sorted({p["ref"] for p in self.geometry()["parts"] if not p.get("power")}, key=_ref_key)

    def pins(self, ref: str) -> list:
        """The pins of a part, each with its position and net."""
        out = []
        for p in self.geometry()["parts"]:
            if p["ref"].lower() == ref.lower():
                out += [Pin(ref=p["ref"], number=q[0], name=q[1], type=q[2], x=q[3], y=q[4], side=q[5], net=q[6], hidden=bool(q[7])) for q in p["pins"]]
        if not out:
            raise HarnessError(f"There is no part {ref} on {self.path}.")
        return out

    def pin(self, spec: str) -> Pin:
        """One pin by "REF.number" or "REF.name" (for example "U1.3" or "U1.VBUS")."""
        return self._pins(spec)[0]

    def _pins(self, spec) -> list:
        if isinstance(spec, Pin):
            return [spec]
        ref, _, which = str(spec).partition(".")
        if not which:
            raise HarnessError(f'A pin is written "REF.number" or "REF.name"; got "{spec}".')
        pins = self.pins(ref)
        bare = lambda n: re.sub(r"~\{(.*?)\}", r"\1", n).lower()   # an inverted pin is written ~{RST} in the library
        hit = [p for p in pins if p["number"] == which] or [p for p in pins if p["name"].lower() == which.lower()] or [p for p in pins if bare(p["name"]) == bare(which)]
        if not hit:
            raise HarnessError(f"{ref} has no pin {which}. Its pins are: " + ", ".join(f"{p['number']}={p['name']}" if p["name"] else p["number"] for p in pins[:80]))
        return hit

    def nets(self, filter: str | None = None) -> dict:
        """The nets of the sheet: name -> ["REF.pin", ...]."""
        r = self._call("list_nets", limit=1000000, **({"filter": filter} if filter else {}))
        return {n["name"]: [re.sub(r"\(.*\)$", "", p) for p in n["pins"]] for n in r.get("nets", [])}

    def net_of(self, spec: str) -> str:
        return self.pin(spec)["net"]

    def assign_pins(self, ref: str, mapping: dict) -> int:
        """Move nets between the interchangeable pins of a chip (an FPGA's or a microcontroller's I/O, a connector whose
        pin order is yours to choose): mapping is {pin number: net name}.  Each of those pins must carry its net as a
        label, on the pin or at the end of the wire that leaves it; the label is renamed, nothing else moves, so the
        sheet keeps its looks.  Returns how many pins changed.  `board.swap_pins()` works the mapping out from the layout."""
        g = self.geometry(); labelled = {(round(l[1], 2), round(l[2], 2)) for l in g["labels"]}; plan = []

        def label_point(pt):
            seen = set()
            for _ in range(8):
                k = (round(pt[0], 2), round(pt[1], 2))
                if k in labelled:
                    return pt
                seen.add(k); nxt = None
                for w in g["wires"]:
                    for a0, b0 in (((w[0], w[1]), (w[2], w[3])), ((w[2], w[3]), (w[0], w[1]))):
                        if (round(a0[0], 2), round(a0[1], 2)) == k and (round(b0[0], 2), round(b0[1], 2)) not in seen:
                            nxt = b0
                if nxt is None:
                    return None
                pt = nxt
            return None

        for num, net in mapping.items():
            pin = self.pin(f"{ref}.{num}"); net = str(net).lstrip("/")
            if (pin["net"] or "").lstrip("/") == net:
                continue
            pt = label_point(pin.at); hit = None
            if pt is not None:
                for it in self._call("get_items", kinds=["label", "global_label", "hierarchical_label"], near={"x": pt[0], "y": pt[1], "radius": 0.3}).get("items", []):
                    m = re.match(r'\((\w+) "((?:[^"\\]|\\.)*)"(?: \(shape (\w+)\))? \(at ([-\d.]+) ([-\d.]+) ([-\d.]+)\)', it["sexpr"])
                    if m and abs(float(m[4]) - pt[0]) < 0.01 and abs(float(m[5]) - pt[1]) < 0.01:
                        hit = (it["id"], m); break
            if not hit:
                raise HarnessError(f"{ref} pin {num} ({pin['net'] or 'no net'}) is not named by a label on the pin or on the wire leaving it, so its net cannot be moved to another pin. Nothing was changed.")
            plan.append((hit[0], hit[1], net))
        for lid, m, net in plan:
            self._edit({"op": "remove", "id": lid})
        for lid, m, net in plan:
            e = {"op": "add_label", "kind": m[1], "text": net, "x": float(m[4]), "y": float(m[5]), "rotation": float(m[6])}
            if m[3]:
                e["shape"] = m[3]
            self._edit(e)
        if plan:
            self.flush()
            self.project.note(f"{self.path}: {ref}: {len(plan)} pins given another net")
        return len(plan)

    def unconnected(self) -> list:
        """Pins that are on no net and carry no no-connect flag."""
        g = self.geometry()
        nc = [tuple(p) for p in g.get("no_connects", [])]
        counts: dict = {}
        for p in g["parts"]:
            for q in p["pins"]:
                counts[q[6]] = counts.get(q[6], 0) + 1
        out = []
        for p in g["parts"]:
            if p.get("power"):
                continue
            for q in p["pins"]:
                lone = not q[6] or (counts.get(q[6], 0) < 2 and (q[6].startswith("Net-(") or q[6].startswith("unconnected-")))
                if lone and not q[7] and not any(_same((q[3], q[4]), n) for n in nc) and not self._has_label_at((q[3], q[4]), g):
                    out.append(f"{p['ref']}.{q[0]}" + (f"({q[1]})" if q[1] else ""))
        return out

    def _has_label_at(self, pt, g) -> bool:
        ends = [(w[0], w[1]) for w in g["wires"]] + [(w[2], w[3]) for w in g["wires"]]
        return any(_same(pt, (l[1], l[2])) for l in g["labels"]) or any(_same(pt, e) for e in ends)

    # ---- library
    def lib(self, lib_id) -> dict:
        """Facts of a library symbol before it is placed: reference prefix, pins with offsets, body box."""
        if hasattr(lib_id, "facts"):
            return lib_id.facts()
        if lib_id not in self._facts:
            self._facts[lib_id] = self.project.transport.call("get_library_part", {"id": lib_id})
        return self._facts[lib_id]

    def pin_names(self, lib_id: str, vendor: str | None = None) -> dict:
        """A library symbol's pins as {number: "NAME (kind)"}, without its drawing: the cheap way to write a netlist for a
        part that is not placed yet.  A symbol with several units gives a list, one dict per unit.  `vendor` ("lcsc", ...)
        reads a vendor part by its id."""
        r = self.project.transport.call("get_library_part", {"id": lib_id, "brief": True, **({"vendor": vendor} if vendor else {})})
        r = r.get("symbol", r) if vendor else r
        return r.get("pins") or r.get("units") or {}

    # ---- placing
    def place(self, lib, at=None, ref: str | None = None, value: str | None = None, footprint: str | None = None,
              rotation: int = 0, mirror: str | None = None, fields: dict | None = None, unit: int | None = None) -> str:
        """Place a symbol and return its reference.

        `lib` is a KiCad library id ("Device:R"), a generated part (kicad_harness.parts) or a vendor
        part as {"vendor": "lcsc", "id": "C25744"}.  Without `at` a free spot on the sheet is found.
        """
        e: dict = {"op": "add_symbol", "rotation": rotation % 360}
        f = dict(fields or {})
        if hasattr(lib, "symbol"):   # a generated part carries its own drawing and footprint
            e["symbol"] = lib.symbol
            e["lib_id"] = lib.lib_id
            f = {**lib.fields(), **f}
            if lib.footprint_id and lib.footprint:
                self.project.footprints[lib.footprint_id] = lib.footprint
        elif isinstance(lib, dict):
            e["part"] = lib
        else:
            e["lib_id"] = lib
        if footprint:
            f["Footprint"] = footprint
        if f:
            e["fields"] = f
        if value is not None:
            e["value"] = str(value)
        if mirror:
            e["mirror"] = mirror
        if unit:
            e["unit"] = unit
        if ref:
            e["reference"] = ref
        if at is None:
            at = self._free_spot(lib if not isinstance(lib, dict) else None, rotation)
        e["x"], e["y"] = _snap(at[0]), _snap(at[1])
        self._edit(e)
        if ref:
            return ref
        res = self.flush() or {}
        m = re.match(r"Add (\S+)", (res.get("edits") or [""])[-1])
        return m.group(1) if m else ""

    def _box(self, lib, rotation=0):
        try:
            b = (self.lib(lib)["units"][0].get("body_box")) if lib is not None else None
        except HarnessError:
            b = None
        b = b or [-5.08, -5.08, 5.08, 5.08]
        if rotation % 180:
            b = [b[1], b[0], b[3], b[2]]
        return b

    def _free_spot(self, lib, rotation=0, margin=7.62):
        self.flush()
        g = self.geometry()
        b = self._box(lib, rotation)
        page = g.get("page") or [297, 210]
        boxes = [p["box"] for p in g["parts"] if p.get("box")]
        x0, y0 = 25.4 - b[0], 25.4 - b[1]
        y = y0
        while y < max(page[1] - 30, y0 + 1) * 3:
            x = x0
            while x + b[2] < page[0] - 20:
                rect = (x + b[0] - margin, y + b[1] - margin, x + b[2] + margin, y + b[3] + margin)
                if not any(rect[0] < o[2] and rect[2] > o[0] and rect[1] < o[3] and rect[3] > o[1] for o in boxes):
                    return (_snap(x, 2.54), _snap(y, 2.54))
                x += 5.08
            y += 5.08
        return (x0, y0)

    def move(self, ref: str, to=None, by=None, rotation: int | None = None) -> None:
        """Move a part to a point, or by an offset; its wires are not dragged along."""
        if to is None:
            p = next((q for q in self.geometry()["parts"] if q["ref"].lower() == ref.lower()), None)
            if not p:
                raise HarnessError(f"There is no part {ref} on {self.path}.")
            to = (p["x"] + (by[0] if by else 0), p["y"] + (by[1] if by else 0))
        e = {"op": "move", "ref": ref, "x": _snap(to[0]), "y": _snap(to[1])}
        if rotation is not None:
            e["rotation"] = rotation % 360
        self._edit(e, "item:" + ref)

    def rotate(self, ref: str, rotation: int) -> None:
        """Turn a part to an absolute rotation (0, 90, 180 or 270, counter-clockwise)."""
        p = next((q for q in self.geometry()["parts"] if q["ref"].lower() == ref.lower()), None)
        if not p:
            raise HarnessError(f"There is no part {ref} on {self.path}.")
        self._edit({"op": "move", "ref": ref, "x": p["x"], "y": p["y"], "rotation": rotation % 360}, "item:" + ref)

    # ---- wiring
    def wire(self, *points) -> None:
        """A wire through explicit points; pins may be given as "REF.pin"."""
        pts = [list(self.pin(p).at) if isinstance(p, (str, Pin)) else [_r(p[0]), _r(p[1])] for p in points]
        self._edit({"op": "add_wire", "points": pts})

    def junction(self, at) -> None:
        self._edit({"op": "add_junction", "x": at[0], "y": at[1]})

    def no_connect(self, *pins) -> None:
        """Mark pins as deliberately unconnected."""
        for spec in pins:
            for p in self._pins(spec):
                self._edit({"op": "add_no_connect", "x": p["x"], "y": p["y"]})

    def _blocked(self, path, g, ends) -> bool:
        """Would a wire along `path` touch something it is not meant to connect to?"""
        segs = list(zip(path, path[1:]))
        for p in g["parts"]:
            for q in p["pins"]:
                pt = (q[3], q[4])
                if any(_same(pt, e) for e in ends):
                    continue
                if any(_on_segment(pt, a, b) for a, b in segs):
                    return True
        pts = [(w[0], w[1]) for w in g["wires"]] + [(w[2], w[3]) for w in g["wires"]] + [(l[1], l[2]) for l in g["labels"]] + [tuple(j) for j in g["junctions"]]
        for pt in pts:
            if any(_same(pt, e) for e in ends):
                continue
            if any(_on_segment(pt, a, b) for a, b in segs):
                return True
        for w in g["wires"]:
            c, d = (w[0], w[1]), (w[2], w[3])
            for a, b in segs:
                if _overlap(a, b, c, d):
                    return True
                for v in path[1:-1]:
                    if _on_segment(v, c, d):
                        return True
        return False

    def _crossings(self, path, g) -> int:
        n = 0
        for a, b in zip(path, path[1:]):
            lo = (min(a[0], b[0]), min(a[1], b[1]))
            hi = (max(a[0], b[0]), max(a[1], b[1]))
            for p in g["parts"]:
                o = p.get("box")
                if o and lo[0] < o[2] - 0.6 and hi[0] > o[0] + 0.6 and lo[1] < o[3] - 0.6 and hi[1] > o[1] + 0.6:
                    n += 1
        return n

    def _taps(self, p: Pin, g):
        """Where a wire to this pin may start: the pin itself, or the middle of a wire already on it (a T with a junction)."""
        out = [(p.at, _DIR[p["side"]], False)]
        for w in g["wires"]:
            c, d = (w[0], w[1]), (w[2], w[3])
            if not (_same(c, p.at) or _same(d, p.at)) or math.hypot(d[0] - c[0], d[1] - c[1]) < 2 * GRID - 1e-6:
                continue
            horizontal = abs(d[1] - c[1]) < 1e-6
            m = (_snap((c[0] + d[0]) / 2), c[1]) if horizontal else (c[0], _snap((c[1] + d[1]) / 2))
            if _same(m, c) or _same(m, d):
                continue
            for dv in (((0, -1), (0, 1)) if horizontal else ((-1, 0), (1, 0))):
                out.append((m, dv, True))
        return out

    def _route(self, a: Pin, b: Pin, g):
        best = None
        for pa, da, ja in self._taps(a, g):
            for pb, db, jb in self._taps(b, g):
                cands = []
                for sa in (STUB, 2 * STUB, 0):
                    for sb in (STUB, 2 * STUB, 0):
                        ea = (pa[0] + da[0] * sa, pa[1] + da[1] * sa)
                        eb = (pb[0] + db[0] * sb, pb[1] + db[1] * sb)
                        for corner in ((ea[0], eb[1]), (eb[0], ea[1])):
                            cands.append(_simplify([pa, ea, corner, eb, pb]))
                        for t in (0.5, 0.25, 0.75):
                            mx = _snap(ea[0] + (eb[0] - ea[0]) * t)
                            my = _snap(ea[1] + (eb[1] - ea[1]) * t)
                            cands.append(_simplify([pa, ea, (mx, ea[1]), (mx, eb[1]), eb, pb]))
                            cands.append(_simplify([pa, ea, (ea[0], my), (eb[0], my), eb, pb]))
                for path in cands:
                    if len(path) < 2 or any(abs(p[0] - q[0]) > 1e-3 and abs(p[1] - q[1]) > 1e-3 for p, q in zip(path, path[1:])):
                        continue
                    # a wire must leave a pin away from its symbol, not back through the body
                    if (path[1][0] - pa[0]) * da[0] + (path[1][1] - pa[1]) * da[1] < 1e-6 or (path[-2][0] - pb[0]) * db[0] + (path[-2][1] - pb[1]) * db[1] < 1e-6:
                        if not (len(path) == 2 and (path[1][0] - pa[0]) * da[0] + (path[1][1] - pa[1]) * da[1] > 1e-6):
                            continue
                    if self._blocked(path, g, (pa, pb)):
                        continue
                    cost = sum(abs(p[0] - q[0]) + abs(p[1] - q[1]) for p, q in zip(path, path[1:])) + 4 * len(path) + 40 * self._crossings(path, g) + 6 * (ja + jb)
                    if best is None or cost < best[0]:
                        best = (cost, path, [pt for pt, j in ((pa, ja), (pb, jb)) if j])
        return (best[1], best[2]) if best and best[0] < 400 else None

    def connect(self, *pins, net: str | None = None) -> str:
        """Connect pins to one another: a drawn wire where a clean one fits, net labels where it does not.

        Returns how each connection was made.  `net` names the net (a label is added).
        """
        specs = [self._pins(p)[0] for p in pins]
        if len(specs) < 2:
            raise HarnessError("connect needs at least two pins.")
        how = []
        for a, b in zip(specs, specs[1:]):
            self.flush()
            g = self.geometry()
            a, b = self.pin(f"{a['ref']}.{a['number']}"), self.pin(f"{b['ref']}.{b['number']}")
            if a["net"] and a["net"] == b["net"] and not a["net"].startswith(("Net-(", "unconnected-")):
                how.append("already")
                continue
            found = self._route(a, b, g)
            if found:
                self._edit({"op": "add_wire", "points": [list(p) for p in found[0]]})
                for j in found[1]:
                    self.junction(j)
                how.append("wire")
            else:
                name = net or next((p["net"] for p in (a, b) if p["net"] and not p["net"].startswith(("Net-(", "unconnected-"))), None) or self._new_net(a)
                self.label(a, name)
                self.label(b, name)
                how.append(f"labels {name}")
        if net:
            self.flush()
            if self.pin(f"{specs[0]['ref']}.{specs[0]['number']}")["net"] != net:
                self.label(specs[0], net, kind="label")      # a wired net gets its name as a plain wire label
        self.flush()
        return ", ".join(how)

    def _new_net(self, a: Pin) -> str:
        return f"{a['ref']}_{a['name'] or a['number']}".replace(" ", "_").replace("/", "_")

    def _stub(self, p: Pin, g, length=STUB):
        d = _DIR[p["side"]]
        end = (_r(p["x"] + d[0] * length), _r(p["y"] + d[1] * length))
        if self._blocked([p.at, end], g, (p.at,)):
            return None
        return end

    def label(self, pin, name: str, kind: str | None = None, shape: str | None = None) -> None:
        """Put a net's name on a pin, on a short stub away from the symbol.  `pin` may name several pins ("U1.GND").
        A stub that reaches one pin and carries on elsewhere by name gets a global label (a hierarchical one with
        kind="hierarchical_label" on a sub-sheet) whose shape says which way the signal goes, taken from the pin's
        type unless `shape` is given: a plain label (kind="label") is only for naming a wire that is drawn through."""
        kind = kind or "global_label"
        for p in self._pins(pin):
            self.flush()
            g = self.geometry()
            if any(_same(p.at, (l[1], l[2])) and l[0] == name for l in g["labels"]) or (p["net"] == name and not p.get("hidden")):
                continue
            end = self._stub(p, g)
            if end:
                self._edit({"op": "add_wire", "points": [list(p.at), list(end)]})
            at = end or p.at
            if kind == "label" and p["side"] in ("left", "right"):
                # the wire runs on under the whole name: the label sits on the wire's far end and lies back over it
                w = math.ceil((self._width(name) + 0.6) / 1.27) * 1.27
                far = (_r(at[0] + (w if p["side"] == "right" else -w)), at[1])
                if not self._blocked([at, far], g, (at,)):
                    self._edit({"op": "add_wire", "points": [list(at), list(far)]})
                    self._edit({"op": "add_label", "kind": kind, "text": name, "x": far[0], "y": far[1], "rotation": 180 if p["side"] == "right" else 0})
                    continue
            e = {"op": "add_label", "kind": kind, "text": name, "x": at[0], "y": at[1], "rotation": _LABEL_ROT[p["side"]]}
            if kind != "label":
                e["shape"] = shape or _SHAPE.get(p.get("type", ""), "passive")
            self._edit(e)

    def power(self, pin, name: str) -> None:
        """Put a power symbol (power:GND, power:+3V3, ...) on a pin.  `pin` may name several pins ("U1.GND")."""
        lib_id = name if ":" in name else "power:" + name
        short = lib_id.split(":", 1)[1]
        for p in self._pins(pin):
            self.flush()
            g = self.geometry()
            if p["net"] == short:
                continue
            # the symbol is never turned: a supply points up and a ground down, always, so the wire bends to it
            v = 1 if _GROUND.search(short) else -1
            d = _DIR[p["side"]]
            paths = []
            if d == (0, v):                                    # the pin already points the symbol's way
                paths.append([p.at, (p["x"], _r(p["y"] + v * STUB))])
            elif d[1] == 0:                                    # a pin on the side: out, then a short step up or down
                out = (_r(p["x"] + d[0] * STUB), p["y"])
                paths.append([p.at, out, (out[0], _r(p["y"] + v * GRID))])
            else:                                              # a pin that points the other way: away, aside, and back a step
                away = (p["x"], _r(p["y"] + d[1] * 2 * STUB))
                for side in (1, -1):
                    paths.append([p.at, away, (_r(p["x"] + side * STUB), away[1]), (_r(p["x"] + side * STUB), _r(away[1] + v * GRID))])
            path = next((q for q in paths if not self._blocked(q, g, (p.at,))), paths[0])
            self._edit({"op": "add_wire", "points": [list(q) for q in path]})
            self._is_power(short)
            self._edit(self._power_edit(lib_id, path[-1][0], path[-1][1], 0))

    def _is_power(self, name: str) -> bool:
        if name in self.project.custom_power:
            return True
        if not _POWER.match(name) and not (_SUPPLY.match(name) and not _NOT_SUPPLY.search(name)):
            return False
        try:
            return bool(self.lib("power:" + name).get("power_symbol", True))
        except HarnessError:
            self.supply(name)        # a supply KiCad's power library has no symbol for: one is made, as a person would
            return True

    def supply(self, name: str, volts=None, amps=None, source: str | None = None) -> str:
        """Declare a net a supply (or a ground) that KiCad's power library has no symbol for ("VSYS", "VDD_SPI", "GND_RF"):
        from then on it is drawn with a power symbol of its own, an arrow up for a supply and KiCad's ground mark for a
        ground, instead of a net label.  `net`, `power` and `build` do this by themselves for names that read as supplies.
        With volts=(min, typ, max) and amps=(min, typ, max) the rail's range and load are also written on the sheet
        ("VUSB = (4.5, 5, 5.5) V @ (, 35, 500) mA"), which every supply should have; `supplies({...})` writes several at once."""
        if volts is not None or amps is not None:
            if not _POWER.match(name) and name not in self.project.custom_power:
                self.supply(name)
            self.supplies({name: {"volts": volts, "amps": amps, "from": source}})
            return name
        if name not in self.project.custom_power:
            ground = bool(_GROUND.search(name))
            self.project.custom_power[name] = _power_symbol(name, ground)
            self._facts["power:" + name] = {"lib_id": "power:" + name, "power_symbol": True, "reference_prefix": "#PWR", "value": name,
                                            "units": [{"unit": 1, "body_box": [-1.27, 0, 1.27, 2.54] if ground else [-0.762, -2.54, 0.762, 0],
                                                       "pins": [{"number": "1", "name": "~", "type": "power_in", "dx": 0, "dy": 0}]}]}
        return name

    def _power_edit(self, name: str, x, y, rotation=0) -> dict:
        """The edit that places a power symbol, carrying the symbol's drawing when it is one of our own."""
        short = name.split(":", 1)[-1]
        e = {"op": "add_symbol", "lib_id": name if ":" in name else "power:" + name, "x": x, "y": y, "rotation": rotation}
        if short in self.project.custom_power:
            e["symbol"] = self.project.custom_power[short]
        return e

    def net(self, name: str, *pins) -> None:
        """Put pins on a named net: a power symbol when KiCad has one of that name (GND, +3V3, VBUS), else a label."""
        power = self._is_power(name)
        for spec in pins:
            (self.power if power else self.label)(spec, name)

    def attach(self, pin, lib, value: str | None = None, footprint: str | None = None, ref: str | None = None,
               to: str | None = None, part_pin: str = "1", gap: float = 2 * STUB, fields: dict | None = None) -> str:
        """Place a two-pin part in line with a pin and wire it on, the way a series resistor or a decoupling
        capacitor is drawn.  `to` names the net of the part's far pin (a power symbol or a label).  Returns the reference.
        """
        p = self._pins(pin)[0]
        facts = self.lib(lib)
        lp = facts["units"][0]["pins"]
        mine = next((q for q in lp if q["number"] == str(part_pin)), lp[0])
        other = next((q for q in lp if q is not mine), mine)
        d = _DIR[p["side"]]
        rot = 0
        for r in (0, 90, 180, 270):
            ox, oy = _rot(other["dx"] - mine["dx"], other["dy"] - mine["dy"], r)
            if ox * d[0] + oy * d[1] > 0.5 * math.hypot(ox, oy):
                rot = r
                break
        mx, my = _rot(mine["dx"], mine["dy"], rot)
        start = (p["x"] + d[0] * gap, p["y"] + d[1] * gap)
        at = (_r(start[0] - mx), _r(start[1] - my))
        new = self.place(lib, at=at, ref=ref, value=value, footprint=footprint, rotation=rot, fields=fields)
        self.flush()
        g = self.geometry()
        q = self.pin(f"{new}.{mine['number']}")
        if not self._blocked([p.at, q.at], g, (p.at, q.at)) and (_same(p.at, q.at) is False):
            self._edit({"op": "add_wire", "points": [list(p.at), list(q.at)]})
        else:
            self.connect(p, q)
        if to and other is not mine:
            self.net(to, f"{new}.{other['number']}")
        self.flush()
        return new

    def decouple(self, pin, value: str = "100nF", gnd: str = "GND", footprint: str = "Capacitor_SMD:C_0402_1005Metric", lib: str = "Device:C") -> list:
        """A decoupling capacitor for each supply pin named: one side on the pin's net, the other on ground.
        The capacitors go in a free row of the sheet with power symbols or labels, not on the pin's own wire.
        """
        out = []
        for p in self._pins(pin):
            name = p["net"]
            if not name or name.startswith(("Net-(", "unconnected-")):
                raise HarnessError(f"{p['ref']}.{p['number']} is not on a named net yet; put it on its supply first (net or power).")
            c = self.place(lib, value=value, footprint=footprint)
            self.net(name, f"{c}.1")
            self.net(gnd, f"{c}.2")
            out.append(c)
        self.flush()
        return out

    # ---- how the sheet reads: overlaps, frames, notes
    def layout(self, within=None, of=None, wrap=None, limit: int = 40) -> dict:
        """The sheet's layout check: overlaps (what, a, b, x, y), counts by kind, the extent of what is drawn
        (or of the items inside `within`, or of the parts `of` with what hangs on their pins), the usable drawing
        area and the title block.  `wrap` breaks notes into lines: [{"text", "size", "width"}]."""
        args: dict = {"limit": limit}
        if within:
            args["within"] = [_r(v) for v in within]
        if of:
            args["of"] = list(of)
        if wrap:
            args["wrap"] = wrap
        return self._call("check_layout", **args)

    def sections(self) -> list:
        """The framed sections on the sheet: [{"title", "box", "parts"}], top to bottom."""
        self.flush()
        return self.layout(limit=1).get("sections", [])

    def overlaps(self, limit: int = 40) -> list:
        """Everything drawn on top of something else, or off the page, as short lines.  An empty list is a clean sheet."""
        r = self.layout(limit=limit)
        out = [f"{o['what']}: {o['a']} / {o['b']} at ({o['x']}, {o['y']})" for o in r.get("overlaps", [])]
        out += [f"wire crosses its own net without a junction: {n} at ({x}, {y})" for n, x, y in self.crossings()]
        if r.get("count", 0) > len(out):
            out.append(f"... and {r['count'] - len(out)} more")
        return out

    def crossings(self) -> list:
        """Places where two wires of the same net cross with no junction: [(net, x, y), ...].  Such a crossing reads as
        unconnected although the names join the two, so it must not stay: `build` puts a junction on each."""
        self.flush()
        self._geom = None
        g = self.geometry()
        segs = [tuple(w) for w in g.get("wires", [])]
        dots = {(round(j[0], 2), round(j[1], 2)) for j in g.get("junctions", [])}
        on = lambda p, s: (abs(s[0] - s[2]) < 1e-6 and abs(p[0] - s[0]) < 1e-6 and min(s[1], s[3]) - 1e-6 <= p[1] <= max(s[1], s[3]) + 1e-6) or \
                          (abs(s[1] - s[3]) < 1e-6 and abs(p[1] - s[1]) < 1e-6 and min(s[0], s[2]) - 1e-6 <= p[0] <= max(s[0], s[2]) + 1e-6)
        inside = lambda p, s: on(p, s) and min(abs(p[0] - s[0]) + abs(p[1] - s[1]), abs(p[0] - s[2]) + abs(p[1] - s[3])) > 1e-6
        parent = list(range(len(segs)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        for i, a in enumerate(segs):
            for j in range(i + 1, len(segs)):
                b = segs[j]
                ends = [(a[0], a[1]), (a[2], a[3])], [(b[0], b[1]), (b[2], b[3])]
                if any(on(p, b) for p in ends[0]) or any(on(p, a) for p in ends[1]):
                    parent[find(i)] = find(j)
        named: dict = {}
        marks = [((p[3], p[4]), p[6]) for part in g.get("parts", []) for p in part.get("pins", []) if p[6]] + [((l[1], l[2]), l[0]) for l in g.get("labels", [])]
        for at, net in marks:
            for i, sg in enumerate(segs):
                if on(at, sg):
                    named.setdefault(find(i), net.lstrip("/"))
        out = []
        for i, a in enumerate(segs):
            for j in range(i + 1, len(segs)):
                b = segs[j]
                h, v = (a, b) if abs(a[1] - a[3]) < 1e-6 else (b, a)
                if not (abs(h[1] - h[3]) < 1e-6 and abs(v[0] - v[2]) < 1e-6):
                    continue
                p = (v[0], h[1])
                if not (inside(p, h) and inside(p, v)) or (round(p[0], 2), round(p[1], 2)) in dots:
                    continue
                na, nb = named.get(find(i)), named.get(find(j))
                if na and na == nb:
                    out.append((na, p[0], p[1]))
        return sorted(set(out))

    def autoplace_fields(self, *refs: str) -> None:
        """KiCad's Autoplace Fields for these parts (all parts without arguments): reference and value beside the body, clear of what is around."""
        self.flush()
        self._edit({"op": "autoplace_fields", **({"refs": list(refs)} if refs else {})})
        self.flush()
        self._edit({"op": "clear_fields", **({"refs": list(refs)} if refs else {})})   # a value that landed on a pin's label
        self.flush()

    def tidy(self) -> dict:
        """Move any reference or value that is drawn over something to the nearest clear spot, then report what still overlaps:
        {"overlaps": n, "by_kind": {...}, "first": [...]}.  Fields that are already clear stay where they are, so a sheet drawn
        by build() keeps its look; autoplace_fields() is the call that puts every field back beside its part."""
        self.flush()
        self._edit({"op": "clear_fields", "power": True})      # a supply symbol's name over a wire or another name moves too
        self.flush()
        r = self.layout(limit=12)
        return {"overlaps": r.get("count", 0), "by_kind": r.get("by_kind", {}), "first": [f"{o['what']}: {o['a']} / {o['b']} at ({o['x']}, {o['y']})" for o in r.get("overlaps", [])]}

    def page(self, paper: str, width: float | None = None, height: float | None = None) -> None:
        """Set the page size: "A3", "A2", "A1", "A0" (or the US sizes), or page("User", width, height) in millimetres."""
        e = {"op": "set_page", "paper": paper}
        if paper == "User":
            e.update(width=round(float(width), 2), height=round(float(height), 2))
        self._edit(e)
        self.flush()

    def _trim_page(self, out: dict, size, least, margin: float) -> dict:
        """A drawing that needs more than the smallest paper but leaves a good part of the next standard size empty gets a
        page of its own size: as wide and as high as the drawing, its margins and the title block under it need."""
        ext = self.layout(limit=1).get("extent")
        edge = 12.7 + margin
        w = max(least[1], math.ceil((ext[2] - ext[0] + 2 * edge) / 10) * 10)
        h = max(least[2], math.ceil((ext[3] - ext[1] + 2 * edge + 49.0 + margin) / 10) * 10)   # the title block stands under the drawing
        if w > size[0] or h > size[1] or w * h > 0.85 * size[0] * size[1]:
            return out
        dx = round(((w - (ext[2] - ext[0])) / 2 - ext[0]) / GRID) * GRID
        dy = round((edge - ext[1]) / GRID) * GRID
        box = {"x0": ext[0] - 0.5, "y0": ext[1] - 0.5, "x1": ext[2] + 0.5, "y1": ext[3] + 0.5}
        if dx or dy:
            self._edit({"op": "move_region", **box, "dx": dx, "dy": dy})
            self.flush()
        self.page("User", w, h)
        lay = self.layout(limit=1)
        if any(k in ("outside the page border", "over the title block") for k in (lay.get("by_kind") or {})):
            self.page(out["paper"])      # it does not sit right on the trimmed page: back to the standard one
            if dx or dy:
                self._edit({"op": "move_region", "x0": box["x0"] + dx, "y0": box["y0"] + dy, "x1": box["x1"] + dx, "y1": box["y1"] + dy, "dx": -dx, "dy": -dy})
                self.flush()
            return out
        return dict(out, paper="User", size=[w, h], moved=[round(out["moved"][0] + dx, 2), round(out["moved"][1] + dy, 2)])

    def fit_page(self, margin: float = 2.54, papers: tuple | None = None, custom: bool = True) -> dict:
        """Make the page fit what is drawn: the smallest paper ("A3", "A2", "A1", "A0", or the ones named in `papers`)
        that holds everything with `margin` to the border and clear of the title block, and the drawing moved as one piece
        to the middle of it.  A drawing too big for the smallest paper that would leave much of the next size empty gets a
        page of its own size ("User", with "size": [w, h]) unless custom=False.
        Returns {"paper", "was", "moved": [dx, dy], "fits"}; an empty sheet goes back to A3."""
        self.flush()
        r = self.layout(limit=1)
        was, ext = r.get("paper", "A4"), r.get("extent")
        sizes = [p for p in _PAPERS if not papers or p[0] in papers] or list(_PAPERS)
        now = was

        def paper(name):
            nonlocal now
            if name != now:
                self.page(name, *((r.get("page") or [420, 297])[:2] if name == "User" else ()))
                now = name

        if not ext:
            paper(sizes[0][0])
            return {"paper": now, "was": was, "moved": [0, 0], "fits": True}
        w, h = ext[2] - ext[0], ext[3] - ext[1]
        edge = 12.7 + margin   # the frame's border, then the margin
        off = lambda: sum(n for k, n in (self.layout(limit=1).get("by_kind") or {}).items() if k in ("outside the page border", "over the title block"))
        for name, pw, ph in sizes:
            if w > pw - 2 * edge or h > ph - 2 * edge:
                continue
            tx, ty = pw - 125.0 - margin, ph - 49.0 - margin   # the title block's corner
            # in the middle of the drawing area (a drawing that steps around the title block may sit there), else in the
            # middle of the room above the title block, else of the room to its left
            for x1, y1 in ((pw - edge, ph - edge), (pw - edge, ty), (tx, ph - edge)):
                if w > x1 - edge or h > y1 - edge:
                    continue
                dx = round(((edge + x1 - w) / 2 - ext[0]) / GRID) * GRID   # parts and wires stay on the grid
                dy = round(((edge + y1 - h) / 2 - ext[1]) / GRID) * GRID
                paper(name)
                box = {"x0": ext[0] - 0.5, "y0": ext[1] - 0.5, "x1": ext[2] + 0.5, "y1": ext[3] + 0.5}
                if dx or dy:
                    self._edit({"op": "move_region", **box, "dx": dx, "dy": dy})
                    self.flush()
                if not off():
                    out = {"paper": name, "was": was, "moved": [round(dx, 2), round(dy, 2)], "fits": True}
                    return self._trim_page(out, (pw, ph), sizes[0], margin) if custom and name != sizes[0][0] else out
                if dx or dy:   # it sits on the title block or the border there: back, and try the next place
                    self._edit({"op": "move_region", "x0": box["x0"] + dx, "y0": box["y0"] + dy, "x1": box["x1"] + dx, "y1": box["y1"] + dy, "dx": -dx, "dy": -dy})
                    self.flush()
        paper(was)
        self.project.note(f"{self.path}: the drawing ({round(w)} x {round(h)} mm) does not fit on {sizes[-1][0]}; split it over several sheets.")
        return {"paper": was, "was": was, "moved": [0, 0], "fits": False}

    def title(self, title: str | None = None, rev: str | None = None, date: str | None = None, company: str | None = None) -> None:
        """Fill in the sheet's title block (File, Page Settings): title, revision, date, company.  Lines not given stay as
        they are, except the date, which is set to today whenever the title or the revision is."""
        if date is None and (title is not None or rev is not None):
            import datetime
            date = datetime.date.today().isoformat()     # a title or a revision without a date is half a title block
        e = {k: v for k, v in (("title", title), ("rev", rev), ("date", date), ("company", company)) if v is not None}
        if e:
            self.flush()
            self._edit({"op": "set_page", **e})
            self.flush()

    def frame(self, box, title: str | None = None, notes=None, style: str = "dash") -> list:
        """Draw a frame with a heading inside its top left corner and notes along its bottom.  `box` is [x0, y0, x1, y1]
        around the content; the frame is drawn with room for the heading above and the notes below.  Returns the frame's box."""
        lines = self._note_lines(notes, max(box[2] - box[0], 60.0) - 2 * _PAD)
        tw = self.layout(wrap=[{"text": title, "size": _TITLE, "width": 1e6}])["wrapped"][0]["width"] if title else 0
        nw = max([w for _, w in lines] + [0])
        x0, y0 = box[0] - _PAD, box[1] - _PAD - (_HEAD if title else 0)
        x1 = max(box[2] + _PAD, x0 + tw * 1.08 + 2 * _PAD, x0 + nw + 2 * _PAD)
        y1 = box[3] + _PAD + (len(lines) * _LINE + _PAD if lines else 0)
        self._edit({"op": "add_rectangle", "x0": _r(x0), "y0": _r(y0), "x1": _r(x1), "y1": _r(y1), "style": style})
        if title:
            self.text(title, (x0 + _PAD / 2 + 0.6, y0 + _HEAD - 1.4), size=_TITLE, bold=True)
        y = box[3] + _PAD + _LINE
        for line, _ in lines:
            self.text(line, (x0 + _PAD, y), italic=True)
            y += _LINE
        self.flush()
        return [_r(x0), _r(y0), _r(x1), _r(y1)]

    def _note_lines(self, notes, width: float) -> list:
        notes = [notes] if isinstance(notes, str) else list(notes or [])
        if not notes:
            return []
        got = self.layout(wrap=[{"text": ("" if n.lower().startswith("note") else "Note: ") + n, "size": 1.27, "width": width} for n in notes])["wrapped"]
        out = []
        for w in got:
            for i, line in enumerate(w["lines"]):
                out.append((line if i == 0 else "  " + line, w["width"] + (1.5 if i else 0)))
        return out

    def section(self, title: str, refs: list, notes=None) -> list:
        """Frame the parts of one functional block, with a heading and optional notes that say why something is unusual.
        The frame goes around the parts and everything on their pins (stubs, labels, power symbols).  Returns the frame's box;
        run overlaps() afterwards, since a frame drawn around parts that sit among others can cut through a neighbour."""
        self.flush()
        ext = self.layout(of=refs).get("extent")
        if not ext:
            raise HarnessError("None of those parts is on the sheet: " + ", ".join(refs))
        return self.frame(ext, title, notes)

    def note(self, text: str, near: str | None = None, at=None, width: float = 60.0) -> list:
        """A note on the sheet, for a design choice somebody reading it would not expect.  With `near` (a reference) it is put
        in the closest free space beside that part; with `at` exactly there (top left).  Returns where it went."""
        self.flush()
        lines = self._note_lines(text, width)
        w, h = max(x for _, x in lines) + 1.0, len(lines) * _LINE + 0.6
        if at is None:
            spot = self._call("check_layout", limit=1, free={"near": near, "w": _r(w), "h": _r(h)} if near else {"w": _r(w), "h": _r(h)}).get("free")
            if not spot:
                raise HarnessError("There is no free space for that note on the page; make the page larger with page(\"A3\") or give at=(x, y).")
            at = (spot["x"], spot["y"])
        y = at[1] + _LINE - 0.4
        for line, _ in lines:
            self.text(line, (at[0] + 0.5, y), italic=True)
            y += _LINE
        self.flush()
        return [_r(at[0]), _r(at[1])]

    # ---- room: how much space a part takes once its pins carry stubs, labels and power symbols
    def _width(self, *names) -> float:
        """The drawn width of these texts at the default size (the widest of them)."""
        tws = self.__dict__.setdefault("_tws", {})
        missing = [n for n in dict.fromkeys(names) if n and n not in tws]
        if missing:
            got = self.layout(wrap=[{"text": n, "size": 1.27, "width": 1e6} for n in missing], limit=1)["wrapped"]
            for n, w in zip(missing, got):
                tws[n] = w["width"]
        return max([tws[n] for n in names if n] + [0.0])

    def _lib_pins(self, lib, rotation=0):
        """A library part's body box and pins at this rotation, relative to the symbol's position: (box, [(number, name, x, y, side)])."""
        try:
            unit = self.lib(lib)["units"][0] if lib is not None and not isinstance(lib, dict) else None
        except HarnessError:
            unit = None
        b0 = (unit or {}).get("body_box") or [-5.08, -5.08, 5.08, 5.08]
        cs = [_rot(x, y, rotation) for x in (b0[0], b0[2]) for y in (b0[1], b0[3])]
        box = [min(c[0] for c in cs), min(c[1] for c in cs), max(c[0] for c in cs), max(c[1] for c in cs)]
        pins = []
        for q in (unit or {}).get("pins", []):
            x, y = _rot(q["dx"], q["dy"], rotation)
            d = {"left": x - box[0], "right": box[2] - x, "top": y - box[1], "bottom": box[3] - y}
            pins.append((q["number"], q.get("name", ""), x, y, min(d, key=d.get)))
        return box, pins

    def _room(self, ref, spec, intent) -> list:
        """The box a part will take, relative to its position: body, stubs, labels, power symbols and its own fields."""
        lib = spec.get("lib")
        box, pins = self._lib_pins(lib, spec.get("rotation", 0))
        out = [box[0] - 1.27, box[1] - 1.27, box[2] + 1.27, box[3] + 1.27]
        sides = set()
        for number, _, x, y, side in pins:
            name = intent.get((ref, number))
            if not name:
                continue
            sides.add(side)
            w = self._width(name)
            if self._is_power(name):
                along, across = (STUB + 5.5 + w + 1.5, 2.3) if side in ("left", "right") else (STUB + 7.0, max(2.8, w / 2 + 0.6))
            else:
                along, across = STUB + w + 2.0, 2.0
            dx, dy = _DIR[side]
            ex, ey = x + dx * along, y + dy * along
            out = [min(out[0], ex, x - (across if dy else 0)), min(out[1], ey, y - (across if dx else 0)),
                   max(out[2], ex, x + (across if dy else 0)), max(out[3], ey, y + (across if dx else 0))]
        fw = self._width(ref, str(spec.get("value") or "")) + 2.0
        if "right" not in sides:
            out[2] = max(out[2], box[2] + fw)
        elif "top" not in sides:
            out[1] = min(out[1], box[1] - 5.6)
            out[0], out[2] = min(out[0], -fw / 2), max(out[2], fw / 2)
        elif "bottom" not in sides:
            out[3] = max(out[3], box[3] + 5.6)
            out[0], out[2] = min(out[0], -fw / 2), max(out[2], fw / 2)
        else:
            out[1], out[3] = out[1] - 5.6, out[3] + 5.6
        return out

    def _intent(self, parts, nets) -> dict:
        """(ref, pin number) -> net name, from a netlist written by pin number or pin name."""
        out = {}
        cache = {}
        for name, specs in nets.items():
            for spec in specs:
                ref, _, which = str(spec).partition(".")
                p = parts.get(ref)
                if p is None:
                    continue
                lib = p.get("lib") if isinstance(p, dict) else p
                if ref not in cache:
                    try:
                        cache[ref] = self._lib_pins(lib)[1] if not isinstance(lib, dict) else []
                    except HarnessError:
                        cache[ref] = []
                bare = lambda n: re.sub(r"~\{(.*?)\}", r"\1", n).lower()
                pins = cache[ref]
                hit = [q for q in pins if q[0] == which] or [q for q in pins if q[1].lower() == which.lower()] or [q for q in pins if bare(q[1]) == bare(which)]
                for q in hit or [(which,)]:
                    out[(ref, q[0])] = name
        return out

    # ---- a whole sheet from a netlist
    def build(self, parts: dict, nets: dict, groups: dict | None = None, no_connect: list | None = None,
              notes: dict | None = None, frames: bool = True, labels: list | None = None, swap_pins: bool = True,
              supplies: dict | None = None, global_labels: bool = True, review: bool = True) -> dict:
        """Draw a schematic from a netlist in one call.

        parts: {ref: {"lib": "Device:R", "value": "10k", "footprint": "...", "fields": {...}}} (lib may be a
        generated part or a vendor part).  nets: {name: ["U1.3", "R1.1", ...]}.  groups: {"Block title": [refs]} is
        the sheet's organisation: each group is drawn as a framed section with its title, ICs at the left and their
        passives beside them.  notes: {"Block title": "why ..." or [..]} puts notes in that section; write one wherever
        a choice is not the standard one (an unusual value, a part left out, a pin tied off) so a reader knows why.
        Every pin gets a power symbol or a net label on a short stub, so the result is correct by construction.
        A sheet that already holds a design is redrawn (do not call clear() first): run again, items that come out
        identical are not touched in the live document.

        Blocks are drawn off the page, measured as drawn (fields, labels and all), and then packed onto the page, so
        nothing overlaps; the page starts at A3 (11 x 17 in) and grows when the design needs it.  Labels that leave a block are
        global labels with a direction shape (global_labels=False keeps plain ones); supplies={name: {"volts": (min, typ, max),
        "amps": (min, typ, max)}} writes the supply list on the sheet; "review" in the result is what the house checklist
        (sch.review()) still finds, so fix that before reporting the sheet done (review=False skips it).  Returns counts, anything that did
        not connect, and "overlaps": what the layout check still finds (0 for a clean sheet).
        """
        if set(parts) & set(self.refs()):      # these parts are on the sheet already: it is the same design run again, so the
            self.clear()                       # sheet is redrawn, and what comes out identical is left alone when the plan is drawn
        named = bool(groups)
        groups = dict(groups or {"main": list(parts)})
        seen = {r for rs in groups.values() for r in rs}
        rest = [r for r in parts if r not in seen]
        if rest:
            groups["Other"] = rest
        notes = dict(notes or {})
        # a crystal is a small block of its own (with its load capacitors and series resistor) inside its chip's frame,
        # under the decoupling capacitors, joined to the chip by the net names: wired to the chip its two wires loop
        # round everything else there
        split: dict = {}
        if named:
            pins_of: dict = {}
            for net, pins in nets.items():
                for pin in pins:
                    pins_of.setdefault(str(pin).partition(".")[0], []).append(net)
            for g, rs in groups.items():
                keep = list(rs)
                for y in list(rs):
                    lib = parts[y].get("lib") if isinstance(parts.get(y), dict) else parts.get(y)
                    if not (re.match(r"^(Y|XTAL)\d", y, re.I) or (isinstance(lib, str) and re.search(r"crystal|resonator", lib, re.I))) or len(keep) < 2:
                        continue
                    if not any(len(pins_of.get(r, [])) > 4 for r in keep if r != y):      # only out of a block that holds a chip
                        continue
                    ynets = {n for n in pins_of.get(y, []) if not _GROUND.search(n)}
                    mine = [y] + [r for r in keep if r != y and re.match(r"^(C|R)\d", r, re.I) and len(pins_of.get(r, [])) == 2 and any(n in ynets for n in pins_of[r])
                                  and all(n in ynets or _GROUND.search(n) or len(nets.get(n, [])) <= 3 for n in pins_of[r])]
                    keep = [r for r in keep if r not in mine]
                    val = str(parts[y].get("value") or "") if isinstance(parts.get(y), dict) else ""
                    split.setdefault(g, []).append((f"{val} crystal" if val else "Crystal", mine))
                groups[g] = keep
        for r, spec in parts.items():   # a note given with a part belongs to its block
            if isinstance(spec, dict) and spec.get("note"):
                g = next((n for n, rs in groups.items() if r in rs), None)
                if g:
                    notes[g] = ([notes[g]] if isinstance(notes.get(g), str) else list(notes.get(g) or [])) + [f"{r}: {spec['note']}"]
        self.flush()
        before = self.layout(limit=1)
        # ---- 1. every block off the page, drawn the way a datasheet draws its application circuit: wires inside the
        #         block, parts hanging on and in line with the wires of the IC pins, labels only where a net leaves it
        from .sheet import Blocks
        intent = self._intent(parts, nets)
        drawer = Blocks(self, parts, nets, groups, intent, _GROUND, arrange_pins=swap_pins)
        drawer.force |= set(labels or [])
        drawer.subs = split
        for subs in split.values():
            for name, mine in subs:
                for r in mine:
                    drawer.gof[r] = name
        drawer.global_labels = bool(global_labels)      # a name at a wire end becomes a global label: a box centred on the wire, with a point
        for (ref, num), name in intent.items():      # a net wired inside its block has no label: remember it by one of its pins
            self.project.net_pins.setdefault(name, f"{ref}.{num}")
        bands, placed, problems = drawer.run()
        # ---- 2. no-connect flags
        for spec in no_connect or []:
            try:
                self.no_connect(spec)
            except HarnessError as e:
                problems.append(str(e))
        self.flush()
        self._repair(nets)
        self._join_labels(nets, groups, set(labels or []))
        for _n, x, y in self.crossings():      # a wire that crosses its own net is joined to it there, so the drawing says what the netlist says
            self.junction((x, y))
        self.flush()
        if global_labels:      # a name at the end of a wire sends the net elsewhere: it is a global label with a direction, not text
            self.globalize()
        # ---- 3. measure each block as drawn, and what its heading and notes need
        blocks = []
        for gname, band in bands:
            ext = self.layout(within=band, limit=1).get("extent")
            if not ext:
                continue
            title = gname if named or gname == "Other" and len(groups) > 1 else None
            lines = self._note_lines(notes.get(gname), max(ext[2] - ext[0], 60.0) - _PAD) if frames else []
            tw = self.layout(wrap=[{"text": title, "size": _TITLE, "width": 1e6}], limit=1)["wrapped"][0]["width"] * 1.08 if title and frames else 0
            framed = frames and (title or lines)
            pad = _PAD if framed else 0
            w = max(ext[2] - ext[0] + 2 * pad, tw + 2 * pad + 1.2, max([lw for _, lw in lines] + [0]) + 2 * pad)
            h = ext[3] - ext[1] + 2 * pad + (_HEAD if title and frames else 0) + (len(lines) * _LINE + pad if lines else 0)
            blocks.append({"name": gname, "band": band, "ext": ext, "title": title if frames else None, "lines": lines, "w": w, "h": h, "framed": framed})
        # ---- 4. the smallest page they fit on, packed in rows in the order given
        used = before.get("extent")
        top = (used[3] + 7.62) if used else None
        # a sheet that was empty takes the smallest page the design fits on; one with drawing on it never shrinks
        papers = ([p for p in _PAPERS if p[1] >= (before.get("page") or [297, 210])[0] - 1] if used else list(_PAPERS)) or [_PAPERS[-1]]
        spots, paper = None, papers[-1]
        orders = [blocks, sorted(blocks, key=lambda b: -b["h"]), sorted(blocks, key=lambda b: -b["w"] * b["h"]), sorted(blocks, key=lambda b: -b["w"])]
        rng = random.Random(1)      # then a fixed set of other orders: packing is cheap, a page size too large is half an empty sheet
        for _ in range(400):
            o = list(blocks)
            rng.shuffle(o)
            orders.append(o)
        for cand in papers:   # the order given when it fits; tallest or largest first when that saves a page size
            for order in orders:
                spots = self._pack(order, cand, top)
                if spots:
                    blocks, paper = order, cand
                    break
            if spots:
                break
        if not spots:
            spots = self._pack(blocks, paper, top, force=True)
            problems.append(f"The sheet does not fit on {paper[0]}; split it over several sheets.")
        if paper[0] != before.get("paper", "A4") and abs(paper[1] - (before.get("page") or [297, 210])[0]) > 1:
            self.page(paper[0])
        # ---- 5. move each block into place, then its frame, heading and notes
        for blk, (bx, by) in zip(blocks, spots):
            pad = _PAD if blk["framed"] else 0
            cx, cy = bx + pad, by + pad + (_HEAD if blk["title"] else 0)
            dx, dy = _snap(cx - blk["ext"][0], 2.54), _snap(cy - blk["ext"][1], 2.54)
            if dx < cx - blk["ext"][0]:
                dx += 2.54
            if dy < cy - blk["ext"][1]:
                dy += 2.54
            self._edit({"op": "move_region", "x0": blk["band"][0], "y0": blk["band"][1], "x1": blk["band"][2], "y1": blk["band"][3], "dx": dx, "dy": dy})
            self.flush()
            if not blk["framed"]:
                continue
            x0, y0 = blk["ext"][0] + dx - pad, blk["ext"][1] + dy - pad - (_HEAD if blk["title"] else 0)
            self._edit({"op": "add_rectangle", "x0": _r(x0), "y0": _r(y0), "x1": _r(x0 + blk["w"]), "y1": _r(y0 + blk["h"]), "style": "dash"})
            if blk["title"]:
                self.text(blk["title"], (x0 + _PAD / 2 + 0.6, y0 + _HEAD - 1.4), size=_TITLE, bold=True)
            ny = blk["ext"][3] + dy + pad + _LINE
            for line, _ in blk["lines"]:
                self.text(line, (x0 + pad, ny), italic=True)
                ny += _LINE
            self.flush()
        if supplies:
            try:
                self.supplies(supplies)
            except HarnessError as e:
                problems.append(str(e))
        self._remember_names(nets)
        if hasattr(self, "power_flags"):      # a supply fed through a connector gets its PWR_FLAG, so the ERC stays quiet about it
            try:
                self.power_flags()
            except HarnessError as e:
                problems.append(str(e))
        # ---- 6. the page fits the drawing: the smallest paper it sits on (a sheet that had something on it was packed
        #         onto the page it had), and the drawing in the middle of it instead of up in a corner
        fit = self.fit_page()
        if fit["fits"]:
            paper = next((p for p in _PAPERS if p[0] == fit["paper"]), paper)
        # ---- 7. the last look before anyone sees it: any name still drawn over a wire, a part or another name moves to
        #         the nearest clear spot (supply symbols' names included), so the sheet is drawn without overlaps
        if self.layout(limit=1).get("count"):
            self._edit({"op": "clear_fields", "power": True})
            self.flush()
        # ---- 8. what was asked for against what is there
        wrong = self._miswired(nets)
        lay = self.layout(limit=8)
        out = {"placed": len(placed), "nets": len(nets), "sections": len([b for b in blocks if b["framed"]]), "page": paper[0],
               "problems": problems + wrong, "unconnected": self.unconnected()[:40], "overlaps": lay.get("count", 0)}
        if drawer.swapped:
            out["pins_swapped"] = drawer.swapped      # symbols redrawn with supply straps on top and ground straps at the bottom of their side
        if review:      # the house checklist, so what is missing is known before anyone looks at the sheet
            try:
                rv = self.review(level="warning", limit=14)
                out["review"] = {"errors": rv["errors"], "warnings": rv["warnings"], "findings": [f if len(f) < 420 else f[:417] + "..." for f in rv["findings"]]}
            except HarnessError:
                pass
        if lay.get("count"):
            out["overlap_list"] = [f"{o['what']}: {o['a']} / {o['b']} at ({o['x']}, {o['y']})" for o in lay.get("overlaps", [])]
        self.project.note(f"{self.path}: built {len(placed)} parts and {len(nets)} nets in {out['sections']} sections on {paper[0]}"
                          + (f", {len(out['problems'])} problems" if out["problems"] else "") + (f", {out['overlaps']} overlaps" if out["overlaps"] else ""))
        return out

    def _miswired(self, nets: dict) -> list:
        """Nets whose pins are not all joined to each other and to nothing else.  A net wired inside its block has no
        label, so this compares who is connected to whom, not names."""
        got = self.nets()
        where = {pin: name for name, pins in got.items() for pin in pins}
        mine = {f"{q['ref']}.{q['number']}": name for name, pins in nets.items() for spec in pins for q in self._try_pins(spec)}
        out = []
        for name, pins in nets.items():
            want = {f"{q['ref']}.{q['number']}" for spec in pins for q in self._try_pins(spec)}
            homes = {where.get(pin) for pin in want}
            if len(homes) != 1 or None in homes:
                out.append(f"{name}: not all joined ({', '.join(sorted(want))})")
                continue
            extra = {pin for pin in got[next(iter(homes))] if mine.get(pin, name) != name}
            if extra:
                out.append(f"{name}: also joined to {', '.join(sorted(extra))}")
        return out

    def _remember_names(self, nets: dict) -> None:
        """A net wired without a label has no name on the sheet (KiCad calls it after a pin).  The name the script gave it
        is kept in a hidden field of one of its parts ("Net names": "7=DISCH 2=THRES"), so a later script, or the board,
        can still ask for the net by that name."""
        drawn = set(self.nets())
        by_ref: dict = {}
        for name in nets:
            pin = self.project.net_pins.get(name)
            if not pin or name in drawn or "/" + name in drawn:
                continue
            ref, _, num = pin.partition(".")
            by_ref.setdefault(ref, []).append(f"{num}={name}")
        have = {c["ref"]: c.get("net_names", "") for c in self._call("list_components").get("components", [])}
        for ref, pairs in by_ref.items():
            value = " ".join(sorted(pairs))
            if ref in have and have[ref] != value:
                self._edit({"op": "set_field", "ref": ref, "field": "Net names", "value": value})
        for ref, old in have.items():      # a part whose nets all carry labels now
            if old and ref not in by_ref:
                self._edit({"op": "set_field", "ref": ref, "field": "Net names", "value": ""})
        self.flush()

    def _join_labels(self, nets: dict, groups: dict, keep: set) -> int:
        """A net that stays inside its block and ended up as two names facing each other along a clear straight line is one
        wire instead: names are for nets that leave the block.  Returns how many nets were joined."""
        home = {r: g for g, refs in (groups or {}).items() for r in refs}
        joined = 0
        for name, pins in nets.items():
            refs = {q["ref"] for spec in pins for q in self._try_pins(spec)}
            if name in keep or len({home.get(r, "") for r in refs}) != 1:
                continue
            g = self.geometry()
            labs = [l for l in g["labels"] if l[0] == name]
            if len(labs) != 2:
                continue
            ends, gone = [], []
            for l in labs:
                at = (l[1], l[2])
                on = [w for w in g["wires"] if _same((w[0], w[1]), at) or _same((w[2], w[3]), at)]
                if len(on) == 1:      # the wire that runs under the name: the net is at its other end
                    w = on[0]
                    ends.append((w[2], w[3]) if _same((w[0], w[1]), at) else (w[0], w[1]))
                    gone.append(w)
                else:
                    ends.append(at)
            a, b = ends
            if _same(a, b):
                continue
            rest = dict(g, wires=[w for w in g["wires"] if w not in gone], labels=[l for l in g["labels"] if l[0] != name])
            path = next((p for p in self._ways(a, b) if not self._blocked(p, rest, (a, b))
                         and not any(self._through_part([u, v], rest) for u, v in zip(p, p[1:]))), None)
            if path is None:
                continue
            ids = []
            for l in labs:      # the two names and the wires under them, by where they are
                for it in self._call("get_items", near={"x": l[1], "y": l[2], "radius": 40.0}).get("items", []):
                    sx = it.get("sexpr", "")
                    if it.get("kind") in ("label", "global_label") and f'label "{name}"' in sx and re.search(rf"\(at {re.escape(_num(l[1]))} {re.escape(_num(l[2]))}[ )]", sx):
                        ids.append(it["id"])
                    elif it.get("kind") == "wire" and any(_wire_is(sx, w) for w in gone):
                        ids.append(it["id"])
            if len(set(ids)) != 2 + len(gone):
                continue
            for i in dict.fromkeys(ids):
                self._edit({"op": "remove", "id": i})
            for u, v in zip(path, path[1:]):
                self._edit({"op": "add_wire", "points": [list(u), list(v)]})
            self.flush()
            joined += 1
        return joined

    @staticmethod
    def _ways(a, b) -> list:
        """The wires worth trying between two points: straight when they line up, else one step sideways part of the way
        along (the longer direction first, the step at the middle and then nearer either end), else a single corner."""
        if abs(a[0] - b[0]) < 1e-3 or abs(a[1] - b[1]) < 1e-3:
            return [[a, b]]
        grid = lambda v: round(v / 1.27) * 1.27
        out = []
        along_x = abs(a[0] - b[0]) >= abs(a[1] - b[1])
        for axis in ((0, 1) if along_x else (1, 0)):
            lo, hi = a[axis], b[axis]
            for t in (0.5, 0.25, 0.75):
                m = grid(lo + (hi - lo) * t)
                if abs(m - lo) < 1.27 or abs(m - hi) < 1.27:
                    continue
                way = [a, (m, a[1]), (m, b[1]), b] if axis == 0 else [a, (a[0], m), (b[0], m), b]
                if way not in out:
                    out.append(way)
        return out + [[a, (b[0], a[1]), b], [a, (a[0], b[1]), b]]

    def _through_part(self, path, g) -> bool:
        """Would a wire along `path` run through a part's body (between its pins) without ending on it?"""
        a, b = path[0], path[-1]
        x0, x1, y0, y1 = min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1])
        for p in g["parts"]:
            xs, ys = [q[3] for q in p["pins"]], [q[4] for q in p["pins"]]
            if not xs or any(_same((q[3], q[4]), e) for q in p["pins"] for e in (a, b)):
                continue
            bx0, bx1, by0, by1 = min(xs) - 1.27, max(xs) + 1.27, min(ys) - 1.27, max(ys) + 1.27
            if x0 < bx1 and x1 > bx0 and y0 < by1 and y1 > by0:
                return True
        return False

    def _repair(self, nets: dict) -> None:
        """Whatever the drawing left open gets its name on every pin, so the sheet is right even where it is not pretty."""
        bad = {m.split(":", 1)[0] for m in self._miswired(nets) if "not all joined" in m}
        for name in bad:
            for spec in nets[name]:
                try:
                    self.net(name, spec)
                except HarnessError:
                    pass
        if bad:
            self.flush()

    def _pack(self, blocks, paper, top=None, force: bool = False):
        """Where each block goes on a page: in the order given, each as high and then as far left as it fits, clear of
        the border and the title block (a skyline, so a short block sits under a short neighbour instead of starting a new row)."""
        _, pw, ph = paper
        left, right, bottom, gap = 15.24, pw - 15.24, ph - 15.24, 5.08
        ty0 = max(top or 15.24, 15.24)
        title = (pw - 125.0, ph - 49.0)
        sky = [(left, right, ty0)]   # (x0, x1, y): the drawing is free below y between x0 and x1
        spots, done = [], []
        for b in blocks:
            w, h = b["w"], b["h"]
            best = None
            xs = sorted({seg[0] for seg in sky})
            for x in xs:
                if x + w > right + 1e-6:
                    continue
                y = max(seg[2] for seg in sky if seg[0] < x + w - 1e-6 and seg[1] > x + 1e-6)
                while True:      # the skyline only keeps the gap to the right of a block: stay clear of every block already placed
                    hit = [r for r in done if x < r[0] + r[2] + gap - 1e-6 and x + w + gap > r[0] + 1e-6 and y < r[1] + r[3] + gap - 1e-6 and y + h + gap > r[1] + 1e-6]
                    if not hit:
                        break
                    y = max(r[1] + r[3] + gap for r in hit)
                if y + h > title[1] and x + w > title[0]:
                    continue
                if y + h > bottom + 1e-6:
                    continue
                if best is None or (y, x) < (best[1], best[0]):
                    best = (x, y)
            if best is None:
                if not force:
                    return None
                best = (left, max(seg[2] for seg in sky))
            x, y = best
            spots.append((x, y))
            done.append((x, y, w, h))
            nx0, nx1, ny = x, min(right, x + w + gap), y + h + gap
            new = []
            for a0, a1, ay in sky:
                if a1 <= nx0 or a0 >= nx1:
                    new.append((a0, a1, ay))
                    continue
                if a0 < nx0:
                    new.append((a0, nx0, ay))
                if a1 > nx1:
                    new.append((nx1, a1, ay))
            new.append((nx0, nx1, ny))
            sky = sorted(new)
        return spots

    def _try_pins(self, spec):
        try:
            return self._pins(spec)
        except HarnessError:
            return []


def _power_symbol(name: str, ground: bool) -> str:
    """A power symbol for a net name KiCad's power library does not have, drawn like the library's own."""
    q = lambda t: '"' + str(t).replace("\\", "\\\\").replace('"', '\\"') + '"'
    hide = '(effects (font (size 1.27 1.27)) (hide yes))'
    line = lambda pts: "\t\t\t(polyline (pts " + " ".join(f"(xy {x} {y})" for x, y in pts) + ") (stroke (width 0) (type default)) (fill (type none)))"
    if ground:
        art, vy, ry, ang = [line([(0, 0), (0, -1.27), (1.27, -1.27), (0, -2.54), (-1.27, -1.27), (0, -1.27)])], -3.81, -6.35, 270
    else:
        art, vy, ry, ang = [line([(-0.762, 1.27), (0, 2.54)]), line([(0, 2.54), (0.762, 1.27)]), line([(0, 0), (0, 2.54)])], 3.556, -3.81, 90
    rows = [f"\t(symbol {q(name)}", "\t\t(power)", "\t\t(pin_numbers (hide yes))", "\t\t(pin_names (offset 0) (hide yes))", "\t\t(exclude_from_sim no)", "\t\t(in_bom yes)", "\t\t(on_board yes)",
            f'\t\t(property "Reference" "#PWR" (at 0 {ry} 0) {hide})',
            f'\t\t(property "Value" {q(name)} (at 0 {vy} 0) (effects (font (size 1.27 1.27))))',
            f'\t\t(property "Footprint" "" (at 0 0 0) {hide})', f'\t\t(property "Datasheet" "" (at 0 0 0) {hide})',
            f'\t\t(property "Description" {q("Power symbol creates a global label with name " + name)} (at 0 0 0) {hide})',
            f'\t\t(property "ki_keywords" "global power" (at 0 0 0) {hide})',
            f"\t\t(symbol {q(name + '_0_1')}"] + art + ["\t\t)", f"\t\t(symbol {q(name + '_1_1')}",
            f'\t\t\t(pin power_in line (at 0 0 {ang}) (length 0) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))',
            "\t\t)", "\t\t(embedded_fonts no)", "\t)"]
    return "\n".join(rows) + "\n"


def _rot(dx: float, dy: float, rotation: int):
    r = rotation % 360
    return {0: (dx, dy), 90: (dy, -dx), 180: (-dx, -dy), 270: (-dy, dx)}[r]


def _ref_key(r: str):
    m = re.match(r"^(\D*)(\d*)(.*)$", r)
    return (m.group(1), int(m.group(2) or 0), m.group(3))



def _overlap_frac(a, b) -> float:
    """How much of the smaller of two boxes [x0, y0, x1, y1] the other covers (0 to 1)."""
    w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return (w * h) / small if small > 0 else 0.0

class Board(_Doc):
    """The board."""

    def __init__(self, project, path):
        super().__init__(project, path)
        self._groups: dict = {}
        self._connectivity = []

    # ---- reading
    def parts(self) -> list:
        return [{k: p[k] for k in ("ref", "value", "footprint", "x", "y", "rotation", "side")} for p in self.geometry()["parts"]]

    def refs(self) -> list:
        return sorted((p["ref"] for p in self.geometry()["parts"]), key=_ref_key)

    def pads(self, ref: str) -> list:
        for p in self.geometry()["parts"]:
            if p["ref"].lower() == ref.lower():
                # size: the pad's width and height in its own frame, rot: its turn on the board (degrees)
                return [{"ref": p["ref"], "number": q[0], "x": q[1], "y": q[2], "net": q[3], **({"size": [q[4], q[5]], "rot": q[6]} if len(q) > 6 else {})} for q in p["pads"]]
        raise HarnessError(f"There is no footprint {ref} on the board.")

    def courtyards(self, refs=None) -> dict:
        """ref -> [x0, y0, x1, y1, side]: the box each part's courtyard takes up as placed (the pad box when the footprint
        draws no courtyard). Read it after `sync()` to plan a floorplan from real sizes instead of guessing."""
        want = {r.lower() for r in ([refs] if isinstance(refs, str) else refs)} if refs else None
        out = {}
        for p in self.geometry()["parts"]:
            if want is not None and p["ref"].lower() not in want:
                continue
            box = p.get("courtyard")
            if not box:
                xs = [q[1] for q in p["pads"]] or [p["x"]]; ys = [q[2] for q in p["pads"]] or [p["y"]]
                box = [min(xs) - 0.5, min(ys) - 0.5, max(xs) + 0.5, max(ys) + 0.5]
            out[p["ref"]] = [round(v, 2) for v in box] + [p["side"]]
        return out

    def clashes(self, gap: float = 0.0) -> list:
        """Pairs of parts on the same side whose courtyards overlap or sit closer than `gap` mm:
        [[a, b, overlap_x_mm, overlap_y_mm], ...]. Moving one of the two by the smaller figure (plus the gap) clears it.
        An empty list is a floorplan DRC will accept; check it before routing, which is the slow step."""
        cy = list(self.courtyards().items()); out = []
        for i, (a, A) in enumerate(cy):
            for b, B in cy[i + 1:]:
                if A[4] != B[4]:
                    continue
                ox = min(A[2], B[2]) - max(A[0], B[0]) + gap; oy = min(A[3], B[3]) - max(A[1], B[1]) + gap
                if ox > 1e-6 and oy > 1e-6:
                    out.append([a, b, round(ox, 2), round(oy, 2)])
        return out

    def pad(self, spec: str) -> dict:
        ref, _, num = spec.partition(".")
        for q in self.pads(ref):
            if q["number"] == num:
                return q
        raise HarnessError(f"{ref} has no pad {num}.")

    def swap_pins(self, ref: str, nets: list, apply: bool = True, sheet: str | None = None) -> dict:
        """Choose the pin each net uses on a chip whose pins are interchangeable, from where the parts sit: every net in
        `nets` lands on the pin that faces the part it goes to, so the connections leave the chip side by side instead of
        crossing each other, which is what forces vias.  Call it after placement and before routing, with only the nets
        that may move (general I/O; not supplies, configuration, clock or dedicated-function pins, and lay out a
        differential pair's two pins yourself).  The pins stay the set those nets are on now.

        apply=True renames the labels in the schematic (`sch.assign_pins`), takes up the tracks of the nets that moved
        and syncs the board.  Returns {"pins": {pin: net} that changed, "before_mm", "after_mm"} (summed straight-line
        length from each pin's way out to its nearest target pad)."""
        import math
        want = {str(n).lstrip("/") for n in nets}; parts = self.geometry()["parts"]
        me = next((p for p in parts if p["ref"].lower() == ref.lower()), None)
        if me is None:
            raise HarnessError(f"There is no footprint {ref} on the board.")
        cx, cy = me["x"], me["y"]; mine: dict = {}; targets: dict = {}
        for q in me["pads"]:
            n = (q[3] or "").lstrip("/")
            if n in want:
                mine.setdefault(n, []).append(q)
        mine = {n: v[0] for n, v in mine.items() if len(v) == 1}
        for p in parts:
            if p is me:
                continue
            for q in p["pads"]:
                n = (q[3] or "").lstrip("/")
                if n in mine:
                    targets.setdefault(n, []).append((q[1], q[2]))
        names = [n for n in mine if n in targets]; pins = [mine[n] for n in names]

        def way_out(q):      # a pin leaves its chip straight out from the side it is on
            dx, dy = q[1] - cx, q[2] - cy
            return (q[1] + math.copysign(2, dx), q[2]) if abs(dx) >= abs(dy) else (q[1], q[2] + math.copysign(2, dy))

        outs = [way_out(q) for q in pins]
        cost = [[min(math.hypot(o[0] - t[0], o[1] - t[1]) for t in targets[n]) for n in names] for o in outs]
        at = list(range(len(names))); before = sum(cost[i][i] for i in at); moved = True
        while moved:         # swap any two that are shorter the other way round; two that cross always are
            moved = False
            for i in range(len(at)):
                for j in range(i + 1, len(at)):
                    if cost[i][at[j]] + cost[j][at[i]] < cost[i][at[i]] + cost[j][at[j]] - 1e-6:
                        at[i], at[j] = at[j], at[i]; moved = True
        change = {pins[i][0]: names[at[i]] for i in range(len(at)) if at[i] != i}
        out = {"pins": change, "before_mm": round(before, 1), "after_mm": round(sum(cost[i][at[i]] for i in range(len(at))), 1)}
        if apply and change:
            try:
                self.unroute(*sorted(set(change.values())))
            except HarnessError:
                pass
            self.project.schematic(sheet).assign_pins(me["ref"], change) if sheet else self.project.schematic().assign_pins(me["ref"], change)
            self.sync()
            self._geom = None; out["bypass"] = self.place_bypass(me["ref"])
            self.project.note(f"board: {me['ref']}: {len(change)} pins reassigned so their nets leave towards their parts ({out['before_mm']} to {out['after_mm']} mm)")
        return out

    def place_bypass(self, ref: str | None = None, caps: list | None = None, reach: float = 7.0, apply: bool = True, skip=()) -> dict:
        """Put each bypass capacitor of a chip beside the supply pin it serves, at a spot that leaves the chip's signal
        pins a clear way to the parts they go to: a capacitor standing in front of I/O pins sends every one of those
        nets to another layer.  `board.autoplace` and `board.swap_pins` call it themselves; call it by hand after moving
        a chip.  ref=None does every chip that has supply pins with capacitors; `caps` names the capacitors (default:
        the two-pad C parts between one of the chip's supply nets and ground that have no nearer chip, regulator or
        oscillator on that net: an oscillator's own capacitor stays with it).

        Every supply pin gets one capacitor first (the smallest box, so the small-value part), the rest join the pin of
        their net that has fewest.  A spot costs its distance from capacitor pad to pin plus 4 mm for each signal pin
        whose way out (2 mm straight out of the chip, then on to its nearest partner pad) it stands on, so chip corners
        win over the front of a pin row.  Capacitors in `skip`, and those whose supply net already has tracks, stay.  Returns {ref: {cap: {"pin", "at", "rotation", "mm", "blocks"}}}."""
        import math
        parts = self.geometry()["parts"]; ol = self.geometry().get("outline"); out: dict = {}
        gnd = lambda n: (n or "").lstrip("/").upper().startswith(("GND", "AGND", "DGND", "PGND", "VSS"))
        two = {p["ref"]: p for p in parts if p["ref"][:1] == "C" and len(p["pads"]) == 2}
        chips = [p for p in parts if len(p["pads"]) >= 3 and p["ref"][:1] in ("U", "I", "Q")]      # a three-pin regulator has its capacitors too
        if ref is not None:
            chips = [p for p in chips if p["ref"].lower() == ref.lower()]
            if not chips and not any(p["ref"].lower() == ref.lower() for p in parts):
                raise HarnessError(f"There is no footprint {ref} on the board.")
        boxes = {r: b for r, b in self.courtyards().items()}
        from . import seat      # an antenna's clear area and the band of whole ground beside it take no capacitor
        for a in parts:
            if seat._Survey.antenna(None, a) and a["ref"] in boxes:
                boxes["~~" + a["ref"]] = seat._band(seat._Survey(self), boxes[a["ref"]])

        def supply_of(c):
            a, b = (c["pads"][0][3] or ""), (c["pads"][1][3] or "")
            return a if gnd(b) and a and not gnd(a) else b if gnd(a) and b and not gnd(b) else None

        def hits(box, a, b):         # does segment a-b pass through the box?
            x0, y0, x1, y1 = box; t0, t1 = 0.0, 1.0; dx, dy = b[0] - a[0], b[1] - a[1]
            for d, lo, hi, o in ((dx, x0, x1, a[0]), (dy, y0, y1, a[1])):
                if abs(d) < 1e-9:
                    if o < lo or o > hi:
                        return False
                else:
                    u, v = (lo - o) / d, (hi - o) / d
                    t0, t1 = max(t0, min(u, v)), min(t1, max(u, v))
                    if t0 > t1:
                        return False
            return True

        for me in chips:
            cx, cy = me["x"], me["y"]; nets_c = {supply_of(c) for c in two.values()} - {None}
            pins = [q for q in me["pads"] if q[3] in nets_c]
            if not pins:
                continue
            mine = []
            for r, c in two.items():
                n = supply_of(c)
                if caps is not None:
                    if r.lower() in {str(x).lower() for x in caps} and n in {q[3] for q in pins}:
                        mine.append(r)
                    continue
                if n not in {q[3] for q in pins}:
                    continue
                near = min((math.hypot(c["x"] - q[1], c["y"] - q[2]), o["ref"]) for o in parts if len(o["pads"]) >= 3 and o["ref"][:1] in ("U", "I", "Q", "X", "Y") for q in o["pads"] if q[3] == n)
                if near[1] == me["ref"]:
                    mine.append(r)
            routed = {n: bool((self._call("get_items", net=n, kinds=["segment"]) or {}).get("items")) for n in {supply_of(two[r]) for r in mine}}
            mine = [r for r in mine if r.lower() not in {str(x).lower() for x in skip} and not routed[supply_of(two[r])]]
            if not mine:
                continue
            ways = []                # the way each signal pin takes out of the chip and on to its partner
            for q in me["pads"]:
                n = q[3] or ""
                if not n or gnd(n) or n in nets_c or n.startswith("unconnected-"):
                    continue
                dx, dy = q[1] - cx, q[2] - cy
                if abs(dx) < 0.3 and abs(dy) < 0.3:
                    continue
                o = (q[1] + math.copysign(2, dx), q[2]) if abs(dx) >= abs(dy) else (q[1], q[2] + math.copysign(2, dy))
                t = [(u[1], u[2]) for p in parts if p is not me for u in p["pads"] if u[3] == n]
                way = [(q[1], q[2]), o]
                if t:
                    way.append(min(t, key=lambda u: math.hypot(u[0] - o[0], u[1] - o[1])))
                ways.append(way)
            size = lambda r: (boxes[r][2] - boxes[r][0]) * (boxes[r][3] - boxes[r][1])
            mine.sort(key=lambda r: (size(r), r)); load = {q[0]: 0 for q in pins}; jobs = []
            for r in mine:           # one capacitor to every pin first, then the least-served pin of the net
                n = supply_of(two[r]); own = [q for q in pins if q[3] == n]
                q = min(own, key=lambda q: (load[q[0]], math.hypot(two[r]["x"] - q[1], two[r]["y"] - q[2])))
                load[q[0]] += 1; jobs.append((r, q))
            taken = [b for r, b in boxes.items() if r not in mine]; res: dict = {}
            for r, q in jobs:
                c = two[r]; b = boxes[r]; w, h = b[2] - b[0], b[3] - b[1]; rot0 = c.get("rotation") or 0
                hot = next(u for u in c["pads"] if u[3] == q[3]); ox, oy = hot[1] - c["x"], hot[2] - c["y"]; best = None
                for turn in (0, 90, 180, 270):
                    a = math.radians(turn); px, py = ox * math.cos(a) + oy * math.sin(a), -ox * math.sin(a) + oy * math.cos(a)
                    hw, hh = (w / 2, h / 2) if turn % 180 == 0 else (h / 2, w / 2)
                    k = int(reach / 0.25)
                    for i in range(-k, k + 1):
                        for j in range(-k, k + 1):
                            x, y = round((q[1] + i * 0.25) * 4) / 4, round((q[2] + j * 0.25) * 4) / 4
                            d = math.hypot(x + px - q[1], y + py - q[2])
                            if d > reach or (best and d >= best[0]):
                                continue
                            box = (x - hw, y - hh, x + hw, y + hh)
                            if ol and (box[0] < ol[0] + 0.5 or box[1] < ol[1] + 0.5 or box[2] > ol[2] - 0.5 or box[3] > ol[3] - 0.5):
                                continue
                            if any(min(box[2], t[2]) - max(box[0], t[0]) > 1e-6 and min(box[3], t[3]) - max(box[1], t[1]) > 1e-6 for t in taken):
                                continue
                            wide = (box[0] - 0.75, box[1] - 0.75, box[2] + 0.75, box[3] + 0.75)      # room for the pin's track and a neighbour or two beside it
                            n_b = sum(1 for wy in ways if any(hits(wide, wy[m], wy[m + 1]) for m in range(len(wy) - 1)))
                            cost = d + 4 * n_b
                            if best is None or cost < best[0]:
                                best = (cost, x, y, (rot0 + turn) % 360, box, d, n_b)
                if best is None:
                    res[r] = {"pin": q[0], "left": "no free spot within reach"}; taken.append(tuple(b[:4])); continue
                taken.append(best[4]); res[r] = {"pin": q[0], "at": (best[1], best[2]), "rotation": best[3], "mm": round(best[5], 2), "blocks": best[6]}
                if apply and (abs(best[1] - c["x"]) > 1e-3 or abs(best[2] - c["y"]) > 1e-3 or best[3] != rot0 % 360):
                    self.place(r, (best[1], best[2]), rotation=best[3])
            out[me["ref"]] = res
        if apply and out:
            self.flush(); self._geom = None
            self.project.note("board: bypass capacitors placed " + ", ".join(f"{k} {len(v)}" for k, v in out.items()))
        return out

    def nets(self, filter: str | None = None) -> dict:
        """name -> {"pads": [...], "unrouted": n, "length_mm": x, "vias": n}"""
        r = self._call("list_nets", limit=1000000, **({"filter": filter} if filter else {}))
        return {n["name"]: {"pads": n["pads"], "unrouted": n["unrouted_connections"], "length_mm": n["routed_length_mm"], "vias": n.get("vias", 0)} for n in r.get("nets", [])}

    def unrouted(self) -> dict:
        """Nets that still have missing connections: name -> how many."""
        return {k: v["unrouted"] for k, v in self.nets().items() if v["unrouted"]}

    def info(self) -> dict:
        """Size, layers, rules and layout figures in a few lines."""
        self.flush()
        r = self.project.transport.call("get_board_info", {})
        lay = r.get("layout") or {}
        rules = r.get("design_rules") or {}
        return {"size_mm": r.get("size_mm"), "copper_layers": r.get("copper_layers"), "footprints": (r.get("statistics") or {}).get("footprints", {}).get("total"),
                "nets": r.get("nets"), "unrouted_connections": r.get("unrouted_connections"), "ratsnest_mm": lay.get("ratsnest_mm"), "vias": lay.get("vias"),
                "ground_vias": lay.get("ground_vias"), "signal_and_supply_vias": lay.get("other_vias"),
                "track_length_mm": lay.get("track_length_mm"), "clearance": rules.get("clearance"), "min_track_width": rules.get("min_track_width")}

    def models(self) -> dict:
        """Which parts show as their real 3D model: {"parts", "from_kicad_library", "from_vendor", "replaced": [{"ref", "footprint",
        "model", "match"}], "without_model": [{"ref", "footprint", "reason"}]}.
        A footprint from KiCad's library or from a vendor brings its model with it; the 3D view loads it by itself.
        Parts under replaced are shown with the closest model KiCad's library has (`assign_models()` writes it into the
        footprint); parts under without_model are drawn as a plain stand-in shape."""
        self.flush()
        return self.project.transport.call("get_board_info", {}).get("models_3d") or {}

    def assign_models(self, refs: list[str] | None = None, similar: bool = True) -> dict:
        """Give every part whose own 3D model KiCad's library does not have (or whose footprint names none) the closest
        model the library does have, written into the footprint so the desktop and the web 3D view both show it: the
        base package of a footprint variant (`..._HandSolder`), the same name in another library, the plainest model a
        short name begins, or another part of the same family in the same library (`similar=False` leaves those out).
        `refs` limits it to those parts.  Returns {"assigned": [{"ref", "model", "match"}], "without_model": [{"ref",
        "reason"}]}; parts left without a model keep a plain stand-in shape in the 3D view."""
        self.flush()
        e: dict = {"op": "assign_models", "similar": bool(similar)}
        if refs:
            e["refs"] = [str(r) for r in refs]
        self._edit(e)
        try:
            res = self.flush() or {}
        except HarnessError as err:
            if "already shows its own 3D model" in str(err) or "no replacement model was found" in str(err):
                left = (self.models().get("without_model") or [])
                return {"assigned": [], "without_model": [{"ref": m.get("ref"), "reason": m.get("reason")} for m in left if not refs or m.get("ref") in refs]}
            raise
        return dict(next((x["assign_models"] for x in res.get("details") or [] if "assign_models" in x), {"assigned": [], "without_model": []}))

    def align_models(self, refs: list[str] | None = None, fix: bool = True) -> dict:
        """Check that every part's 3D model sits on its pads: the model is loaded as the 3D view loads it and its pins
        must land on pin 1 and on the pad farthest from pin 1 (pin 1 alone passes a header turned half a turn about
        it).  A model that misses gets the quarter or half turn that lands it, written into the footprint's model
        rotate (`fix=False` only reports).  Returns {"checked", "aligned", "turned": [{"ref", "model", "turn"}],
        "misaligned": [{"ref", "model", "off": [{"pad", "mm"}]}], "not_loaded"}.  `board.design()` runs it at the end."""
        self.flush()
        e: dict = {"op": "align_models", "fix": bool(fix)}
        if refs:
            e["refs"] = [str(r) for r in refs]
        self._edit(e)
        res = self.flush() or {}
        return dict(next((x["align_models"] for x in res.get("details") or [] if "align_models" in x), {"checked": 0, "aligned": 0, "turned": [], "misaligned": [], "not_loaded": []}))

    # ---- setting up
    def sync(self, placements: dict | None = None) -> dict:
        """Update the board from the schematic: missing footprints are added, pad nets and values brought into line.
        A net the sheet renamed (a redrawn sheet, a label added or dropped) keeps its tracks, vias and zones: they take the
        new name with the pads, listed under "nets_renamed"."""
        e: dict = {"op": "update_from_schematic"}
        if placements:
            e["placements"] = {r: ({"x": v[0], "y": v[1], **({"rotation": v[2]} if len(v) > 2 else {})} if not isinstance(v, dict) else v) for r, v in placements.items()}
        if self.project.footprints:
            e["footprints"] = dict(self.project.footprints)
        for d in self.project._open.values():
            if d is not self:
                d.flush()
        self.flush()
        self._edit(e)
        try:
            res = self.flush() or {}
        except HarnessError as err:
            if "already matches the schematic" not in str(err):
                raise
            extra = re.search(r"not in the schematic: (.*)$", str(err))      # nothing to do is a result, not a failure
            return {"added": 0, "updated": 0, "nets": None, "problems": [], "not_in_schematic": [x.strip() for x in extra.group(1).split(",")] if extra else []}
        d = next((x["update_from_schematic"] for x in res.get("details") or [] if "update_from_schematic" in x), {})
        out = {"added": len(d.get("added", [])), "updated": len(d.get("updated", [])), "nets": d.get("nets"), "problems": d.get("problems") or [], "not_in_schematic": d.get("not_in_schematic") or []}
        if d.get("nets_renamed"):      # nets the sheet now calls something else: their tracks, vias and zones were renamed with the pads
            out["nets_renamed"] = d["nets_renamed"]
            self.__dict__.pop("_names", None)
        self.project.note(f"board: synced from the schematic, {out['added']} added, {out['updated']} updated" + (f", problems: {'; '.join(out['problems'][:5])}" if out["problems"] else ""))
        return out

    def _edge(self) -> list:
        """The lines, arcs and rectangles on Edge.Cuts: [(item, kind, [points])]."""
        out = []
        for it in self._call("get_items", kinds=["gr_rect", "gr_line", "gr_arc"]).get("items", []):
            sx = it.get("sexpr", "")
            if '"Edge.Cuts"' not in sx:
                continue
            pts = [(float(a), float(b)) for a, b in re.findall(r"\((?:start|end) ([-\d.]+) ([-\d.]+)\)", sx)]
            out.append((it, sx.lstrip("( \n\t").split(None, 1)[0], pts))
        return out

    def outline(self, x0: float, y0: float, x1: float, y1: float, radius: float = 1.0) -> None:
        """Draw the board outline on Edge.Cuts: a rectangle with rounded corners (the owner's rule: board corners are
        always rounded; `radius` in mm, 0 for square).  A board has one outline: what is already on the old outline's
        edge is taken off first, and calling it again with the same box and radius changes nothing."""
        self.flush()
        want = (_r(min(x0, x1)), _r(min(y0, y1)), _r(max(x0, x1)), _r(max(y0, y1)))
        r = max(0.0, min(float(radius or 0), (want[2] - want[0]) / 4, (want[3] - want[1]) / 4))
        self._geom = None; old = (self.geometry() or {}).get("outline"); frames = [want] + ([tuple(old)] if old else [])
        on = lambda p: any((abs(p[0] - f[0]) < 1e-3 or abs(p[0] - f[2]) < 1e-3 or abs(p[1] - f[1]) < 1e-3 or abs(p[1] - f[3]) < 1e-3)
                           and f[0] - 1e-3 <= p[0] <= f[2] + 1e-3 and f[1] - 1e-3 <= p[1] <= f[3] + 1e-3 for f in frames)
        mine = [(it, kind, pts) for it, kind, pts in self._edge() if kind == "gr_rect" or (pts and all(on(q) for q in pts))]
        a, b, c, d = want; k = r * (1 - math.sqrt(0.5))
        lines = [((a + r, b), (c - r, b)), ((c, b + r), (c, d - r)), ((c - r, d), (a + r, d)), ((a, d - r), (a, b + r))] if r else []
        arcs = [((c - r, b), (c - k, b + k), (c, b + r)), ((c, d - r), (c - k, d - k), (c - r, d)), ((a + r, d), (a + k, d - k), (a, d - r)), ((a, b + r), (a + k, b + k), (a + r, b))] if r else []
        key = lambda pts: tuple(sorted((round(x, 3), round(y, 3)) for x, y in pts))
        have = sorted(key(pts) for _, _, pts in mine)
        if have == (sorted([key(l) for l in lines] + [key((s, e)) for s, _, e in arcs]) if r else [key(((a, b), (c, d)))]):
            return
        for it, _, _ in mine:
            self._edit({"op": "remove", "id": it["id"]})
        self._geom = None
        tail = f'(stroke (width 0.05) (type solid)) (layer "Edge.Cuts")'
        if not r:
            self.add_item(f'(gr_rect (start {_r(a)} {_r(b)}) (end {_r(c)} {_r(d)}) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "{_uuid.uuid4()}"))')
            return
        for s_, e_ in lines:
            self.add_item(f'(gr_line (start {_r(s_[0])} {_r(s_[1])}) (end {_r(e_[0])} {_r(e_[1])}) {tail} (uuid "{_uuid.uuid4()}"))')
        for s_, m_, e_ in arcs:
            self.add_item(f'(gr_arc (start {_r(s_[0])} {_r(s_[1])}) (mid {_r(m_[0])} {_r(m_[1])}) (end {_r(e_[0])} {_r(e_[1])}) {tail} (uuid "{_uuid.uuid4()}"))')

    def round_corners(self, radius: float = 1.0) -> None:
        """Round the corners of a rectangular outline (board corners are always rounded)."""
        self.flush(); self._geom = None; o = (self.geometry() or {}).get("outline")
        if o:
            self.outline(o[0], o[1], o[2], o[3], radius=radius)

    def rules(self, **rules):
        """With no arguments: the rules as they stand (clearance, edge_clearance, net_classes with track and via sizes).
        Otherwise set design rules in mm: clearance, track_width, via_diameter, via_drill, min_track_width, min_clearance, edge_clearance, hole_clearance (copper to a hole of something else), min_text_height (the smallest silkscreen text the rules check accepts, 0.8 unless set), net_class."""
        if not rules:
            self.flush()
            return self.project.transport.call("get_board_info", {}).get("design_rules") or {}
        self._edit(dict({"op": "set_rules"}, **rules))
        self.flush()

    def zone(self, net: str, layer: str = "B.Cu", box=None, clearance: float = 0.3, connect: str = "thermal") -> None:
        """A copper pour on a net over a rectangle (the board outline by default).

        connect: how pads of the net join it: "thermal" (reliefs, KiCad's default) or "solid"."""
        b = box or self.geometry().get("outline")
        if not b:
            raise HarnessError("The board has no outline yet; draw one or give the zone a box.")
        pts = " ".join(f"(xy {_r(x)} {_r(y)})" for x, y in ((b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])))
        net = self._net(net)
        self.flush()
        for z in self.zones():      # a plane of another net already over this area of the layer: a second pour at its priority would fight it
            if z.get("keepout") or z["net"] in ("", net) or layer not in z["layers"] or z["priority"] != 0 or not z.get("box"):
                continue
            if _overlap_frac(z["box"], [min(b[0], b[2]), min(b[1], b[3]), max(b[0], b[2]), max(b[1], b[3])]) > 0.5:
                raise HarnessError(f'zone: {layer} already carries a {z["net"]} pour over most of this area; a {net} pour at the same priority would fight it for the copper. Give one a priority or pick another layer.')
        for z in self._call("get_items", kinds=["zone"]).get("items", []):      # one pour of a net on a layer over a box: asking again adds nothing
            sx = z.get("sexpr", "")
            if "keepout" in sx or f'"{layer}"' not in sx or not re.search(r'\(net(_name)? "?' + re.escape(net) + r'"?\)', sx):
                continue
            pts = [(float(a), float(c)) for a, c in re.findall(r"\(xy ([-\d.]+) ([-\d.]+)\)", sx.split("(filled_polygon")[0])]
            if pts and abs(min(p[0] for p in pts) - min(b[0], b[2])) < 0.01 and abs(max(p[0] for p in pts) - max(b[0], b[2])) < 0.01 and abs(min(p[1] for p in pts) - min(b[1], b[3])) < 0.01 and abs(max(p[1] for p in pts) - max(b[1], b[3])) < 0.01:
                return
        self.add_item(f'(zone (net "{net}") (layer "{layer}") (uuid "{_uuid.uuid4()}") (hatch edge 0.5) (connect_pads{' yes' if connect == 'solid' else ''} (clearance {clearance})) (min_thickness 0.25) '
                      f'(fill (thermal_gap 0.3) (thermal_bridge_width 0.4)) (polygon (pts {pts})))')

    def keepout(self, box, layers=None, tracks: bool = True, vias: bool = True, copper: bool = True, footprints: bool = False, name: str = "") -> None:
        """A rule area (KiCad keepout) over a rectangle [x0, y0, x1, y1] (or a polygon [(x, y), ...]): nothing of the kinds named may enter it.

        Use it under an antenna (no copper on any layer), for the gap between an analog and a digital section, or to
        hold tracks off a switching converter's inductor.  layers: copper layers it applies to (default all of
        them).  tracks / vias / copper (pours) / footprints: True keeps that out.  The autorouter, the zone filler
        and the design rule check all honour it."""
        ls = list(layers) if layers else list(self.info().get("copper_layers") or ["F.Cu", "B.Cu"])
        if box and isinstance(box[0], (list, tuple)):       # a polygon [(x, y), ...]
            pts = " ".join(f"(xy {_r(x)} {_r(y)})" for x, y in box)
        else:
            x0, y0, x1, y1 = (min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3]))
            pts = " ".join(f"(xy {_r(x)} {_r(y)})" for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)))
        ok = lambda keep: "not_allowed" if keep else "allowed"
        lay = f'(layer "{ls[0]}")' if len(ls) == 1 else "(layers " + " ".join(f'"{l}"' for l in ls) + ")"
        self.add_item(f'(zone (net 0) (net_name "") {lay} (uuid "{_uuid.uuid4()}")' + (f' (name "{name}")' if name else "") + ' (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) '
                      f'(keepout (tracks {ok(tracks)}) (vias {ok(vias)}) (pads allowed) (copperpour {ok(copper)}) (footprints {ok(footprints)})) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts {pts})))')

    def _fresh_checks(self) -> dict:
        """The rules check on freshly filled pours, as KiCad's DRC refills first: on the stored fills every via or track
        laid since the last fill sits in another net's old pour (zone clearance 0).  For the steps that judge new copper
        by the check; a plain _call("run_checks") keeps the stored fills, which the router's later passes expect."""
        with contextlib.suppress(HarnessError):
            self.fill()
        return self._call("run_checks")

    def fill(self) -> dict:
        """Fill every copper zone (KiCad's Fill All Zones) and report the connections still open.

        A pour connects nothing until it is filled, and the design rule check reads the stored fills."""
        self.flush()
        self._edit({"op": "fill_zones"})
        try:
            res = self.flush() or {}
        except HarnessError as err:
            if "already filled" in str(err) or "no copper zone" in str(err):
                return {"zones": 0, "refilled": 0}
            raise
        return next((x["fill_zones"] for x in res.get("details") or [] if "fill_zones" in x), {})

    def pad_connection(self, spec: str, connect: str = "solid") -> None:
        """How a pad joins a zone of its net: "solid", "thermal", "none" or "inherit" (the zone's own setting).  spec is "J2.3"."""
        ref, _, num = spec.partition(".")
        self._edit({"op": "pad_connection", "ref": ref, "pad": num, "connect": connect}, "item:" + ref)

    def fix_thermals(self) -> list:
        """Pads whose thermal relief reaches the pour with too few spokes (DRC: starved_thermal) are joined to it
        solidly, as a person does in Pad Properties, and the zones are filled again.  Returns the pads changed."""
        done: list = []
        for _ in range(3):
            self.fill()
            rows = [v for v in self._call("run_checks").get("violations", []) if v["code"] == "starved_thermal"]
            todo: dict = {}
            for v in rows:
                near: list = []
                for ref in v.get("refs") or []:
                    try:
                        pads = self.pads(ref)
                    except HarnessError:
                        continue
                    near += [((q["x"] - v["x"]) ** 2 + (q["y"] - v["y"]) ** 2, q["ref"], q["number"]) for q in pads]
                near.sort()
                # every pad at that spot: a USB-C socket has two pads (A12 and B1) on one piece of copper
                for d, ref, num in [q for q in near if q[0] <= near[0][0] + 0.01]:
                    if f"{ref}.{num}" not in done:
                        todo.setdefault(ref, []).append(num)
            if not todo:
                break
            for ref, nums in todo.items():
                self._edit({"op": "pad_connection", "ref": ref, "pads": sorted(set(nums)), "connect": "solid", "if_needed": True})
                done += [f"{ref}.{n}" for n in sorted(set(nums))]
            self.flush()
        if done:
            self.fill()
        return done

    def check(self, limit: int = 6, kind: str | None = None, warnings: bool = False, refill: bool = True) -> dict:
        """DRC: counts by kind and the first few violations, errors first.  Zones are refilled first, as KiCad's DRC dialog does.
        `kind` lists only that kind ("unconnected_items", "clearance"); `warnings=True` lists warnings after the errors."""
        if refill:
            self.fill()
        return super().check(limit, kind, warnings)

    # ---- placing
    def place(self, ref: str, at, rotation: float | None = None, side: str | None = None) -> None:
        """Put a footprint at a point, optionally turned and on a side ("front" or "back")."""
        e = {"op": "move", "ref": ref, "x": _r(at[0]), "y": _r(at[1])}
        if rotation is not None:
            e["rotation"] = rotation
        if side:
            e["side"] = side
        self._edit(e, "item:" + ref)

    def move(self, ref: str, to=None, by=None, rotation: float | None = None, side: str | None = None) -> None:
        if to is None:
            p = self._part(ref)
            to = (p["x"] + (by[0] if by else 0), p["y"] + (by[1] if by else 0))
        self.place(ref, to, rotation, side)

    def rotate(self, ref: str, rotation: float) -> None:
        p = self._part(ref)
        self.place(ref, (p["x"], p["y"]), rotation)

    def flip(self, ref: str) -> None:
        p = self._part(ref)
        self.place(ref, (p["x"], p["y"]), side="front" if p["side"] == "back" else "back")

    def _part(self, ref):
        p = next((q for q in self.geometry()["parts"] if q["ref"].lower() == ref.lower()), None)
        if not p:
            raise HarnessError(f"There is no footprint {ref} on the board.")
        return p

    def group(self, name: str, refs: list, anchor: str | None = None) -> None:
        """Declare a functional block: autoplace keeps its parts together around the anchor (the first part by default)."""
        self._groups[name] = {"refs": list(refs), "anchor": anchor or refs[0]}

    def autoplace(self, groups: dict | None = None, near: dict | None = None, edges: dict | None = None, fixed: dict | None = None,
                  outline=None, spacing: float | None = None, only: list | None = None, fit: bool = False, max_fill: float | None = None,
                  rotations: dict | None = None, bypass: bool = True, seat: bool = True) -> dict:
        """Place footprints with the placement engine: blocks packed around their anchors, blocks arranged inside the outline.

        groups: {block: [refs]} (first ref is the anchor) in addition to those declared with group(); near: {ref: ref}
        for parts that must sit beside another (decoupling, crystal); edges: {ref: "left"|"right"|"top"|"bottom"};
        fixed: {ref: (x, y[, rotation])}; rotations: {ref: degrees} turns a part (a block's anchor turns its block) and lets
        the engine choose where, e.g. to face a chip's pins towards the parts they serve.  With nothing given the engine groups the parts itself.  fit=True pulls the
        board outline in round the parts (the smallest rectangle in whole millimetres every block fits in, connectors
        still on their edges) and redraws Edge.Cuts to it; give the outline first as the largest the board may be.  max_fill
        is how much of the board the courtyards may cover (0.45 by default; the person's densest boards reach 0.46).
        Every footprint is placed unless `only` names the ones to place.  Afterwards the bypass capacitors go to their
        supply pins (place_bypass) and every other small part goes in front of the pin it serves (seat): a pull-down
        at its connector pin with its ground end out, a crystal turned to its oscillator pins, a matching network in
        line at the radio pin.  bypass=False / seat=False leave those out.
        """
        self.flush()      # moves queued before it go in first: the engine re-places those parts in a batch of its own
        specs: dict = {}
        allg = dict(self._groups)
        for name, refs in (groups or {}).items():
            allg[name] = {"refs": list(refs), "anchor": refs[0]}
        for name, gdef in allg.items():
            for r in gdef["refs"]:
                specs.setdefault(r, {"ref": r})["group"] = name
            specs[gdef["anchor"]]["anchor"] = True
        for r, n in (near or {}).items():
            specs.setdefault(r, {"ref": r})["near"] = n
        for r, edge in (edges or {}).items():
            specs.setdefault(r, {"ref": r})["edge"] = edge
        for r, deg in (rotations or {}).items():
            specs.setdefault(r, {"ref": r})["rotation"] = deg
        for r, v in (fixed or {}).items():
            specs.setdefault(r, {"ref": r})["fixed"] = {"x": v[0], "y": v[1], "rotation": v[2] if len(v) > 2 else 0}
        if only:
            for r in only:
                specs.setdefault(r, {"ref": r})
        elif specs:      # a part nobody named is still placed: the engine puts it with the part it shares its nets with
            for r in self.refs():
                specs.setdefault(r, {"ref": r})
        e: dict = {"op": "auto_place"}
        if specs:
            e["parts"] = list(specs.values())
        if outline:
            e["outline"] = list(outline)
        if spacing is not None:
            e["spacing"] = spacing
        if fit:
            e["fit"] = True
        if max_fill:
            e["max_fill"] = max_fill
        self._edit(e)
        res = self.flush() or {}
        d = next((x["auto_place"] for x in res.get("details") or [] if "auto_place" in x), {})
        out = {"placed": len(d.get("placements", [])), "score": d.get("score"), "outline": d.get("outline"), "unknown_refs": d.get("unknown_refs") or []}
        if d.get("turned"):      # square chips the engine stood at 45 degrees because their cluster came out smaller
            out["turned_45"] = d["turned"]
        if d.get("motion_sensors"):      # accelerometers, gyros, IMUs: square to the board, and which way their axes point
            out["motion_sensors"] = d["motion_sensors"]
        self.project.note(f"board: placed {out['placed']} footprints, score {out['score']}")
        # the small parts, in the order a person seats them: the matching network at the radio pin, the bypass capacitors
        # at their supply pins, then the crystal at its oscillator pins and the parts that serve one pin (a pull-down in
        # front of its connector pin), and last whatever still stands on something else
        hold = tuple(fixed or {}); caps: tuple = ()
        if bypass:
            self._geom = None
            caps = tuple(c for v in self.place_bypass(skip=hold + tuple(self._hangers()), apply=False).values() for c in v)
        radio: tuple = ()
        if seat:      # the radio's matching network first: it has exactly one place, in line from the radio pin to the feed
            self._geom = None
            radio = tuple(r for r in self._radio() if r not in hold)
            out["seated"] = self.seat(refs=list(radio), skip=hold + caps, giveway=tuple(r for r in self._serving() if r.lower() not in {h.lower() for h in hold})) if radio else {}      # a part the floor plan fixed gives way to nothing
        if bypass:    # then the bypass capacitors, each at its supply pin, before a crystal or a pull-up takes the spot
            self._geom = None
            out["bypass"] = self.place_bypass(skip=hold + tuple(self._hangers()) + radio)
        if seat:      # then the crystal and every other part that serves a pin
            self._geom = None
            out["seated"].update(self.seat(skip=hold + caps + radio))
        if seat or bypass:
            moved = self.settle(skip=hold)
            if moved:
                out["settled"] = moved
        return out

    # ---- copper
    def track(self, net: str, points, layer: str = "F.Cu", width: float | None = None) -> None:
        """A track of `net` through points on `layer`; a point may be a pad written "REF.pad".  width defaults to the net
        class.  Change layer with board.via() at the point where two tracks meet.  board.whats_at((x, y)) shows what
        copper is near a point before you draw."""
        pts = []
        for p in points:
            if isinstance(p, str):
                q = self.pad(p)
                pts.append([q["x"], q["y"]])
            else:
                pts.append([_r(p[0]), _r(p[1])])
        e = {"op": "add_track", "net": net, "layer": layer, "points": pts}
        if width:
            e["width"] = width
        self._edit(e)

    def via(self, net: str, at, size: float | None = None, drill: float | None = None) -> None:
        """A via of `net` at (x, y); size and drill default to the net class (a smaller one fits a tight spot when the rules
        allow it: size=0.4, drill=0.2).  board.whats_at((x, y)) tells what copper stands in the way first."""
        e = {"op": "add_via", "net": net, "x": _r(at[0]), "y": _r(at[1])}
        if size:
            e["size"] = size
        if drill:
            e["drill"] = drill
        self._edit(e)

    def fits(self, net: str, via=None, track=None, layer: str = "F.Cu", width: float | None = None, size: float | None = None,
             drill: float | None = None) -> dict:
        """Would a via at `via`=(x, y) or a track through `track`=[(x, y), ...] on `layer` keep every rule against the
        copper already there?  Checks the copper clearance (real pad shapes, turned pads included), the hole clearance
        both ways, by net class.  Returns {"fits", "blocked_by": [{"id", "kind", "ref", "net", "layer", "rule",
        "slack_mm"}], "nearest": [...]}; a negative slack_mm is how far it falls short.  Nothing is drawn."""
        self.flush()
        args = {"net": self._net(net)}
        if via is not None:
            args["via"] = {"x": float(via[0]), "y": float(via[1]), **({"size": size} if size else {}), **({"drill": drill} if drill else {})}
        if track is not None:
            pts = [(lambda q: [q["x"], q["y"]])(self.pad(p)) if isinstance(p, str) else [float(p[0]), float(p[1])] for p in track]
            args["track"] = {"pts": pts, "layer": layer, **({"width": width} if width else {})}
        return self._call("fits", **args)

    def move_via(self, via_id: str, to) -> None:
        """Move a via to `to`=(x, y) and drag the ends of the tracks that met it along, on every layer (check the new
        spot with board.fits(net, via=to) first).  The tracks keep their other ends, so a long run may need a new bend."""
        self.flush()
        got = self._call("get_items", ids=[via_id]).get("items", [])
        if not got:
            raise HarnessError(f"There is no via {via_id} on the board.")
        sx = got[0]["sexpr"]
        m = re.search(r"\(at ([\d.\-]+) ([\d.\-]+)\)", sx)
        x0, y0 = float(m.group(1)), float(m.group(2)); x1, y1 = float(to[0]), float(to[1])
        moved = []
        for it in self._call("get_items", kinds=["segment"], near={"x": x0, "y": y0, "radius": 0.05}).get("items", []):
            t = it["sexpr"]
            for end in ("start", "end"):
                e = re.search(r"\(" + end + r" ([\d.\-]+) ([\d.\-]+)\)", t)
                if e and abs(float(e.group(1)) - x0) < 0.002 and abs(float(e.group(2)) - y0) < 0.002:
                    t = t[:e.start()] + f"({end} {_r(x1)} {_r(y1)})" + t[e.end():]
            if t != it["sexpr"]:
                moved.append((it["id"], t))
        fresh = lambda t: re.sub(r'\s*\(uuid "[^"]*"\)', "", t)
        self._edit({"op": "remove", "id": via_id})
        self.add_item(fresh(sx[:m.start()] + f"(at {_r(x1)} {_r(y1)})" + sx[m.end():]))
        for i, t in moved:
            self._edit({"op": "remove", "id": i})
            self.add_item(fresh(t))
        self.flush()

    def whats_at(self, at, radius: float = 0.8) -> list:
        """The copper within `radius` mm of a point, nearest first: [{"kind", "net", "layer", "gap_mm", "id", and "start",
        "end", "width" for a track or "at", "size" for a via or pad}], gap_mm from the point to the item's copper edge
        (a pad's is rough: centre distance less half its narrow side).  Every item in reach is listed, however many.  Use it before a hand-placed via or
        track: a 0.45 mm via needs gap_mm of at least half its size plus the clearance to every other net's item."""
        self.flush()
        x, y = float(at[0]), float(at[1])
        out = []
        names = {}
        with contextlib.suppress(OSError):
            folder = getattr(self.project, "folder", None)
            if folder:
                with open(os.path.join(folder, self.path)) as fh:
                    names = dict(re.findall(r'\(net (\d+) "((?:[^"\\]|\\.)*)"\)', fh.read()))
        for it in self._all_items(["segment", "arc", "via", "footprint"], near={"x": x, "y": y, "radius": radius}):   # every page, never cut short
            sx = it.get("sexpr", "")
            if it.get("kind") == "footprint":
                for q in (self._part(it.get("ref") or "").get("pads") if it.get("ref") else []) or []:
                    d = math.hypot(q[1] - x, q[2] - y)
                    if d <= radius + 0.5:
                        half = min(q[4], q[5]) / 2 if len(q) > 5 and q[4] else 0.3
                        out.append({"kind": "pad", "net": q[3], "layer": "", "gap_mm": round(max(0.0, d - half), 3), "id": f"{it.get('ref')}.{q[0]}", "at": [q[1], q[2]], **({"size": [q[4], q[5]], "rot": q[6]} if len(q) > 6 else {})})
                continue
            nm = re.search(r'\(net (?:"((?:[^"\\]|\\.)*)"|(\d+))\)', sx); net = (nm.group(1) or names.get(nm.group(2), nm.group(2))) if nm else ""
            lay = re.search(r'\(layers? "([^"]+)"', sx); layer = lay.group(1) if lay else ""
            a = re.search(r"\(start ([\d.\-]+) ([\d.\-]+)\)\s*\(end ([\d.\-]+) ([\d.\-]+)\)", sx)
            if it.get("kind") in ("segment", "arc") and a:
                x0, y0, x1, y1 = map(float, a.groups()); w = float((re.search(r"\(width ([\d.]+)\)", sx) or [0, 0.2])[1])
                dx, dy = x1 - x0, y1 - y0; t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / ((dx * dx + dy * dy) or 1)))
                gap = math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) - w / 2
                where = {"start": [x0, y0], "end": [x1, y1], "width": w}
            else:
                v = re.search(r"\(at ([\d.\-]+) ([\d.\-]+)\)", sx); z = re.search(r"\(size ([\d.]+)", sx)
                if not v:
                    continue
                gap = math.hypot(x - float(v.group(1)), y - float(v.group(2))) - (float(z.group(1)) / 2 if z else 0.25)
                ls = re.search(r'\(layers ((?:"[^"]+"\s*)+)\)', sx)
                layer = "via"; where = {"at": [float(v.group(1)), float(v.group(2))], "size": float(z.group(1)) if z else None,
                                        "layers": re.findall(r'"([^"]+)"', ls.group(1)) if ls else ["F.Cu", "B.Cu"]}
            if gap <= radius:
                out.append({"kind": it.get("kind"), "net": net, "layer": layer, "gap_mm": round(max(0.0, gap), 3), "id": it["id"], **where})
        return sorted(out, key=lambda r: r["gap_mm"])

    def clear(self, keep: tuple = (), outline: bool = True) -> int:
        """Take everything off the board for a rebuild from nothing: footprints, tracks, vias, zones, drawings.  The board
        outline stays unless outline=False.  Returns how many items were removed."""
        self._keep_outline = outline
        return super().clear(keep)

    def _kept(self, it: dict) -> bool:
        return getattr(self, "_keep_outline", True) and str(it.get("kind", "")).startswith("gr_") and "Edge.Cuts" in it.get("sexpr", "")

    def unroute(self, *nets: str, keep: tuple = ("GND",), near=None, radius: float | None = None, attached: bool = False) -> int:
        """Take the tracks and vias of these nets off the board (of every net but `keep` when none is named), so that
        a crowded area can be laid again together.  Returns how many were removed.

        near="U1.8" (one pin), near="U9" (a part) or near=(x, y) takes up only the copper within `radius` mm of it, of
        every net but `keep` (and of the named nets only, when nets are given).  One boxed-in pin: free the copper just
        round it (1.5 mm by default) and lay the open net first, then the nets that were taken up, in one call:
            board.unroute(near="U1.8"); board.route(order=["/LED_SW_V"], time_s=60)
        A part's radius defaults to its pad ring plus 2.5 mm: that takes up most of a chip's fan-out, so use it only
        when many of its pins are open.  attached=True (with near= a part or pin) takes up only the nets of that part's
        pins, leaving the tracks that merely pass through the area (a USB pair round the chip) where they are."""
        if near is not None and attached and not nets and isinstance(near, str):
            ref = near.split(".")[0]
            nets = tuple(sorted({q["net"] for q in self.pads(ref) if q["net"] and q["net"] not in keep and self._net(q["net"]) not in keep}))
            if not nets:
                return 0
        if near is not None:
            return self._unroute_near(near, radius, [self._net(n) for n in nets], keep)
        names = [self._net(n) for n in nets] if nets else [n for n in self.nets() if n not in keep]
        count = 0
        for net in names:
            for _ in range(40):   # get_items answers in pages: take a page off the board, ask again
                got = self._call("get_items", net=net, kinds=["segment", "arc", "via"])
                for it in got.get("items", []):
                    self._edit({"op": "remove", "id": it["id"]})
                    count += 1
                self.flush()
                if not got.get("truncated") or not got.get("items"):
                    break
        if count:
            self.project.note(f"board: took up {count} tracks and vias of {len(names)} nets")
        return count

    def free_pins(self, radius: float = 1.5, time_s: float = 60, passes: int = 2, keep_rules: bool = False, layers: list | None = None,
                  budget_s: float | None = None) -> dict:
        """Close connections the router left open because earlier tracks boxed a pin in: for each open connection, the
        copper within `radius` mm of its pin on the busiest part (the fine-pitch chip) comes up, and the open net is laid
        first, then the nets that were taken up.  An attempt that does not lower the count of open connections is taken
        back exactly, so the board never gets worse.  A second pass tries what is still open with twice the radius.
        layers= limits the re-laid copper to those layers; by default the inner planes of a six-layer-and-up board are
        left out, as design() does.  Returns {"before": n, "after": n, "tried": [...]}.  Costs about time_s per open pin; budget_s stops it starting
        another pin once that many seconds have gone (what is left is listed under "not_tried")."""
        import time as _t
        t0 = _t.time(); skipped = []
        if layers is None:      # the same plane rule as design(): on six layers and up signals stay off the inner planes
            from .craft import signal_layers
            layers = signal_layers(self)[0]
        before = self.info()["unrouted_connections"]
        tried = []
        parts = {p["ref"]: p for p in self.geometry()["parts"]}
        done = set()
        for k in range(passes):
            if k and self.info()["unrouted_connections"] >= before:
                tried.append(f"pass {k + 1} skipped: pass {k} freed nothing, so a wider radius would not either")
                break
            rows = [v for v in self._call("run_checks").get("violations", []) if v.get("code") == "unconnected_items"]
            for v in rows:
                m = re.search(r"net '((?:[^'\\]|\\.)*)'", v.get("message", ""))
                if not m:
                    continue
                net = m.group(1)
                refs = sorted((r for r in (v.get("refs") or []) if r in parts), key=lambda r: -len(parts[r]["pads"]))
                pin = next((f"{r}.{q[0]}" for r in refs for q in parts[r]["pads"] if q[3] == net and q[0]), None)
                if not pin or (pin, k) in done:
                    continue
                if budget_s is not None and _t.time() - t0 > budget_s:
                    skipped.append(pin)
                    continue
                done.add((pin, k))
                q = self.pad(pin); r = radius * (1 + k)
                n0 = self.info()["unrouted_connections"]
                removed, nets = [], {net}
                for nm in [n for n in self.nets() if n not in ("GND",)]:
                    got = self._call("get_items", net=nm, kinds=["segment", "arc", "via"], near={"x": q["x"], "y": q["y"], "radius": r})
                    for it in got.get("items", []):
                        if "more characters" in it.get("sexpr", ""):
                            continue
                        removed.append(it["sexpr"]); nets.add(nm)
                        self._edit({"op": "remove", "id": it["id"]})
                self._track = []
                try:
                    self.flush()
                    self.route(nets=sorted(nets), order=[net], time_s=time_s, ground_vias=False, fill=False, keep_rules=keep_rules, layers=layers)   # pours are filled once, at the end
                    n1 = self.info()["unrouted_connections"]
                    if n1 >= n0:          # no better: put the board back as it was
                        for i in self._track:
                            self._edit({"op": "remove", "id": i})
                        self._track = None
                        for s in removed:
                            self.add_item(s)
                        self.flush()
                        n1 = self.info()["unrouted_connections"]
                finally:
                    self._track = None
                tried.append(f"{pin} {net}: {len(removed)} items within {r:g} mm, open {n0} -> {n1}")
        if tried:
            self.fill()
        after = self.info()["unrouted_connections"]
        self.project.note(f"board: freed boxed-in pins, open connections {before} -> {after}")
        return {"before": before, "after": after, "tried": tried, **({"not_tried": skipped} if skipped else {})}

    @contextlib.contextmanager
    def trial(self):
        """Try something and keep it only if it helped: inside `with board.trial() as t:` change the copper as you like,
        then set `t.keep = True` when the result is better; otherwise every track and via goes back exactly as it was
        when the block began (an exception puts it back too).  Parts, zones and rules are not tracked.
            with board.trial() as t:
                board.unroute(near="U4.20", radius=2)
                board.route(nets=list(board.unrouted()), fill=False, time_s=30)
                t.keep = board.info()["unrouted_connections"] < before"""
        class _T:
            keep = False
        t = _T()
        self.flush()
        snap = {it["id"]: it["sexpr"] for it in self._all_items(["segment", "arc", "via"]) if "more characters" not in it.get("sexpr", "")}
        try:
            yield t
        except BaseException:
            t.keep = False
            raise
        finally:
            self.flush()
            if not t.keep:
                now = {it["id"]: it.get("sexpr", "") for it in self._all_items(["segment", "arc", "via"])}
                changed = {i for i in set(now) & set(snap) if now[i] != snap[i] and "more characters" not in now[i]}
                for i in (set(now) - set(snap)) | changed:      # added, or changed in place (a moved via, a widened track)
                    self._edit({"op": "remove", "id": i})
                for i in (set(snap) - set(now)) | changed:
                    self.add_item(snap[i])
                self.flush()
                self._geom = None

    def optimize(self, nets: list | None = None, time_s: float = 10, stretch: float = 1.6, keep_rules: bool = True, budget_s: float | None = 600,
                 progress: bool = True, max_added_mm: float | None = 5.0) -> dict:
        """Take out layer changes a finished route does not need, net by net: each signal net with vias (or `nets`) is
        taken up and laid again on its own several ways (front only with no via, front and back, every layer, front
        with each inner layer), and the best is kept only when the net is whole, it has fewer vias (or the same and is
        shorter), it is no more than `stretch` times as long plus 4 mm, nothing else opened and the DRC has no more
        errors.  Supply and ground nets are left alone.  Returns {"before", "after" (signal vias), "kept": [...]}.
        About time_s seconds per try, five or six tries a net (each try also checks the board, which on a big board takes
        longer than the route); it stops starting new nets after `budget_s` seconds (None: no limit) and lists the nets
        it did not reach under "not_tried", most vias first, so a second call with nets= picks up there.  progress=True
        prints a line per net as it goes.  max_added_mm caps how much longer a net may get to lose a via (None: only
        `stretch`).  After the last refill anything that opened (a pour split by a re-laid neighbour) is routed again
        and reported under "reopened".  Run it last, on a board with every connection made."""
        import time as _t
        t_start = _t.time()
        supply = re.compile(r"^(GND|AGND|DGND|PGND|VSS|VBUS|VIN|VCC|VDD|VBAT)|^\+|^-|3V3|5V|1V8|LDO", re.I)
        def st(n):
            t = self.trace(n)
            return t.get("vias", 0), t.get("routed_length_mm", 0.0), t.get("open_connections", 0)
        errs = lambda: self.check(limit=1, refill=False)["errors"]
        e0 = errs(); open0 = self.info()["unrouted_connections"]
        names = nets or [n for n in self.nets() if not supply.search(n) and not n.startswith("unconnected")]
        cands = sorted(((st(n), n) for n in names), key=lambda c: -c[0][0])
        cands = [(s, n) for s, n in cands if s[0] > 0 and s[2] == 0]
        before = sum(s[0] for s, _ in cands)
        options = [dict(layers=["F.Cu"], allow_vias=False), dict(layers=["F.Cu", "B.Cu"], via_cost=8), dict(via_cost=8), dict(via_cost=20)]
        options += [dict(layers=["F.Cu", l], via_cost=8) for l in (self.info().get("copper_layers") or [])[1:-1] if isinstance(l, str)]
        kept, after, not_tried = [], before, []
        for i, ((v0, l0, _), net) in enumerate(cands):
            if budget_s is not None and _t.time() - t_start > budget_s:
                not_tried = [n for _, n in cands[i:]]
                break
            if progress:
                print(f"optimize: {net} ({i + 1}/{len(cands)}, {v0} vias, {l0:.1f} mm, {_t.time() - t_start:.0f} s)", flush=True)
            best = None
            for k, opt in enumerate(options):
                with self.trial():
                    self.unroute(net, keep=())
                    try:
                        self.route(nets=[net], fill=False, time_s=time_s, keep_rules=keep_rules, ground_vias=False, fence=False, **opt)
                    except HarnessError:
                        continue
                    v, l, o = st(net)
                    if o == 0 and self.info()["unrouted_connections"] <= open0 and (v < v0 or (v == v0 and l < l0 - 0.5)) and l <= l0 * stretch + 4 and (max_added_mm is None or l <= l0 + max_added_mm):
                        if best is None or (v, l) < best[0]:
                            best = ((v, l), k)
            if best is None:
                continue
            with self.trial() as t:
                self.unroute(net, keep=())
                self.route(nets=[net], fill=False, time_s=time_s, keep_rules=keep_rules, ground_vias=False, fence=False, **options[best[1]])
                v, l, o = st(net)
                if o == 0 and self.info()["unrouted_connections"] <= open0 and (v, l) < (v0, l0) and errs() <= e0:
                    t.keep = True; after -= v0 - v
                    kept.append(f"{net}: {v0} -> {v} vias, {l0:.1f} -> {l:.1f} mm")
        reopened = {}
        if kept:
            self.fill()
            now = self.unrouted()
            if sum(now.values()) > open0:      # the refill split a pour a re-laid net now crosses: lay what opened again
                with contextlib.suppress(HarnessError):
                    self.route(nets=list(now), fill=True, time_s=30, keep_rules=keep_rules)
                reopened = self.unrouted()
        self.project.note(f"board: optimized {len(kept)} nets, signal vias {before} -> {after}")
        return {"before": before, "after": after, "kept": kept, **({"not_tried": not_tried} if not_tried else {}), **({"reopened": reopened} if reopened else {})}

    def _all_items(self, kinds, **filt) -> list:
        """Every item of these kinds, page by page (get_items returns at most 150 at a time)."""
        out = []
        while True:
            r = self._call("get_items", kinds=list(kinds), offset=len(out), **filt)
            got = r.get("items", [])
            out += got
            if not got or len(out) >= r.get("count", 0):
                return out

    def _net_names(self) -> dict:
        names = {}
        with contextlib.suppress(OSError):
            folder = getattr(self.project, "folder", None)
            if folder:
                with open(os.path.join(folder, self.path)) as fh:
                    names = dict(re.findall(r'\(net (\d+) "((?:[^"\\]|\\.)*)"\)', fh.read()))
        return names

    def fix_corners(self, passes: int = 3) -> int:
        """Cut every square or sharper track corner the rules check reports (track_right_angle) into 45° bends: the two
        segments that meet there are laid again as one track through the same three points, which add_track chamfers.
        A track that doubles back on itself loses its dead tip, and an acute zigzag becomes one run with a 45° knee; each
        pass can uncover the next corner, so it runs up to `passes` times.  Antenna and RF nets are left as drawn.
        Returns how many corners were cut.  design() calls it before its checks."""
        total = 0
        for _ in range(max(1, passes)):
            n = self._fix_corners_once()
            total += n
            if not n:
                break
        return total

    def _fix_corners_once(self) -> int:
        rows = self._call("run_checks").get("violations", [])
        done = 0
        for v in rows:
            if v.get("code") != "track_right_angle":
                continue
            x, y = float(v["x"]), float(v["y"])
            m = re.search(r"net '((?:[^'\\]|\\.)*)'", v.get("message", ""))
            got = self._call("get_items", kinds=["segment"], near={"x": x, "y": y, "radius": 0.02}, **({"net": m.group(1)} if m else {}))
            segs = []
            for it in got.get("items", []):
                s = it.get("sexpr", "")
                a = re.search(r"\(start ([\d.\-]+) ([\d.\-]+)\)\s*\(end ([\d.\-]+) ([\d.\-]+)\)", s)
                if not a:
                    continue
                x0, y0, x1, y1 = map(float, a.groups())
                if math.hypot(x0 - x1, y0 - y1) < 1e-4:      # a zero-length segment left at the corner: it goes
                    self._edit({"op": "remove", "id": it["id"]})
                    continue
                if math.hypot(x0 - x, y0 - y) < 0.002:
                    far = (x1, y1)
                elif math.hypot(x1 - x, y1 - y) < 0.002:
                    far = (x0, y0)
                else:
                    continue
                nm = re.search(r'\(net (?:"((?:[^"\\]|\\.)*)"|(\d+))\)', s)      # a name, or a net number in older files
                segs.append((it["id"], far, float(re.search(r"\(width ([\d.]+)\)", s).group(1)), re.search(r'\(layer "([^"]+)"\)', s).group(1),
                             (m.group(1) if m else None) or (nm.group(1) or nm.group(2) if nm else ""), re.sub(r'\s*\(uuid "[^"]*"\)', "", s)))
            if len(segs) != 2 or segs[0][3] != segs[1][3] or segs[0][4] != segs[1][4]:
                continue
            (i1, f1, w1, layer, net, sx1), (i2, f2, w2, _, _, sx2) = segs
            u, w = (f1[0] - x, f1[1] - y), (f2[0] - x, f2[1] - y)
            back = (u[0] * w[0] + u[1] * w[1]) / ((math.hypot(*u) * math.hypot(*w)) or 1) > 0.985   # the track doubles back on itself
            self._edit({"op": "remove", "id": i1}); self._edit({"op": "remove", "id": i2})
            # a doubled-back tip is cut off (one straight run between the far ends); a real bend is laid again through its corner
            cosa = (u[0] * w[0] + u[1] * w[1]) / ((math.hypot(*u) * math.hypot(*w)) or 1)
            if back:
                pts = [[f1[0], f1[1]], [f2[0], f2[1]]]
            elif cosa > 0.2:      # an acute zigzag: go straight from end to end with one 45-degree knee instead
                dx, dy = f2[0] - f1[0], f2[1] - f1[1]; d = min(abs(dx), abs(dy))
                knee = [f1[0] + math.copysign(d, dx), f1[1] + math.copysign(d, dy)]
                pts = [[f1[0], f1[1]], knee, [f2[0], f2[1]]]
            else:
                pts = [[f1[0], f1[1]], [x, y], [f2[0], f2[1]]]
            if math.hypot(f1[0] - f2[0], f1[1] - f2[1]) > 1e-4:      # out and back to the same point is a dead spur: nothing is laid
                # the new path must keep every rule; when it does not (a straightened zigzag through a pad), the two
                # segments go back as they were and the corner is left for a person
                self.flush()
                ok = True
                with contextlib.suppress(Exception):
                    ok = bool(self.fits(net, track=[tuple(q) for q in pts], layer=layer, width=min(w1, w2)).get("fits", True))
                if not ok:
                    self.add_item(sx1); self.add_item(sx2); self.flush()
                    continue
                self._edit({"op": "add_track", "net": net, "layer": layer, "points": pts, "width": min(w1, w2)})
            done += 1
        if done:
            self.flush()
            self.project.note(f"board: cut {done} square track corners into 45-degree bends")
        return done

    def zones(self) -> list:
        """The copper pours, planes and keep-out areas already on the board, one dict each: {"net", "layers", "name", "id" (board.remove(id) takes it off),
        "priority", "box": [x0, y0, x1, y1], "keepout": {what: "allowed"|"not_allowed"} (rule areas only)}.  Read it
        before routing a board somebody else set up: an inner layer that is all one net is a plane, so that net's pins
        drop into it with a via and other signals stay off it."""
        out = []
        for it in self._call("get_items", kinds=["zone"]).get("items", []):
            s = it.get("sexpr", "")
            g = lambda pat: (re.search(pat, s) or [None, None])[1]   # noqa: E731
            net = g(r'\(net_name "((?:[^"\\]|\\.)*)"\)') or g(r'\(net "((?:[^"\\]|\\.)*)"\)') or ""
            lay = re.search(r'\(layers? ((?:"[^"]*"\s*)+)\)', s)
            z = {"net": net, "layers": re.findall(r'"([^"]*)"', lay.group(1)) if lay else [], "name": g(r'\(name "((?:[^"\\]|\\.)*)"\)') or "",
                 "priority": int(g(r"\(priority (\d+)\)") or 0), "id": it.get("id")}
            bb = it.get("bbox")
            try:
                bb = json.loads(bb) if isinstance(bb, str) else bb
                if bb:
                    z["box"] = [round(float(v), 2) for v in bb]
            except (TypeError, ValueError):
                pass
            ko = re.search(r"\(keepout ((?:\(\w+ \w+\)\s*)+)\)", s)
            if ko:
                z["keepout"] = dict(re.findall(r"\((\w+) (\w+)\)", ko.group(1)))
            out.append(z)
        # two pours of different nets over one area of a layer at the same priority: only one fills there, and which is
        # not obvious (an inner layer meant as a supply plane came out ground this way)
        for i, a in enumerate(out):
            for b in out[i + 1:]:
                if a.get("keepout") or b.get("keepout") or a["net"] == b["net"] or a["priority"] != b["priority"] or not a.get("box") or not b.get("box"):
                    continue
                for l in set(a["layers"]) & set(b["layers"]):
                    if _overlap_frac(a["box"], b["box"]) > 0.25:
                        a.setdefault("conflicts", []).append(f'{b["net"]} on {l} at the same priority')
                        b.setdefault("conflicts", []).append(f'{a["net"]} on {l} at the same priority')
        return out

    def _unroute_near(self, near, radius, only: list, keep: tuple) -> int:
        if isinstance(near, str) and "." in near and not any(p["ref"].lower() == near.lower() for p in self.geometry()["parts"]):
            q = self.pad(near)      # one pin: "U1.8"
            cx, cy = q["x"], q["y"]; r = radius if radius is not None else 1.5
        elif isinstance(near, str):
            pads = self.pads(near)
            if not pads:
                raise HarnessError(f"unroute: no part {near} on the board")
            cx = sum(q["x"] for q in pads) / len(pads); cy = sum(q["y"] for q in pads) / len(pads)
            r = radius if radius is not None else max(math.hypot(q["x"] - cx, q["y"] - cy) for q in pads) + 2.5
        else:
            cx, cy = float(near[0]), float(near[1]); r = radius if radius is not None else 3.0
        kept = {self._net(k) for k in keep}
        count, nets = 0, set()
        for net in only or [n for n in self.nets() if n not in kept]:   # by net: a page of kept ground copper never hides the rest
            for _ in range(40):
                got = self._call("get_items", net=net, kinds=["segment", "arc", "via"], near={"x": cx, "y": cy, "radius": r})
                for it in got.get("items", []):
                    self._edit({"op": "remove", "id": it["id"]})
                    count += 1; nets.add(net)
                self.flush()
                if not got.get("truncated") or not got.get("items"):
                    break
        if count:
            self.project.note(f"board: took up {count} tracks and vias of {len(nets)} nets within {r:.1f} mm of {near}")
        return count

    def _net(self, name: str) -> str:
        """A net by the name the schematic gave it: the board calls a sheet's local net "/NAME"."""
        names = self.__dict__.get("_names")
        if names is None or name not in names and "/" + name.lstrip("/") not in names:
            names = self._names = set(self.nets())
        bare = name.lstrip("/")
        hit = name if name in names else "/" + bare if "/" + bare in names else bare if bare in names else None
        if hit is None and bare not in self.project.net_pins:
            self.project.stored_net_pins()
        if hit is None and bare in self.project.net_pins:     # a net wired inside its block: KiCad named it after a pin
            try:
                hit = self.pad(self.project.net_pins[bare])["net"] or None
            except HarnessError:
                hit = None
        return hit or name

    def _house_vias(self) -> str:
        """A board still on KiCad's stock via (0.6 mm on a 0.3 mm hole) gets the house via, 0.5 mm on a 0.2 mm hole,
        before anything is routed: the net class and the board minimums both."""
        r = self.project.transport.call("get_board_info", {}).get("design_rules") or {}
        d = ((r.get("net_classes") or {}).get("Default") or {})
        if abs((d.get("via_diameter") or 0.6) - 0.6) < 1e-6 and abs((d.get("via_drill") or 0.3) - 0.3) < 1e-6:
            from .stackups import DEFAULT_VIA
            self.rules(via_diameter=DEFAULT_VIA[0], via_drill=DEFAULT_VIA[1])
            self.project.note(f"board: vias set to the house size, {DEFAULT_VIA[0]} mm on a {DEFAULT_VIA[1]} mm hole")
            return f"via 0.6/0.3 (KiCad's stock size) changed to the house {DEFAULT_VIA[0]}/{DEFAULT_VIA[1]} mm, net class and board minimums"
        return ""

    def route(self, nets: list | None = None, order: list | None = None, widths: dict | None = None, layers: list | None = None,
              net_options: dict | None = None, keepouts: list | None = None, allow_vias: bool = True, time_s: float | None = None,
              fill: bool = True, max_vias: int | None = None, kinds: dict | None = None, separate=None, fence=None,
              ground_vias: bool = True, fanout_lanes=None, via_cost: float | None = None, groups=None, explain: bool = False,
              keep_rules: bool = False, escapes=None, plan=None, ripup: str | None = None) -> dict:
        """Autoroute the missing connections (every unrouted net by default) and report what was done.

        order: the few nets to lay first (USB pair, crystal); widths: {net: mm} for supply nets; net_options and
        keepouts are passed to the engine as they are.  Route a whole board in one call.
        max_vias: the most vias one pad-to-pad connection may use (2 keeps every track to one trip to the other side).
        groups: {name: [refs]}, the clusters (a chip with the parts that serve it).  The engine lays the critical nets
        first, then wires every cluster inside itself, then power, then the tracks between clusters.  Parts not named
        are grouped from the board (a small part belongs to the nearest chip it shares a net with); False turns the
        cluster-first order off.  The result's `groups` says how many connections lay inside a cluster.
        explain=True adds `explain` to the result: the nets laid first, the clusters with their parts, every connection
        that changed layer (with its length against the straight line) and the longest detours, for checking the
        engine's thinking.
        nets: only these nets' missing connections are routed, and the result's `left_of_asked` says which of them
        are still open.  fill=False skips the zone fill and the clean-up passes after it: a try that takes seconds,
        not minutes (fill and check once at the end).
        time_s: the engine's budget; left out it grows with the board (30 s plus 1.5 s per open connection, 300 at most).
        via_cost: how many millimetres of extra track a via is worth (the engine goes round on the pad's
        own layer before it changes layer); lower it only for a board that cannot route otherwise.

        Signal domains.  The engine tells analog nets (ADC, VREF, crystal, sense, feedback), RF nets (ANT, RF),
        switching nodes (SW, LX), fast nets (clocks, differential pairs) and plain digital ones apart by name, and
        keeps analog and RF tracks away from the rest (except at pads and within 1.2 mm of one).  kinds: {net: "analog" | "rf" | "switching" |
        "fast" | "digital" | "supply"} says what a net is when its name does not.  separate: False turns this off,
        {"quiet": mm, "noisy": mm} sets the gap to digital tracks and to switching / fast ones.
        fence: RF nets get ground vias down both sides of their tracks, and RF, clock and pair nets a ground via beside
        each layer change, wherever ground is poured on two layers.  False turns it off; {"spacing": mm, "nets":
        [...], "return_vias": False} sets the pitch, fences more nets, or drops the return vias.
        The result's `domains` and `ground_vias` say what was kept apart, where the gap had to give, and how many
        vias went in.  Areas nothing may cross (under an antenna, an isolation gap) are `board.keepout(...)`.

        On a board with copper zones the zones are then filled, what the real fill leaves open is routed again
        (twice at most) and the zones are filled once more, so the result counts a pour the way KiCad does.
        `left` is the connections still open at the end, by net.  Net names are the schematic's ("SW" finds "/SW").

        ground_vias: before a whole-board route, the ground pads of small parts (resistors, capacitors, diodes) that
        would hang on the pour alone get their own via to the plane first, so the signal tracks are laid round them
        instead of taking the room (board.ground_pads(max_pads=4)).  False skips it.
        fanout_lanes: each pin of a fine-pitch chip keeps a straight lane this long (mm, 0.25 by default) out from its
        pad that only its own net may use, so neighbours cannot box a pin in; raise it (0.8 to 1.2) when a QFN's pins
        are left "blocked", False turns it off.
        escapes=True escapes the fine-pitch rows that a plain route leaves boxed in, the way Copper's engine runs its
        fan-out: the board is routed once without escapes; where that leaves a connection of a fine-pitch row open
        (a part with a row too tight for two tracks between pins, or 16 pads or more), those rows get a straight stub
        out of each pin, or a 45-degree leg where the stub is blocked, or a via for a pin that must change layer, none
        closing another pin's way out, and the board is routed again from the escapes' ends.  The second result is
        kept only when it leaves fewer connections open (then fewer vias, then less track); a board that routes
        cleanly without escapes comes out unchanged.  A number is how far past the pad the first ring lies (mm);
        {"depth": mm, "spread": 1.5} also tries a fan spreading each row to 1.5 times its pitch first.  The result's
        `fanout` gives the rows escaped, whether that run was kept, the open connections without / with escapes
        (`open`), and the pins that got no escape (`boxed`) with what blocks them.  On by default (a second routing
        run only where pins were left open); escapes=False routes once without.
        plan=True plans every connection on a coarse tile graph first (a global router after Copper's): congestion is
        negotiated over tiles of 0.5 or 1 mm (by the finest pad pitch; PathFinder) whose border capacities come from the
        real free gaps along each border, forced crossings are found, and a layer is assigned along each coarse path.
        The connections the negotiation fought over are laid first and taken up first when a route is blocked, and only
        those it moved off their direct path are steered: their search pays for every mm outside the corridor (its tiles
        and a ring round them) and off the planned layer.  {"mask": True} searches inside the corridor only first,
        falling back to the whole board; {"tile": mm, "iters": n, "outside": cost per mm outside, "layer_cost": cost
        per mm off the planned layer, "vias": True lets a connection the plan sends through a via change layer at once,
        "open": mm, "steer": "moved" | "all" | "none", "order": False, "rip": False} tune it.  The result's `plan` gives
        the overflow before and after negotiation, how many connections it moved and fought over, and how many steered
        routes stayed inside their corridors.  Off by default: it made no board of the benchmark better (Ledify lost
        connections).
        ripup="mincut" changes what the repair after the routing passes takes up to lay a connection left open: the
        cheapest set of routes whose removal opens a way (a minimum cut, after Copper's repair stage), each route priced
        by what laying it again costs (4 mm, more for a wide or critical one), instead of everything the cheapest way
        through runs into.  Only those come up, the open connection is laid, they are laid again, and the board is kept
        only when fewer connections are open; a cut that did not pay is not tried again, and where no cut pays the
        old rule is tried after it.  ripup="near" (the default) is the old rule alone.  Off by default: Cyberboard
        went from 12 to 10 open, but Ledify lost a little (94.9 -> 94.5, one connection left open).
        ripup="ladder" is Copper's whole repair ladder, one rung at a time over every connection still open: rescue
        (the connection alone, with one via above max_vias and without the plan's steering, then on a lattice of half
        the grid pitch, then at the board's minimum track width, then from the other side of its escape; it moves
        nothing else), the min-cut rip above, permutation (the connection and up to four routes fighting for its
        channel, within 12 x 12 mm, come up and are laid in every order, at most 120), and, with plan=True, feedback
        (the tile borders where it failed are booked full and the plan is made again for the connections crossing
        them, at most 12, twice a board).  Each rung is kept only when fewer connections are open and none that was
        routed is open now; otherwise the board goes back exactly.  The result's `ladder` counts what each rung laid.
        
        A board still on KiCad's stock via (0.6 on 0.3 mm) gets the house via (0.5 on 0.2 mm) first, and the result says
        so under "rules_changed"; keep_rules=True leaves the rules exactly as they are (the person said not to touch them).
        """
        house = "" if keep_rules else self._house_vias()
        self.flush()
        fix = self._net
        e: dict = {"op": "autoroute"}
        if nets:
            e["nets"] = [fix(n) for n in nets]
        if order:
            e["order"] = [fix(n) for n in order]
        opts = {fix(k): dict(v) for k, v in (net_options or {}).items()}
        for n, w in (widths or {}).items():
            opts.setdefault(fix(n), {})["width"] = w
        for n, kd in (kinds or {}).items():
            opts.setdefault(fix(n), {})["kind"] = kd
        self.project.stored_net_pins()
        if self.project.net_pins:      # nets wired inside their block have KiCad's automatic names: tell the router what they were called
            known = set(self.nets())
            for name, pin in self.project.net_pins.items():
                if name in known or "/" + name in known:
                    continue
                try:
                    auto = self.pad(pin)["net"]
                except HarnessError:
                    continue
                if auto and "kind" not in opts.get(auto, {}):
                    opts.setdefault(auto, {})["named"] = name
        if opts:
            e["net_options"] = opts
        if layers:
            e["layers"] = list(layers)
        if keepouts:
            e["keepouts"] = keepouts
        if not allow_vias:
            e["allow_vias"] = False
        if not time_s and not nets:      # a dense board needs longer than a breakout: the budget follows the work there is
            try:
                time_s = min(300, 30 + 1.5 * (self.info().get("unrouted_connections") or 0))
            except HarnessError:
                time_s = None
        if time_s:
            e["time_s"] = time_s
        if explain:
            e["explain"] = True
        if groups is False:
            e["groups"] = False
        elif groups:
            e["groups"] = {str(n): list(refs) for n, refs in groups.items()}
        if max_vias is not None:
            e["max_vias"] = max_vias
        if separate is not None:
            e["separate"] = separate
        if fanout_lanes is not None:
            e["fanout_lanes"] = fanout_lanes
        if escapes is not None:
            e["escapes"] = escapes
        if plan is not None:
            e["plan"] = plan
        if ripup is not None:
            e["ripup"] = ripup
        if via_cost is not None:
            e["via_cost"] = via_cost
        if fence is not None:
            e["fence"] = dict(fence, nets=[fix(n) for n in fence["nets"]]) if isinstance(fence, dict) and fence.get("nets") else fence
        pre = None
        if ground_vias and not nets:
            try:
                pre = self.ground_pads(max_pads=4, rounds=6)
            except HarnessError:
                pre = None
        out = self._autoroute(e)
        if pre and pre.get("vias"):
            out["ground_vias_first"] = pre["vias"]
        if fill:
            f = self.fill()
            if f.get("zones"):
                again = {k: v for k, v in e.items() if k != "order"}
                again["time_s"] = min(60, time_s or 60)
                for _ in range(2):
                    if not f.get("unconnected"):
                        break
                    # what the real fill left open is laid with tracks: the engine must not count on the pour again
                    again["zones"] = False
                    open_now = sorted(f.get("unconnected_by_net") or {})
                    if e.get("nets"):      # a call for some nets repairs only those, never the whole board
                        open_now = [n for n in open_now if n in e["nets"]]
                        if not open_now:
                            break
                    again["nets"] = open_now or again.get("nets")
                    if not again["nets"]:
                        again.pop("nets")
                    more = self._autoroute(again)
                    if not more["routed"]:
                        break
                    for k in ("routed", "connections", "segments", "vias"):
                        out[k] = (out[k] or 0) + (more[k] or 0)
                    out["length_mm"] = round((out["length_mm"] or 0) + (more["length_mm"] or 0), 3)
                    out["unrouted"] = more["unrouted"]
                    f = self.fill()
                solid = self.fix_thermals()
                if solid:
                    out["pads_made_solid"] = solid   # a relief the tracks left with too few spokes
                    f = dict(self.fill(), zones=f.get("zones"))
                out["zones_filled"] = f.get("zones")
                out["left"] = f.get("unconnected_by_net") or {}
        if "left" not in out:
            out["left"] = self.unrouted()
        if nets:
            asked = set(e.get("nets") or [])
            out["left_of_asked"] = {k: v for k, v in (out["left"] or {}).items() if k in asked}
        if house:
            out["rules_changed"] = house
        self.project.note(f"board: routed {out['routed']} of {out['connections']} connections, {out['vias']} vias, {out['length_mm']} mm" + (f", {len(out['unrouted'])} left" if out["unrouted"] else ""))
        return out

    def _autoroute(self, e: dict) -> dict:
        """One autoroute edit.  Nothing to route, or nothing that could be routed, is a result and not an error."""
        self.flush()
        dump = os.environ.get("KC_ROUTER_DUMP")      # a folder: keep the board as the router gets it, for router work
        if dump and hasattr(self.project.transport, "save"):
            for f in self.project.transport.save():
                if f.endswith(".kicad_pcb") and hasattr(self.project, "folder"):
                    os.makedirs(dump, exist_ok=True)
                    shutil.copy(os.path.join(self.project.folder, f), os.path.join(dump, os.path.basename(f)))
                    pro = os.path.join(self.project.folder, f[: -len(".kicad_pcb")] + ".kicad_pro")
                    if os.path.exists(pro):
                        shutil.copy(pro, dump)
                    with open(os.path.join(dump, "autoroute.json"), "w") as fh:
                        json.dump(e, fh)
        self._edit(dict(e))
        try:
            res = self.flush() or {}
        except HarnessError as err:
            if "nothing to route" in str(err):
                return {"routed": 0, "connections": 0, "segments": 0, "vias": 0, "length_mm": 0, "unrouted": []}
            if "could not make any" in str(err):
                return {"routed": 0, "connections": None, "segments": 0, "vias": 0, "length_mm": 0, "unrouted": [str(err).split("(autoroute): ")[-1][:400]]}
            raise
        d = next((x["autoroute"] for x in res.get("details") or [] if "autoroute" in x), {})
        un = [f"{u.get('net')}: {u.get('from')} to {u.get('to')} ({u.get('reason') or 'no path'}{': ' + u['detail'] if u.get('detail') else ''})" for u in d.get("unrouted", [])]
        out = {"routed": d.get("routed"), "connections": d.get("connections"), "segments": d.get("segments"), "vias": d.get("vias"), "length_mm": d.get("length_mm"), "unrouted": un[:25]}
        if len(un) > 25:
            out["more_unrouted"] = len(un) - 25
        if d.get("explain"):
            out["explain"] = dict(d["explain"], longest_detours=d.get("longest_detours") or [])
        for k in ("domains", "ground_vias", "groups", "fanout", "plan", "ladder"):
            if d.get(k):
                out[k] = d[k]
        return out

    def layers(self, count: int, planes: list | None = None) -> dict:
        """Set the number of copper layers (2, 4, 6, ...).  Inner layers are In1.Cu, In2.Cu, ...; `planes` names the ones
        that are power planes, for example layers(4, planes=["In1.Cu", "In2.Cu"]) and then zone("GND", "In1.Cu").
        A board that already has that many layers is left as it is ({"changed": False}), so a script can be run again."""
        e: dict = {"op": "set_layers", "count": count}
        if planes:
            e["planes"] = list(planes)
        self.flush()
        self._edit(e)
        try:
            self.flush()
        except HarnessError as err:
            if "already has" not in str(err):
                raise
            return {"layers": count, "changed": False}
        self._geom = None
        return {"layers": count, "changed": True}

    def connect(self, *pads, width: float | None = None, time_s: float | None = None) -> dict:
        """Route the net that joins these pads ("U1.3", "R1.1")."""
        nets = []
        for spec in pads:
            n = self.pad(spec)["net"]
            if not n:
                raise HarnessError(f"{spec} is on no net; connect it in the schematic and sync the board first.")
            if n not in nets:
                nets.append(n)
        if len(nets) > 1:
            raise HarnessError(f"These pads are on different nets ({', '.join(nets)}); a track cannot join them. Change the schematic and sync.")
        return self.route(nets=nets, widths={nets[0]: width} if width else None, time_s=time_s)
