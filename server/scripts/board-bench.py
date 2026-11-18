#!/usr/bin/env python3
"""Board benchmark: the router against hand-routed boards.

Takes a routed board, keeps its placement, outline, zones and rules, takes every track and via off a COPY of it and
lets the harness lay the copper again (board.design(reroute=True)).  The result is scored against the hand routing:
vias (signal and ground apart), track length, open connections, DRC errors, ground pour (share of the board, pieces),
square corners, and net by net where the router used more vias or more track than the person did.  A side-by-side
picture is written next to the numbers.

    python3 scripts/board-bench.py ledify                  # a board named in board-bench.json (cloned into the cache)
    python3 scripts/board-bench.py path/to/board.kicad_pcb # any routed board
    python3 scripts/board-bench.py --all --out /tmp/bench-out
    python3 scripts/board-bench.py ledify --record         # write the scores to board-bench.scores.json (the number to beat)

The original files are never written: every run works on a copy under --work (a temporary folder by default).
Needs `pip install -e server/harness` and the built engine (npm run build:harness).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "board-bench.json")
SCORES = os.path.join(HERE, "board-bench.scores.json")
GROUND = re.compile(r"/?(GND|AGND|DGND|PGND|VSS|GNDA|GNDD|GNDPWR)$", re.I)


# ---------------------------------------------------------------- reading a board file

def sexpr(text: str):
    """A small s-expression reader: lists of strings and lists."""
    tok = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+')
    stack, cur = [], []
    for m in tok.finditer(text):
        t = m.group(0)
        if t == "(":
            stack.append(cur); cur = []
        elif t == ")":
            done = cur; cur = stack.pop(); cur.append(done)
        else:
            cur.append(t[1:-1].replace('\\"', '"') if t[0] == '"' else t)
    return cur[0] if cur else []


def child(node, name):
    return next((c for c in node if isinstance(c, list) and c and c[0] == name), None)


def children(node, name):
    return [c for c in node if isinstance(c, list) and c and c[0] == name]


def area(pts) -> float:
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]; x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def inside(p, pts) -> bool:
    """Point in polygon (even-odd)."""
    x, y = p; c = False; n = len(pts)
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[i - 1]
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / ((y1 - y0) or 1e-12) + x0:
            c = not c
    return c


def copper(path: str) -> dict:
    """Tracks, vias and filled zones of a board file, by net."""
    root = sexpr(open(path, encoding="utf-8").read())
    names = {c[1]: c[2] for c in children(root, "net") if len(c) > 2}

    def net_of(node):
        n = child(node, "net")
        if not n or len(n) < 2:
            return ""
        return names.get(n[1], n[1]) if n[1] in names else n[1]

    nets: dict = {}
    layers: dict = {}
    segs = []
    for kind in ("segment", "arc"):
        for s in children(root, kind):
            a, b = child(s, "start"), child(s, "end")
            ln = math.hypot(float(a[1]) - float(b[1]), float(a[2]) - float(b[2]))
            if kind == "arc":
                m = child(s, "mid")
                ln = math.hypot(float(a[1]) - float(m[1]), float(a[2]) - float(m[2])) + math.hypot(float(m[1]) - float(b[1]), float(m[2]) - float(b[2]))
            net, layer = net_of(s), (child(s, "layer") or [0, "?"])[1]
            d = nets.setdefault(net, {"length": 0.0, "vias": 0, "segments": 0})
            d["length"] += ln; d["segments"] += 1
            layers[layer] = layers.get(layer, 0.0) + ln
            if kind == "segment":
                segs.append((net, layer, float(a[1]), float(a[2]), float(b[1]), float(b[2]), float((child(s, "width") or [0, 0.2])[1])))
    sizes: dict = {}
    cover: dict = {}      # net -> (x, y, r) of its pads and vias: a bend under them is hidden in copper
    holes: dict = {}      # net -> vias and pads (x, y, reach): what ties a pour piece to the rest of its net
    for f in children(root, "footprint"):
        at = child(f, "at") or [0, 0, 0]
        fx, fy, fr = float(at[1]), float(at[2]), math.radians(float(at[3]) if len(at) > 3 else 0.0)
        for pd in children(f, "pad"):
            if len(pd) < 3 or pd[2] not in ("thru_hole", "smd"):
                continue
            pa = child(pd, "at") or [0, 0, 0]
            px, py = float(pa[1]), float(pa[2])
            gx, gy = fx + px * math.cos(fr) + py * math.sin(fr), fy - px * math.sin(fr) + py * math.cos(fr)
            sz = child(pd, "size") or [0, 1, 1]
            # a thermal's spokes land within reach; an SMD pad of the net ties the piece through its own track
            holes.setdefault(net_of(pd), []).append((gx, gy, max(float(sz[1]), float(sz[-1])) / 2 + (0.7 if pd[2] == "thru_hole" else 0.3)))
            cover.setdefault(net_of(pd), []).append((gx, gy, min(float(sz[1]), float(sz[-1])) / 2))
    for v in children(root, "via"):
        net = net_of(v)
        a = child(v, "at")
        if a:
            holes.setdefault(net, []).append((float(a[1]), float(a[2]), float((child(v, "size") or [0, 0.5])[1]) / 2 + 0.5))
            cover.setdefault(net, []).append((float(a[1]), float(a[2]), float((child(v, "size") or [0, 0.5])[1]) / 2))
        nets.setdefault(net, {"length": 0.0, "vias": 0, "segments": 0})["vias"] += 1
        k = f"{(child(v, 'size') or [0, '?'])[1]}/{(child(v, 'drill') or [0, '?'])[1]}"
        sizes[k] = sizes.get(k, 0) + 1
    pour: dict = {}
    for z in children(root, "zone"):
        if child(z, "keepout"):
            continue
        net = net_of(z) or (child(z, "net_name") or [0, ""])[1]
        for fp in children(z, "filled_polygon"):
            layer = (child(fp, "layer") or [0, "?"])[1]
            pts = [(float(p[1]), float(p[2])) for p in children(child(fp, "pts") or [], "xy")]
            d = pour.setdefault((net, layer), {"area": 0.0, "pieces": 0, "islands": 0})
            d["area"] += area(pts); d["pieces"] += 1
            if not any(inside(h[:2], pts) or any(math.hypot(q[0] - h[0], q[1] - h[1]) < h[2] for q in pts) for h in holes.get(net, [])):     # a piece with no via or plated pad of its own: an island
                d["islands"] += 1
                d.setdefault("island_at", []).append((round(sum(q[0] for q in pts) / len(pts), 2), round(sum(q[1] for q in pts) / len(pts), 2), round(area(pts), 2)))
    # square corners: two segments of one net and layer that meet end to end at 90 degrees or sharper
    ends: dict = {}
    for i, (net, layer, x0, y0, x1, y1, w) in enumerate(segs):
        for (x, y, ox, oy) in ((x0, y0, x1, y1), (x1, y1, x0, y0)):
            ends.setdefault((net, layer, round(x, 3), round(y, 3)), []).append((ox - x, oy - y, w))
    # a bend under a pad or via of the net is hidden in copper: not a corner (as the harness's check counts it)
    square = 0
    for (net, _layer, x, y), dirs in ends.items():
        if len(dirs) != 2 or any(math.hypot(x - cx, y - cy) <= cr for (cx, cy, cr) in cover.get(net, [])):
            continue
        (ax, ay, wa), (bx, by, wb) = dirs
        la, lb = math.hypot(ax, ay), math.hypot(bx, by)
        short = max(0.15, wa, wb)      # a jog shorter than the track is wide is a pad hook-up, not a corner anyone sees
        if la > short and lb > short and (ax * bx + ay * by) / (la * lb) > -0.05:      # the two legs leave at <= ~93 degrees
            square += 1
    return {"nets": nets, "layers": layers, "via_sizes": sizes, "pour": pour, "square_corners": square}


def is_ground(net: str) -> bool:
    return bool(GROUND.search(net or ""))


SUPPLY = re.compile(r"/?(.*/)?([+-]?\d+(V\d*|\.\d+V)\w*|(VCC|VDD|VBUS|VBAT|VIN|VSYS|VPP|VAA|VOUT|PWR|\+BATT)\w*|\w+_VCC)$", re.I)


def is_power(net: str, poured=()) -> bool:
    """A supply: a rail by its name, or any net that has a copper zone of its own (its vias go to a plane)."""
    return not is_ground(net) and (net in poured or bool(SUPPLY.match(net or "")))


# ---------------------------------------------------------------- scoring

def measure(folder: str, board_file: str, refill: bool = True) -> dict:
    """The numbers of the board in `folder`, with its zones filled by the engine so both sides are counted alike."""
    import kicad_harness as kh
    p = kh.open(folder)
    b = p.board()
    fill = {}
    if refill:
        try:
            fill = b.fill()
        except Exception as e:      # noqa: BLE001
            fill = {"error": str(e)[:120]}
    info = b.info()
    chk = b.check(limit=4, refill=False)
    left = b.unrouted()
    try:
        rv = b.brief()
    except Exception as e:      # noqa: BLE001
        rv = {"errors": None, "warnings": None, "findings": [str(e)[:120]]}
    p.save(force=True)
    p.close()
    c = copper(board_file)
    board_area = (info.get("size_mm") or {}).get("area_mm2") or 0
    gv = sum(d["vias"] for n, d in c["nets"].items() if is_ground(n))
    tv = sum(d["vias"] for d in c["nets"].values())
    poured = {net for (net, _layer) in c["pour"]}
    pv = sum(d["vias"] for n, d in c["nets"].items() if is_power(n, poured))
    pour = {}
    for (net, layer), d in sorted(c["pour"].items()):
        if is_ground(net):
            pour[layer] = {"percent": round(100 * d["area"] / board_area, 1) if board_area else None, "pieces": d["pieces"], "islands": d["islands"]}
    by_kind = {k: v for k, v in (chk.get("by_kind") or {}).items()}
    return {
        "vias": tv, "signal_vias": tv - gv - pv, "power_vias": pv, "ground_vias": gv, "via_sizes": c["via_sizes"],
        "track_mm": round(sum(d["length"] for d in c["nets"].values()), 1),
        "track_by_layer_mm": {k: round(v, 1) for k, v in sorted(c["layers"].items())},
        "unrouted": sum(left.values()), "unrouted_by_net": left,
        "drc_errors": chk.get("errors"), "drc_by_kind": by_kind,
        "copper_errors": sum(v for k, v in by_kind.items() if k in ("clearance", "shorting_items", "copper_edge_clearance", "hole_clearance", "tracks_crossing", "track_dangling", "via_dangling")),
        "ground_pour": pour, "pour_islands": fill.get("islands"),
        "square_corners": c["square_corners"],
        "review": {"errors": rv.get("errors"), "warnings": rv.get("warnings")},
        "findings": [f for f in rv.get("findings", []) if f.startswith("error ")][:8],
        "signal_mm": round(sum(d["length"] for n, d in c["nets"].items() if not is_ground(n) and not is_power(n, poured)), 1),
        "nets": {n: {"vias": d["vias"], "mm": round(d["length"], 2)} for n, d in c["nets"].items()},
    }


def rules_as_routed(folders: list) -> dict:
    """A hand-routed board is the rule: where its own tracks run closer than its net class says (a 0.2 mm class on a
    0.4 mm pitch chip routed at 0.1 mm), the copies are judged, and routed, at the clearance the person really kept.
    Returns {} when the board keeps its own rules, else {"clearance": mm, "was_violations": n}."""
    import kicad_harness as kh
    p = kh.open(folders[0])
    try:
        got = [float(m.group(1)) for v in p.board()._call("run_checks").get("violations", []) if v.get("code") == "clearance"
               for m in [re.search(r"actual ([\d.]+)", v.get("message", ""))] if m and float(m.group(1)) > 0.02]
    finally:
        p.close()
    # the via the person used most is the via the copy routes with (Cyberboard: 0.45 mm vias round a 0.4 mm pitch QFN
    # on a board whose net class still says KiCad's stock 0.6/0.3)
    pcb = next((os.path.join(folders[0], n) for n in os.listdir(folders[0]) if n.endswith(".kicad_pcb")), None)
    sizes = copper(pcb)["via_sizes"] if pcb else {}
    via = None
    if sizes:
        k = max(sizes, key=sizes.get)
        try:
            via = tuple(float(x) for x in k.split("/"))
        except ValueError:
            via = None
    if not got and not via:
        return {}
    clr = max(0.08, math.floor(min(got) * 100 + 1e-6) / 100) if got else None
    for f in folders:
        p = kh.open(f)
        kw = {**({"clearance": clr} if clr else {}), **({"via_diameter": via[0], "via_drill": via[1]} if via else {})}
        p.board().rules(**kw)
        p.save(force=True); p.close()
    return {**({"clearance": clr, "was_violations": len(got)} if clr else {}), **({"via": f"{via[0]}/{via[1]}"} if via else {})}


def differences(hand: dict, auto: dict) -> dict:
    """Net by net, where the router did worse than the person: more vias, or much more track."""
    more_vias, longer, shorter = [], [], []
    for n, a in auto["nets"].items():
        h = hand["nets"].get(n, {"vias": 0, "mm": 0})
        if is_ground(n):
            continue
        if a["vias"] > h["vias"]:
            more_vias.append((a["vias"] - h["vias"], n, h["vias"], a["vias"]))
        if h["mm"] > 1 and a["mm"] > h["mm"] * 1.3 + 1:
            longer.append((round(a["mm"] - h["mm"], 1), n, h["mm"], a["mm"]))
        if h["mm"] > 1 and a["mm"] < h["mm"] * 0.75 - 1:
            shorter.append((round(h["mm"] - a["mm"], 1), n, h["mm"], a["mm"]))
    fmt_v = lambda r: f"{r[1]}: {r[2]} by hand, {r[3]} routed"      # noqa: E731
    fmt_l = lambda r: f"{r[1]}: {r[2]} mm by hand, {r[3]} mm routed"      # noqa: E731
    return {"more_vias": [fmt_v(r) for r in sorted(more_vias, reverse=True)[:12]],
            "longer": [fmt_l(r) for r in sorted(longer, reverse=True)[:12]],
            "shorter": [fmt_l(r) for r in sorted(shorter, reverse=True)[:6]]}


def verdict(hand: dict, auto: dict) -> dict:
    """One number, 100 = as good as the hand routing on every count, and the worst count by name."""
    def ratio(h, a, floor=1.0):      # how much worse the router is: 1.0 = equal, 2.0 = twice as much
        return max(a, floor) / max(h, floor)
    hp = sum((v["percent"] or 0) for v in hand["ground_pour"].values()) or 0
    ap = sum((v["percent"] or 0) for v in auto["ground_pour"].values()) or 0
    # a pour piece with a via or plated pad of its net in it is tied in (the person: "just add a ground via"); only islands count
    hisl = sum(v.get("islands", 0) for v in hand["ground_pour"].values())
    aisl = sum(v.get("islands", 0) for v in auto["ground_pour"].values())
    parts = {
        "unrouted": 100 if auto["unrouted"] <= hand["unrouted"] else max(0, 100 - 20 * (auto["unrouted"] - hand["unrouted"])),
        "drc": 100 if auto["copper_errors"] <= hand["copper_errors"] else max(0, 100 - 10 * (auto["copper_errors"] - hand["copper_errors"])),
        "signal_vias": round(min(100, 100 / ratio(hand["signal_vias"], auto["signal_vias"], 4))),
        "track_length": round(min(100, 100 / ratio(hand["track_mm"], auto["track_mm"]) ** 2)),
        "pour_coverage": round(min(100, 100 * ap / hp)) if hp else 100,
        "pour_pieces": 100 if aisl <= hisl else max(0, 100 - 10 * (aisl - hisl)),
        "square_corners": 100 if auto["square_corners"] <= hand["square_corners"] else max(0, 100 - 5 * (auto["square_corners"] - hand["square_corners"])),
    }
    weights = {"unrouted": 3, "drc": 3, "signal_vias": 2, "track_length": 1.5, "pour_coverage": 1, "pour_pieces": 1, "square_corners": 0.5}
    score = sum(parts[k] * w for k, w in weights.items()) / sum(weights.values())
    worst = min(parts, key=lambda k: (parts[k], -weights[k]))
    return {"score": round(score, 1), "parts": parts, "worst": worst}


# ---------------------------------------------------------------- pictures

def picture(svgs: list, titles: list, out_png: str, stacked: bool = False) -> bool:
    """The drawings side by side in one PNG (headless Chromium through Playwright, when it is installed)."""
    html = os.path.splitext(out_png)[0] + ".html"
    cells = "".join(f'<figure><figcaption>{t}</figcaption><img src="file://{os.path.abspath(s)}"></figure>' for s, t in zip(svgs, titles))
    with open(html, "w", encoding="utf-8") as f:
        f.write('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111113;color:#eee;font:15px system-ui;display:flex;gap:12px;padding:12px' + (";flex-direction:column" if stacked else "") + '}'
                'figure{margin:0;flex:1;min-width:0}figcaption{padding:4px 2px 8px}img{width:100%;height:auto;display:block;background:#001023}</style>' + cells)
    js = ("let pw;try{pw=require('playwright')}catch(e){pw=require('/opt/node-tools/node_modules/playwright')}"
          "(async()=>{const b=await pw.chromium.launch();const p=await b.newPage({viewport:{width:%d,height:200},deviceScaleFactor:2});"
          "await p.goto('file://'+process.argv[1]);await p.waitForTimeout(500);await p.screenshot({path:process.argv[2],fullPage:true});await b.close()})()"
          % (1400 if stacked else 900 * len(svgs)))
    try:
        subprocess.run(["node", "-e", js, os.path.abspath(html), os.path.abspath(out_png)], check=True, timeout=180, capture_output=True)
        return True
    except Exception as e:      # noqa: BLE001
        print(f"  (no picture: {str(e)[:200]})", file=sys.stderr)
        return False


def draw(folder: str, svg: str) -> None:
    import kicad_harness as kh
    p = kh.open(folder)
    try:
        p.board().svg(svg)
    finally:
        p.close()


# ---------------------------------------------------------------- one board

def copy_project(pcb: str, dest: str) -> str:
    """Copy the board with its project, rules and schematic files into dest; returns the copied board's path."""
    os.makedirs(dest, exist_ok=True)
    src = os.path.dirname(os.path.abspath(pcb)); stem = os.path.splitext(os.path.basename(pcb))[0]
    for name in os.listdir(src):
        full = os.path.join(src, name)
        if os.path.isfile(full) and (name.startswith(stem + ".") and name.rsplit(".", 1)[-1] in ("kicad_pcb", "kicad_pro", "kicad_sch", "kicad_dru", "kicad_prl")
                                     or name in ("fp-lib-table", "sym-lib-table") or name.endswith(".kicad_sch")):
            shutil.copy(full, os.path.join(dest, name))
    return os.path.join(dest, stem + ".kicad_pcb")


def fetch(name: str, cache: str) -> str:
    entry = json.load(open(MANIFEST))["boards"][name]
    repo = os.path.join(cache, name)
    if not os.path.isdir(repo):
        os.makedirs(cache, exist_ok=True)
        subprocess.run(["git", "clone", "--depth", "1", entry["repo"], repo], check=True, capture_output=True)
    return os.path.join(repo, entry["board"])


def strip(name: str, pcb: str, dest: str) -> str:
    """A copy of the board with every track and via taken off, for an AI to route (--strip); returns the folder."""
    import kicad_harness as kh
    shutil.rmtree(dest, ignore_errors=True)
    copy_project(pcb, dest)
    rules_as_routed([dest])      # the clearance the person really routed at, as the scored copies get
    p = kh.open(dest); b = p.board(); b.unroute(keep=()); p.save(force=True); p.close()
    return dest


def bench(name: str, pcb: str, work: str, out: str, time_s: float | None, design: dict, routed: str | None = None) -> dict:
    """Route a stripped copy with board.design() and score it; with `routed` (a folder an AI routed from a --strip
    copy) score that folder as it is instead."""
    import kicad_harness as kh
    hand_dir, auto_dir = os.path.join(work, name, "hand"), os.path.join(work, name, "routed")
    for d in (hand_dir, auto_dir):
        shutil.rmtree(d, ignore_errors=True)
    hand_pcb = copy_project(pcb, hand_dir)
    if routed:
        shutil.copytree(routed, auto_dir)
        auto_pcb = os.path.join(auto_dir, os.path.basename(hand_pcb))
    else:
        auto_pcb = copy_project(pcb, auto_dir)
    relaxed = rules_as_routed([hand_dir, auto_dir])
    hand = measure(hand_dir, hand_pcb)
    t0 = time.time()
    res: dict = {}
    if not routed:
        p = kh.open(auto_dir)
        b = p.board()
        if not time_s:      # a benchmark may take its time: three seconds of budget per connection, a quarter of an hour at most
            b.unroute(keep=())
            time_s = min(900, 30 + 3 * (b.info().get("unrouted_connections") or 0))
        res = b.design(reroute=True, time_s=time_s, explain=True, **design)
        p.save(force=True); p.close()
    secs = round(time.time() - t0, 1)
    auto = measure(auto_dir, auto_pcb)
    v = verdict(hand, auto)
    result = {"board": name, "score": v["score"], "worst": v["worst"], "parts": v["parts"], "seconds": secs,
              "hand": {k: x for k, x in hand.items() if k != "nets"}, "routed": {k: x for k, x in auto.items() if k != "nets"},
              "differences": differences(hand, auto), "rules_as_routed": relaxed,
              "design": {k: res.get(k) for k in ("routed", "added", "skipped", "refused", "notes", "variants", "gated") if res.get(k)}}
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    with open(os.path.join(out, f"{name}-reasoning.txt"), "w", encoding="utf-8") as f:      # where each part stands and why, the routing order, every via and detour
        f.write("\n".join(res.get("reasoning") or ["(no reasoning returned)"]) + "\n")
    shutil.copy(auto_pcb, os.path.join(out, f"{name}-routed.kicad_pcb"))
    try:
        svgs = [os.path.join(out, f"{name}-hand.svg"), os.path.join(out, f"{name}-routed.svg")]
        draw(hand_dir, svgs[0]); draw(auto_dir, svgs[1])
        m = re.search(r'viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"', open(svgs[0], encoding="utf-8").read(4000))
        wide = bool(m) and float(m.group(1)) > 1.4 * float(m.group(2))      # a wide board: one above the other
        cap = lambda t, m: f"{name}: {t} &middot; {m['signal_vias']} signal vias, {m['power_vias']} power, {m['ground_vias']} ground, {m['track_mm']} mm, {m['unrouted']} open, {m['copper_errors']} copper errors"      # noqa: E731
        if picture(svgs, [cap("by hand", hand), cap(f"router (score {v['score']})", auto)], os.path.join(out, f"{name}.png"), stacked=wide):
            result["picture"] = os.path.join(out, f"{name}.png")
    except Exception as e:      # noqa: BLE001
        print(f"  (no picture: {str(e)[:200]})", file=sys.stderr)
    return result


def table(r: dict) -> str:
    h, a = r["hand"], r["routed"]
    pour = lambda m: ", ".join(f"{l} {v['percent']}% in {v['pieces']} ({v.get('islands', 0)} unstitched)" for l, v in m["ground_pour"].items()) or "none"      # noqa: E731
    rows = [("signal vias", h["signal_vias"], a["signal_vias"]), ("power vias", h["power_vias"], a["power_vias"]), ("ground vias", h["ground_vias"], a["ground_vias"]),
            ("track length mm", h["track_mm"], a["track_mm"]), ("open connections", h["unrouted"], a["unrouted"]),
            ("copper DRC errors", h["copper_errors"], a["copper_errors"]), ("all DRC errors", h["drc_errors"], a["drc_errors"]),
            ("square corners", h["square_corners"], a["square_corners"]), ("review errors", h["review"]["errors"], a["review"]["errors"]),
            ("ground pour", pour(h), pour(a))]
    lines = [f"{r['board']}: score {r['score']} (worst: {r['worst']}), routed in {r['seconds']} s", f"  {'':20}{'by hand':>14}  {'router':>14}"]
    lines += [f"  {n:20}{str(x):>14}  {str(y):>14}" for n, x, y in rows]
    lines.append("  parts: " + ", ".join(f"{k} {v}" for k, v in r["parts"].items()))
    if r.get("rules_as_routed"):
        ra = r["rules_as_routed"]
        if ra.get("clearance"):
            lines.append(f"  judged at the clearance the hand routing keeps: {ra['clearance']} mm (its own net class is broken {ra['was_violations']} times)")
        if ra.get("via"):
            lines.append(f"  routed with the via the hand routing uses most: {ra['via']} mm")
    for k, title in (("more_vias", "more vias than by hand"), ("longer", "longer than by hand")):
        if r["differences"][k]:
            lines.append(f"  {title}: " + "; ".join(r["differences"][k][:6]))
    if r["design"].get("refused"):
        lines.append("  refused: " + "; ".join(x[:140] for x in r["design"]["refused"][:4]))
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("boards", nargs="*", help="names from board-bench.json or paths to .kicad_pcb files")
    ap.add_argument("--all", action="store_true", help="every board in board-bench.json")
    ap.add_argument("--out", default=None, help="where the numbers, routed boards and pictures go (default: <work>/out)")
    ap.add_argument("--work", default=None, help="scratch folder for the copies (default: a temporary folder)")
    ap.add_argument("--cache", default=os.path.join(os.path.expanduser("~"), ".cache", "junction-board-bench"), help="where the boards are cloned")
    ap.add_argument("--design", default=None, help="JSON of extra board.design() options, e.g. '{\"plan\": true, \"ripup\": \"mincut\"}'")
    ap.add_argument("--time", type=float, default=None, help="seconds the router may take per pass")
    ap.add_argument("--record", action="store_true", help="store the scores in board-bench.scores.json (board-bench.ai-scores.json with --score)")
    ap.add_argument("--strip", default=None, help="only write a copy of each board with its copper taken off into <dir>/<board>, for an AI to route")
    ap.add_argument("--score", default=None, help="score the boards an AI routed in <dir>/<board> (from --strip) instead of routing them here")
    args = ap.parse_args()
    manifest = json.load(open(MANIFEST))["boards"]
    names = list(manifest) if args.all else args.boards
    if not names:
        ap.error("name a board or pass --all")
    work = args.work or tempfile.mkdtemp(prefix="board-bench-")
    out = args.out or os.path.join(work, "out")
    scores = SCORES.replace(".scores.json", ".ai-scores.json") if args.score else SCORES
    known = json.load(open(scores)) if os.path.exists(scores) else {}
    worse = 0
    for n in names:
        if n.endswith(".kicad_pcb"):
            pcb, name, design = n, os.path.splitext(os.path.basename(n))[0], {}
        else:
            pcb, name, design = fetch(n, args.cache), n, dict(manifest[n].get("design") or {})
        if args.design:
            design.update(json.loads(args.design))
        if args.strip:
            print(f"{name}: stripped copy in {strip(name, pcb, os.path.join(args.strip, name))}")
            continue
        r = bench(name, pcb, work, out, args.time, design, routed=os.path.join(args.score, name) if args.score else None)
        print(table(r))
        was = (known.get(name) or {}).get("score")
        if was is not None:
            print(f"  to beat: {was}  ->  {'better' if r['score'] > was else 'same' if r['score'] == was else 'WORSE'} ({r['score'] - was:+.1f})")
            worse += r["score"] < was - 0.5
        if args.record:
            known[name] = {"score": r["score"], "parts": r["parts"],
                           "hand": {k: r["hand"][k] for k in ("signal_vias", "power_vias", "ground_vias", "track_mm", "unrouted", "copper_errors", "square_corners", "ground_pour")},
                           "routed": {k: r["routed"][k] for k in ("signal_vias", "power_vias", "ground_vias", "track_mm", "unrouted", "copper_errors", "square_corners", "ground_pour")}}
            with open(scores, "w", encoding="utf-8") as f:
                json.dump(known, f, indent=1, sort_keys=True); f.write("\n")
    print(f"results in {out}")
    return 1 if worse else 0


if __name__ == "__main__":
    sys.exit(main())
