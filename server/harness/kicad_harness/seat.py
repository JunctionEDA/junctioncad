"""Small parts in front of the pins they serve.

A resistor, capacitor, inductor or diode with two pads that hangs on one pin of a chip or a connector (a pull-down on a
USB-C CC pin, a pull-up on a bus line, a series resistor, the parts of a matching network) belongs directly in front
of that pin: its pad on the pin's net facing the pin, straight out from it, and its other end pointing to where its
other net goes (a ground end to the connector's own ground pins at the ends of the row).  The track between them is
then a millimetre of straight copper and nothing else has to cross it.  A crystal is turned and put so that each of
its pads faces its own oscillator pin and the two tracks neither cross each other nor pass over the crystal's ground
pads: a via on a crystal net that a quarter turn would have saved is a placement fault, not a routing one.

`board.seat()` does this after the placement engine has put the blocks down (`board.autoplace` calls it), and
`board.seating()` measures it on any board: that is what `board.design()` refuses a layout on.
"""
from __future__ import annotations

import math
import re

from .transport import HarnessError

_SMALL = re.compile(r"^(R|C|L|FB|D|RN)\d", re.I)
_RAIL = re.compile(r"^\+|^V?\d+V\d*$|^V(CC|DD|SS|BUS|BAT|IN|SYS|IO|REF|PP|DDA|CCA|DDIO|CCIO)\w*$|^PWR", re.I)
_CRYSTAL = re.compile(r"crystal|xtal|resonator", re.I)
_ANTENNA = re.compile(r"antenna", re.I)

# what `seating()` calls a fault, in millimetres
LIMITS = {
    "serve": 3.0,        # pad of a pin-serving part to its pin, centre to centre
    "serve_pull": 6.0,   # ... of a pull-up or pull-down to a supply, which only has to be on the net
    "serve_note": 2.5,
    "crystal": 5.0,      # crystal pad to its oscillator pin
    "match": 4.0,        # first part of a matching network to the radio pin
    "feed": 12.0,        # the whole way from the radio pin to the antenna, when the board cannot give 50 ohm
}


def _bare(n: str) -> str:
    return (n or "").split("/")[-1]


def _gnd(n: str) -> bool:
    return _bare(n).upper().startswith(("GND", "AGND", "DGND", "PGND", "VSS", "EARTH"))


def _turn(ox: float, oy: float, deg: float):
    a = math.radians(deg)
    return ox * math.cos(a) + oy * math.sin(a), -ox * math.sin(a) + oy * math.cos(a)


def _seg_hits(box, a, b) -> bool:
    x0, y0, x1, y1 = box[:4]; t0, t1 = 0.0, 1.0; dx, dy = b[0] - a[0], b[1] - a[1]
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


def _seg_dist(p, a, b) -> float:
    vx, vy = b[0] - a[0], b[1] - a[1]; L = vx * vx + vy * vy
    t = 0 if L < 1e-12 else max(0, min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L))
    return math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy)


def _cross(a, b, c, d) -> bool:
    o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return o(a, b, c) * o(a, b, d) < -1e-9 and o(c, d, a) * o(c, d, b) < -1e-9


class _Survey:
    """The board as the seating rules see it."""

    def __init__(self, board):
        g = board.geometry()
        self.parts = g["parts"]; self.outline = g.get("outline")
        self.by_ref = {p["ref"]: p for p in self.parts}
        self.boxes = {r: b[:4] for r, b in board.courtyards().items()}
        self.net: dict = {}
        for p in self.parts:
            for q in p["pads"]:
                if q[3]:
                    self.net.setdefault(q[3], []).append((p, q))
        self.centre = {}
        for p in self.parts:
            xs = [q[1] for q in p["pads"]] or [p["x"]]; ys = [q[2] for q in p["pads"]] or [p["y"]]
            self.centre[p["ref"]] = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)

    def rail(self, n: str) -> bool:
        return not n or n.startswith("unconnected-") or _gnd(n) or bool(_RAIL.search(_bare(n))) or len(self.net.get(n, ())) > 6

    def big(self, p) -> bool:
        return len(p["pads"]) >= 3 and not self.crystal(p)

    def small(self, p) -> bool:
        return len(p["pads"]) == 2 and bool(_SMALL.match(p["ref"])) and not self.antenna(p)

    def crystal(self, p) -> bool:
        return (bool(re.match(r"^(Y|XTAL)\d", p["ref"], re.I)) or bool(_CRYSTAL.search(p.get("footprint", "") + " " + str(p.get("value", ""))))) and 2 <= len(p["pads"]) <= 6

    def antenna(self, p) -> bool:
        text = p.get("footprint", "") + " " + str(p.get("value", ""))
        if re.search(r"NFC|RFID|13\.56|\bQI\b|WPC|LOOP", text, re.I):      # a near-field coil, not a radiating antenna
            return False
        return bool(re.match(r"^(AE|ANT)\d", p["ref"], re.I)) or bool(_ANTENNA.search(text))

    def out_of(self, part, pad):
        """(row direction, outward direction) of a pad on its part: the row is towards its nearest neighbour pad, outward
        is square to it, away from the part's middle (towards the middle of the board for a single row)."""
        others = [q for q in part["pads"] if q is not pad and (abs(q[1] - pad[1]) > 0.05 or abs(q[2] - pad[2]) > 0.05)]
        if others:
            n = min(others, key=lambda q: math.hypot(q[1] - pad[1], q[2] - pad[2]))
            row = (1.0, 0.0) if abs(n[1] - pad[1]) >= abs(n[2] - pad[2]) else (0.0, 1.0)
        else:
            row = (1.0, 0.0)
        cx, cy = self.centre[part["ref"]]; out = (-row[1], row[0]) if row[0] else (1.0, 0.0)
        off = (pad[1] - cx) * out[0] + (pad[2] - cy) * out[1]
        if abs(off) < 0.3:      # a single row of pins (a header): out is towards the rest of the board
            box = self.boxes.get(part["ref"]); bx, by = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) if box else (cx, cy)
            off = (pad[1] - bx) * out[0] + (pad[2] - by) * out[1]      # the courtyard's middle (a USB-C body lies behind its pad row)
            if abs(off) < 0.3 and self.outline:
                off = ((self.outline[0] + self.outline[2]) / 2 - pad[1]) * out[0] + ((self.outline[1] + self.outline[3]) / 2 - pad[2]) * out[1]
        if off < 0:
            out = (-out[0], -out[1])
        return row, out

    def jobs(self):
        """What serves what: [{"ref", "hot": pad index, "pins": [(part, pad)], "why"}] for the two-pad parts, in the order
        they are seated (a part that hangs on another small part comes after it)."""
        first, later = [], []
        for p in self.parts:
            if not self.small(p):
                continue
            a, b = p["pads"][0][3], p["pads"][1][3]
            spec = [i for i, n in enumerate((a, b)) if not self.rail(n)]
            if not spec:
                continue
            cands = []
            for i in spec:
                n = p["pads"][i][3]
                pins = [(o, q) for o, q in self.net.get(n, []) if o is not p and self.big(o)]
                if pins:
                    cands.append((max(len(o["pads"]) for o, _ in pins), -len(self.net[n]), i, pins))
            series = len(spec) == 2
            beside = [o for i in spec for o, _ in self.net.get(p["pads"][i][3], []) if o is not p and self.small(o) and not any(self.rail(z[3]) for z in o["pads"])]
            if cands and not (not series and beside):
                cands.sort(key=lambda c: (c[0], c[1]), reverse=True)
                pins = sorted(cands[0][3], key=lambda c: -len(c[0]["pads"]))      # the chip's pin before a header's
                first.append({"ref": p["ref"], "hot": cands[0][2], "pins": pins, "series": series})
            else:      # its partner is another small part: the shunt of a matching network, a filter's second part
                later.append({"ref": p["ref"], "hot": None, "spec": spec})
        return first, later


BAND = 1.2      # mm of whole ground kept beside an antenna's clear area


def _band(S: _Survey, b) -> tuple:
    """An antenna's clear area (2 mm round it, out to a board edge within 3 mm) and the ground band beside it."""
    box = [b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2]; ol = S.outline
    if ol:
        box = [ol[0] if box[0] - ol[0] < 3 else box[0], ol[1] if box[1] - ol[1] < 3 else box[1], ol[2] if ol[2] - box[2] < 3 else box[2], ol[3] if ol[3] - box[3] < 3 else box[3]]
    return (box[0] - BAND, box[1] - BAND, box[2] + BAND, box[3] + BAND)


def _ways(S: _Survey, anchor, skip_nets) -> list:
    """The way each signal pin of a part takes out of it and on to its partner, as line pieces, and the spot in front
    of each supply pin of a chip."""
    ways = []
    for q in anchor["pads"]:
        n = q[3] or ""
        if not n or n in skip_nets or _gnd(n) or n.startswith("unconnected-"):
            continue
        _, out = S.out_of(anchor, q)
        if S.rail(n):      # a supply pin: the spot in front of it is its bypass capacitor's
            if len(anchor["pads"]) >= 8 and not re.match(r"^(J|P|CN|USB|X)\d", anchor["ref"], re.I):
                ways.append([(q[1], q[2]), (q[1] + 1.3 * out[0], q[2] + 1.3 * out[1])])
            continue
        o = (q[1] + 2 * out[0], q[2] + 2 * out[1])
        t = [(u[1], u[2]) for p, u in S.net.get(n, []) if p is not anchor]
        way = [(q[1], q[2]), o]
        if t:
            way.append(min(t, key=lambda u: math.hypot(u[0] - o[0], u[1] - o[1])))
        ways.append(way)
    return ways


def _free(S: _Survey, box, taken, margin: float = 0.3) -> bool:
    ol = S.outline
    if ol and (box[0] < ol[0] + margin or box[1] < ol[1] + margin or box[2] > ol[2] - margin or box[3] > ol[3] - margin):
        return False
    return not any(min(box[2], t[2]) - max(box[0], t[0]) > 1e-6 and min(box[3], t[3]) - max(box[1], t[1]) > 1e-6 for t in taken)


def _seat(self, refs=None, reach: float | None = None, apply: bool = True, skip=(), giveway=()) -> dict:
    """Put every two-pad part that serves one pin directly in front of that pin, and turn every crystal to its
    oscillator pins.  The part's pad on the pin's net faces the pin, straight out from it; its other end points to where
    its other net goes (a pull-down's ground end to the connector's own ground pins, a pull-up's supply end to the
    supply pin).  A part whose only partner is another small part (the second shunt of a matching network) is put
    against that part, so a chain stays in line.  Bypass capacitors are not touched (board.place_bypass), nor are parts
    in `skip` or parts whose net already has tracks.  `refs` limits it to those parts; apply=False only reports.

    Returns {ref: {"pin": "J1.A5", "at": (x, y), "rotation": deg, "mm": pad to pin}} and, for a part that found no
    place within `reach` mm (by default the 3 mm seating() accepts), {ref: {"pin", "left": why}}."""
    if reach is None:      # the distance seating() and design()'s gate accept, so a spot seat() reports is one they pass
        reach = LIMITS["serve"]
    self.flush(); self._geom = None
    S = _Survey(self); out: dict = {}
    want = {str(r).lower() for r in ([refs] if isinstance(refs, str) else refs)} if refs else None
    held = {str(r).lower() for r in skip}
    routed: dict = {}

    def has_tracks(n: str) -> bool:
        if n not in routed:
            routed[n] = bool((self._call("get_items", net=n, kinds=["segment"]) or {}).get("items"))
        return routed[n]

    def movable(p) -> bool:
        return p["ref"].lower() not in held and (want is None or p["ref"].lower() in want) and not any(q[3] and not S.rail(q[3]) and has_tracks(q[3]) for q in p["pads"])

    radio = set(_radio(self))
    first, later = S.jobs()
    pending = {j["ref"] for j in first + later if movable(S.by_ref[j["ref"]])}      # still to be seated: they do not hold their old spots
    pending |= {str(r) for r in giveway}      # parts that are placed after this pass (the bypass capacitors) do not hold their spots either
    taken = {r: tuple(b) for r, b in S.boxes.items() if r not in pending}
    for a in S.parts:      # nothing is seated in an antenna's clear area: 2 mm round it, out to the board edge
        if S.antenna(a) and a["ref"] in S.boxes:
            b = S.boxes[a["ref"]]; box = [b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2]; ol = S.outline
            if ol:
                box = [ol[0] if box[0] - ol[0] < 3 else box[0], ol[1] if box[1] - ol[1] < 3 else box[1], ol[2] if ol[2] - box[2] < 3 else box[2], ol[3] if ol[3] - box[3] < 3 else box[3]]
            taken["~" + a["ref"]] = tuple(box)
            taken["~~" + a["ref"]] = _band(S, b)      # and a band of whole ground beside it, which only the matching network may stand in
    pos = {p["ref"]: {q[0]: (q[1], q[2]) for q in p["pads"]} for p in S.parts}      # pad positions as seated so far

    def put(p, x, y, rot, box):
        rot0 = p.get("rotation") or 0
        turn = (rot - rot0) % 360
        for q in p["pads"]:
            dx, dy = _turn(q[1] - p["x"], q[2] - p["y"], turn)
            pos[p["ref"]][q[0]] = (x + dx, y + dy)
        taken[p["ref"]] = box
        if apply and (abs(x - p["x"]) > 1e-3 or abs(y - p["y"]) > 1e-3 or turn):
            self.place(p["ref"], (round(x, 3), round(y, 3)), rotation=rot)

    def search(p, hot_i, pins, lines_extra=(), far_hint=None):
        """Best spot for two-pad part p with its pad hot_i at one of `pins` [(anchor part or None, (x, y), row, out, name, ways)]."""
        b = S.boxes[p["ref"]]; w, h = b[2] - b[0], b[3] - b[1]; rot0 = p.get("rotation") or 0
        hot, far = p["pads"][hot_i], p["pads"][1 - hot_i]
        bx, by = (b[0] + b[2]) / 2 - p["x"], (b[1] + b[3]) / 2 - p["y"]      # the courtyard's middle from the part's origin
        others = [t for r, t in taken.items() if r != p["ref"] and not (r.startswith("~~") and p["ref"] in radio)]; best = None
        for anchor, at, row, outd, name, ways, far_at in pins:
            for turn in (0, 90, 180, 270):
                px, py = _turn(hot[1] - p["x"], hot[2] - p["y"], turn); fx, fy = _turn(far[1] - p["x"], far[2] - p["y"], turn)
                cx, cy = _turn(bx, by, turn); hw, hh = (w / 2, h / 2) if turn % 180 == 0 else (h / 2, w / 2)
                steps = int(reach / 0.1)
                for i in range(1, steps + 1):
                    f = i * 0.1
                    for j in range(-steps, steps + 1):
                        lat = j * 0.1
                        if math.hypot(f, lat) > reach:
                            continue
                        hx, hy = at[0] + f * outd[0] + lat * row[0], at[1] + f * outd[1] + lat * row[1]
                        cost = math.hypot(f, lat) + 2.0 * abs(lat)
                        if best and cost >= best[0]:
                            continue
                        x, y = hx - px, hy - py
                        fa = (x + fx, y + fy)
                        if far_at:
                            cost += 0.35 * min(math.hypot(fa[0] - far_at[0], fa[1] - far_at[1]), 12)
                        else:      # nothing to point at: the far end goes on outwards, in line
                            cost += 0.35 * (2 - ((fa[0] - hx) * outd[0] + (fa[1] - hy) * outd[1]))
                        if best and cost >= best[0]:
                            continue
                        box = (x + cx - hw, y + cy - hh, x + cx + hw, y + cy + hh)
                        if not _free(S, box, others):
                            continue
                        wide = (box[0] - 0.3, box[1] - 0.3, box[2] + 0.3, box[3] + 0.3)
                        cost += 4 * sum(1 for wy in ways if any(_seg_hits(wide, wy[m], wy[m + 1]) for m in range(len(wy) - 1)))
                        if best is None or cost < best[0]:
                            best = (cost, x, y, (rot0 + turn) % 360, box, math.hypot(hx - at[0], hy - at[1]), name)
        return best

    def far_target(p, hot_i, anchor, at):
        n = p["pads"][1 - hot_i][3]
        if not n or n.startswith("unconnected-"):
            return None
        own = [pos[anchor["ref"]][q[0]] for q in anchor["pads"] if q[3] == n] if anchor else []
        if own:
            return min(own, key=lambda u: math.hypot(u[0] - at[0], u[1] - at[1]))
        if S.rail(n):
            return None
        rest = [pos[o["ref"]][q[0]] for o, q in S.net.get(n, []) if o is not p]
        return min(rest, key=lambda u: math.hypot(u[0] - at[0], u[1] - at[1])) if rest else None

    def crystals():
        for y in S.parts:
            if not S.crystal(y) or not movable(y):
                continue
            sig = [(q, [(o, u) for o, u in S.net.get(q[3], []) if o is not y and S.big(o)]) for q in y["pads"] if q[3] and not _gnd(q[3])]
            sig = [(q, pins[0]) for q, pins in sig if pins]
            if len(sig) < 1:
                continue
            anchor = sig[0][1][0]; b = S.boxes[y["ref"]]; w, h = b[2] - b[0], b[3] - b[1]; rot0 = y.get("rotation") or 0
            bx, by = (b[0] + b[2]) / 2 - y["x"], (b[1] + b[3]) / 2 - y["y"]
            tx = sum(pos[o["ref"]][u[0]][0] for _, (o, u) in sig) / len(sig); ty = sum(pos[o["ref"]][u[0]][1] for _, (o, u) in sig) / len(sig)
            ways = _ways(S, anchor, {q[3] for q, _ in sig}); others = [t for r, t in taken.items() if r != y["ref"]]; best = None
            k = int(5.0 / 0.1)
            for turn in (0, 90, 180, 270):
                padat = {q[0]: _turn(q[1] - y["x"], q[2] - y["y"], turn) for q in y["pads"]}
                cx, cy = _turn(bx, by, turn); hw, hh = (w / 2, h / 2) if turn % 180 == 0 else (h / 2, w / 2)
                for i in range(-k, k + 1):
                    for j in range(-k, k + 1):
                        x, y0 = tx + i * 0.1, ty + j * 0.1
                        lines = [((x + padat[q[0]][0], y0 + padat[q[0]][1]), pos[o["ref"]][u[0]]) for q, (o, u) in sig]
                        cost = sum(math.hypot(a[0] - c[0], a[1] - c[1]) for a, c in lines)
                        if best and cost >= best[0]:
                            continue
                        box = (x + cx - hw, y0 + cy - hh, x + cx + hw, y0 + cy + hh)
                        if not _free(S, box, others):
                            continue
                        if len(lines) > 1 and _cross(lines[0][0], lines[0][1], lines[1][0], lines[1][1]):
                            cost += 6
                        for (a, c), (q, _) in zip(lines, sig):      # a track to one pad does not run over another pad of the crystal
                            for z in y["pads"]:
                                if z[0] != q[0] and _seg_dist((x + padat[z[0]][0], y0 + padat[z[0]][1]), a, c) < 0.45:
                                    cost += 4
                        wide = (box[0] - 0.2, box[1] - 0.2, box[2] + 0.2, box[3] + 0.2)
                        cost += 4 * sum(1 for wy in ways if any(_seg_hits(wide, wy[m], wy[m + 1]) for m in range(len(wy) - 1)))
                        if best is None or cost < best[0]:
                            best = (cost, x, y0, (rot0 + turn) % 360, box, max(math.hypot(a[0] - c[0], a[1] - c[1]) for a, c in lines))
            name = f"{anchor['ref']}.{sig[0][1][1][0]}"
            if best is None:
                out[y["ref"]] = {"pin": name, "left": "no free spot beside its oscillator pins"}
                continue
            put(y, best[1], best[2], best[3], best[4])
            out[y["ref"]] = {"pin": name, "at": (round(best[1], 3), round(best[2], 3)), "rotation": best[3], "mm": round(best[5], 2)}

    # ---- then every part that hangs on a pin, and after those the parts that hang on them
    order = sorted(first, key=lambda j: (not j.get("series"), -max(len(o["pads"]) for o, _ in j["pins"]), j["ref"]))
    seated = set(); did_crystals = False
    for job in order + [None]:
        if not did_crystals and (job is None or not job.get("series")):      # series parts (a radio's feed) first, then the crystals, then the rest
            crystals(); did_crystals = True
        if job is None:
            break
        p = S.by_ref[job["ref"]]
        if p["ref"] not in pending:
            seated.add(p["ref"]); continue
        if p["ref"] in out:
            continue
        hot_net = p["pads"][job["hot"]][3]; pins = []
        for anchor, q in job["pins"]:
            at = pos[anchor["ref"]][q[0]]; row, outd = S.out_of(anchor, q)
            if anchor["ref"] in taken and anchor.get("rotation") is not None and (abs(at[0] - q[1]) > 1e-6 or abs(at[1] - q[2]) > 1e-6):
                continue      # the anchor itself was moved in this pass: leave its parts to the next call
            pins.append((anchor, at, row, outd, f"{anchor['ref']}.{q[0]}", _ways(S, anchor, {hot_net}), far_target(p, job["hot"], anchor, at)))
        lead = [c for c in pins if c[0] is pins[0][0]] if pins else []
        best = (search(p, job["hot"], lead) or search(p, job["hot"], pins)) if pins else None
        if best is None:
            out[p["ref"]] = {"pin": f"{job['pins'][0][0]['ref']}.{job['pins'][0][1][0]}", "left": f"no free spot within {reach} mm of the pin"}
            taken[p["ref"]] = tuple(S.boxes[p["ref"]]); continue
        put(p, best[1], best[2], best[3], best[4]); seated.add(p["ref"])
        out[p["ref"]] = {"pin": best[6], "at": (round(best[1], 3), round(best[2], 3)), "rotation": best[3], "mm": round(best[5], 2)}
    for _ in range(3):
        again = []
        for job in later:
            p = S.by_ref[job["ref"]]
            if p["ref"] not in pending:
                continue
            pins = []
            for i in job["spec"]:
                n = p["pads"][i][3]
                for o, q in S.net.get(n, []):
                    if o is p or o["ref"] not in seated:
                        continue
                    at = pos[o["ref"]][q[0]]; oth = next(u for u in o["pads"] if u is not q); oat = pos[o["ref"]][oth[0]]
                    d = math.hypot(at[0] - oat[0], at[1] - oat[1]) or 1.0
                    along = ((at[0] - oat[0]) / d, (at[1] - oat[1]) / d)      # the direction the seated part points in
                    # a shunt stands square to the part it hangs on, on either side of it
                    for outd in ((-along[1], along[0]), (along[1], -along[0])):
                        pins.append((i, (o, at, along, outd, f"{o['ref']}.{q[0]}", [], far_target(p, i, None, at))))
            best = None
            for i in {i for i, _ in pins}:
                b = search(p, i, [c for k, c in pins if k == i])
                if b and (best is None or b[0] < best[0]):
                    best = b
            if best is None:
                again.append(job); continue
            put(p, best[1], best[2], best[3], best[4]); seated.add(p["ref"])
            out[p["ref"]] = {"pin": best[6], "at": (round(best[1], 3), round(best[2], 3)), "rotation": best[3], "mm": round(best[5], 2)}
        if len(again) == len(later):
            break
        later = again
    if apply and out:
        self.flush(); self._geom = None
        self.project.note(f"board: {len([v for v in out.values() if 'at' in v])} parts seated at their pins" + (f", {len([v for v in out.values() if 'left' in v])} found no room" if any('left' in v for v in out.values()) else ""))
    return out


def _settle(self, skip=(), reach: float = 6.0) -> dict:
    """Clear what is left standing on something else: a two-pad part whose courtyard overlaps another part's, or lies
    in an antenna's clear area or off the board, moves to the nearest free spot (parts in `skip` stay, and of two
    small parts the one named later moves).  Returns {ref: (x, y)} for the parts moved and {ref: None} for a part
    that found no room within `reach` mm: the board is too small or too full there."""
    self.flush(); self._geom = None
    S = _Survey(self); held = {str(r).lower() for r in skip}; out: dict = {}
    taken = {r: tuple(b) for r, b in S.boxes.items()}; radio = set(_radio(self))
    for a in S.parts:
        if S.antenna(a) and a["ref"] in S.boxes:
            b = S.boxes[a["ref"]]; taken["~" + a["ref"]] = (b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2)
            taken["~~" + a["ref"]] = _band(S, b)
    small = [p for p in S.parts if len(p["pads"]) == 2 and p["ref"].lower() not in held and not S.antenna(p)]
    for p in sorted(small, key=lambda p: p["ref"], reverse=True):
        b = taken[p["ref"]]; others = [t for r, t in taken.items() if r != p["ref"] and not (r.startswith("~~") and p["ref"] in radio)]
        if _free(S, b, others):
            continue
        w, h = b[2] - b[0], b[3] - b[1]; cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2; best = None
        k = int(reach / 0.25)
        for i in range(-k, k + 1):
            for j in range(-k, k + 1):
                d = math.hypot(i, j) * 0.25
                if d > reach or (best and d >= best[0]):
                    continue
                box = (cx + i * 0.25 - w / 2, cy + j * 0.25 - h / 2, cx + i * 0.25 + w / 2, cy + j * 0.25 + h / 2)
                if _free(S, box, others):
                    best = (d, i * 0.25, j * 0.25, box)
        if best is None:
            out[p["ref"]] = None
            continue
        taken[p["ref"]] = best[3]; out[p["ref"]] = (round(p["x"] + best[1], 3), round(p["y"] + best[2], 3))
        self.place(p["ref"], out[p["ref"]])
    if out:
        self.flush(); self._geom = None
    return out


def _hangers(self) -> list:
    """The two-pad parts that hang on another small part (the shunts of a matching network or a filter): they are not
    bypass capacitors, whatever their ground pad suggests."""
    S = _Survey(self)
    return [j["ref"] for j in S.jobs()[1]]


def _serving(self) -> list:
    """Every two-pad part seat() would place."""
    S = _Survey(self); first, later = S.jobs()
    return [j["ref"] for j in first + later]


def _radio(self) -> list:
    """The small parts between an antenna and its radio pin: the series parts of the matching network and the shunts
    that hang on it."""
    S = _Survey(self); out: list = []
    for a in S.parts:
        if not S.antenna(a):
            continue
        nets = [q[3] for q in a["pads"] if q[3] and not _gnd(q[3]) and not q[3].startswith("unconnected-")]
        for n in nets:      # grows while the walk goes through series parts
            for o, u in S.net.get(n, []):
                if not S.small(o) or o["ref"] in out:
                    continue
                out.append(o["ref"])
                for q in o["pads"]:
                    if q[3] and q[3] not in nets and not S.rail(q[3]) and len(nets) < 8:
                        nets.append(q[3])
    return out


def _seating(self) -> dict:
    """Measure what `seat()` arranges, on the board as it is: {"errors": n, "findings": [one line each]}.

    An error is a layout nobody should be shown: a part off the board, a pin-serving part more than 3 mm from its pin,
    a crystal more than 4 mm from its oscillator pins or with a via on its nets, a matching network away from the
    radio pin, an antenna feed that is neither short nor 50 ohm, or a via on a CC or crystal net.  design() refuses a
    layout while this lists errors."""
    self.flush(); self._geom = None
    S = _Survey(self); errs: list = []; notes: list = []
    ol = S.outline
    if ol:
        off = [r for r, b in S.boxes.items() if (b[0] + b[2]) / 2 < ol[0] or (b[0] + b[2]) / 2 > ol[2] or (b[1] + b[3]) / 2 < ol[1] or (b[1] + b[3]) / 2 > ol[3]]
        if off:
            errs.append(f"error placement.outside: {len(off)} parts are not on the board. Every part must be placed inside the outline (board.autoplace() places all of them; make the outline larger if they do not fit). [{'; '.join(sorted(off))}]")
    vias: dict = {}

    def via_count(n: str) -> int:
        if n not in vias:
            vias[n] = len((self._call("get_items", net=n, kinds=["via"]) or {}).get("items") or [])
        return vias[n]

    first, later = S.jobs(); far, near = [], []
    for job in first:
        p = S.by_ref[job["ref"]]; hot = p["pads"][job["hot"]]
        d, name = min((math.hypot(hot[1] - q[1], hot[2] - q[2]), f"{o['ref']}.{q[0]}") for o, q in job["pins"])
        other = p["pads"][1 - job["hot"]][3]; conn = any(re.match(r"^(J|P|CN|USB)\d", o["ref"], re.I) for o, _ in job["pins"])
        # a pull-up only has to be on its net, and a capacitor to ground is a bypass capacitor whatever its net is called
        # (the review's bypass.near measures those)
        loose = (S.rail(other) and not _gnd(other)) or (_gnd(other) and re.match(r"^C\d", p["ref"], re.I) and not conn)
        if d > (LIMITS["serve_pull"] if loose else LIMITS["serve"]):
            far.append(f"{p['ref']} is {round(d, 1)} mm from {name}")
        elif d > LIMITS["serve_note"]:
            near.append(f"{p['ref']} is {round(d, 1)} mm from {name}")
        if re.search(r"(^|[-_(])CC[12]?\b", _bare(hot[3]), re.I) and via_count(hot[3]):
            errs.append(f"error usb.cc: {_bare(hot[3])} has a via. A CC pull-down stands in front of its CC pin with its ground end towards the connector's ground pins, and the track between them is a straight millimetre on the top layer (board.seat(\"{p['ref']}\"), then route the net again). [{p['ref']}]")
    if far:
        errs.append("error serve.near: A part that serves one pin belongs directly in front of that pin, its other end pointing to where its other net goes: a pull-down at its connector pin, a pull-up or series resistor at its chip pin (board.seat() puts them there; make room first if it reports none). [" + "; ".join(far) + "]")
    if near:
        notes.append("note serve.near: These could sit closer to the pin they serve (board.seat()). [" + "; ".join(near) + "]")
    for y in S.parts:
        if not S.crystal(y):
            continue
        for q in y["pads"]:
            if not q[3] or _gnd(q[3]):
                continue
            pins = [u for o, u in S.net.get(q[3], []) if o is not y and S.big(o)]
            if not pins:
                continue
            d = min(math.hypot(q[1] - u[1], q[2] - u[2]) for u in pins)
            if d > LIMITS["crystal"]:
                errs.append(f"error crystal.near: {y['ref']} pad {q[0]} is {round(d, 1)} mm from its oscillator pin. A crystal sits against the chip, turned so each pad faces its own pin (board.seat(\"{y['ref']}\")). [{y['ref']}]")
            if via_count(q[3]):
                errs.append(f"error crystal.vias: {_bare(q[3])} changes layer. Turn the crystal so its pads face the oscillator pins in the same order (board.seat(\"{y['ref']}\")) and route the two nets again on the top layer: a via there is a placement fault. [{y['ref']}]")
    # the radio: chip pin, matching parts in line next to it, a short way to the antenna
    for a in S.parts:
        if not S.antenna(a):
            continue
        for q in a["pads"]:
            n = q[3]
            if not n or _gnd(n) or n.startswith("unconnected-"):
                continue
            chain = [n]; seen = {a["ref"]}; pin = None; series = []
            for _ in range(6):      # walk the feed back through the series parts to the chip
                here = chain[-1]
                pads = [(o, u) for o, u in S.net.get(here, []) if o["ref"] not in seen]
                chip = next(((o, u) for o, u in pads if S.big(o)), None)
                if chip:
                    pin = chip; break
                nxt = next(((o, u) for o, u in pads if S.small(o) and not _gnd(next(z for z in o["pads"] if z is not u)[3])), None)
                if not nxt:
                    break
                seen.add(nxt[0]["ref"]); series.append(nxt[0]); chain.append(next(z for z in nxt[0]["pads"] if z is not nxt[1])[3])
            if not pin:
                continue
            direct = math.hypot(pin[1][1] - q[1], pin[1][2] - q[2])
            if series:
                first_part = series[-1]; d = min(math.hypot(z[1] - pin[1][1], z[2] - pin[1][2]) for z in first_part["pads"])
                if d > LIMITS["match"]:
                    errs.append(f"error rf.match: {first_part['ref']} is {round(d, 1)} mm from {pin[0]['ref']}.{pin[1][0]}. The matching network stands in line directly at the radio pin, series part first and each shunt square to it with its ground end out (board.seat()). [{first_part['ref']}]")
            if any(via_count(c) for c in chain):
                errs.append(f"error rf.feed: the antenna feed of {a['ref']} changes layer. It runs on the top layer only, from the radio pin through the matching parts to the antenna. [{'; '.join(_bare(c) for c in chain)}]")
            if direct > LIMITS["feed"]:
                errs.append(f"error rf.feed: {a['ref']} is {round(direct, 1)} mm from {pin[0]['ref']}.{pin[1][0]}. Bring the chip to the antenna, radio pin towards it (board.autoplace(near={{\"{pin[0]['ref']}\": \"{a['ref']}\"}}) or fixed=), so the feed is a short straight line: this board cannot give it 50 ohm over a long run. [{a['ref']}; {pin[0]['ref']}]")
    return {"errors": len(errs), "findings": errs + notes}


def install(Board) -> None:
    Board.seat = _seat
    Board.seating = _seating
    Board._hangers = _hangers
    Board._serving = _serving
    Board._radio = _radio
    Board.settle = _settle
