"""The whole board in one call, and a review that costs few tokens.

`board.design(...)` runs a layout in the order a careful designer works (Phil's Lab's board walk-throughs, and the
order of work in server/docs/pcb-design-rules.md): plan from the netlist, stackup, placement by how critical each
part is, ground on every layer that carries it, antenna keep-outs, routing with the critical nets first and the
supplies last, the copper the physics still owes (fences, thermal vias, a via for every ground pad, stitching),
clean-up, silkscreen, and the review.  It only calls what the harness already has, with the defaults a board should
get, and hands back one short result, so a model does not carry the rules or nine results in its context.

`board.brief()` is the review as one line per finding: the rule, the first sentence and the items.
"""
from __future__ import annotations

import contextlib
import math
import re

from .transport import HarnessError

# what a four-layer board's inner layers carry: signal / ground / ground / signal keeps a tight, unbroken reference
# under both routing layers and gives every via a return path one layer away
INNER_GROUND = ("In1.Cu", "In2.Cu")


def _short(row: str, items: int = 6) -> str:
    """A review finding as one line: "level rule: first sentence. [items]"."""
    head, _, rest = row.partition(": ")
    text, _, tail = rest.partition(" [")
    first = text.split(". ")[0].rstrip(".")
    if tail:
        parts = tail.rstrip("]").split("; ")
        tail = " [" + "; ".join(parts[:items]) + (f"; and {len(parts) - items} more" if len(parts) > items else "") + "]"
    return f"{head}: {first}.{tail}"


def _brief(self, level: str | None = "warning", limit: int = 12, rule: str | None = None) -> dict:
    """The review in as few words as it takes: {"errors", "warnings", "notes", "findings": [one line each]}.  The full
    text of one finding, with the call that fixes it, is board.review(rule="vias.slot")."""
    rv = self.review(level=level, rule=rule, limit=limit)
    return {"errors": rv["errors"], "warnings": rv["warnings"], "notes": rv["notes"], "findings": [_short(f) for f in rv["findings"]]}


def _design(self, outline=None, fab: str = "jlcpcb", layers: int | None = None, edge: str = "top", edges: dict | None = None, near: dict | None = None,
            groups: dict | None = None, fixed: dict | None = None, rotations: dict | None = None, swap: dict | None = None, fit: bool | None = None,
            order: list | None = None, widths: dict | None = None, kinds: dict | None = None, time_s: float | None = None, max_vias: int = 2,
            stitch: float | None = 2.0, name: str | bool | None = None, rev: str | None = None, silk: bool = True, place: bool = True, route: bool = True,
            accept: list | None = None, reroute: bool = False, explain: bool = False, fanout: bool = False,
            free_pins: bool = True, keep_rules: bool = False, gate: bool = True, keepouts: list | None = None, escapes=None, plan=None, ripup: str | None = None) -> dict:
    """Lay the whole board out in one call and say how it came out.

    gate=True (the default): every repair stage after the routing (clean-up, ground pads, last route, finish again,
    stitch removal, corners) is kept only if it leaves no more connections open and no more rules errors; a stage taken
    back is listed under "gated".

    keep_rules=True never touches the design rules (no house via either), for a person who said not to change them;
    otherwise any change is listed under "rules_changed".  layers=["F.Cu", "B.Cu", ...] names the routing layers (an
    inner ground plane left whole costs open connections on a dense board: measured 9 to 12 on Cyberboard, 13 to 29
    on Ember); a number is how many copper layers the board should have.

    keepouts=[{"box": [x0, y0, x1, y1], "layers": [...]}] holds the first routing pass out of areas: no via in the box,
    and no track on the named layers (all when none named).  For a fine-pitch chip routed the owner's way: a box round
    it with layers=[every layer but the chip's own], so its escapes leave as buses on its layer and change layer only
    outside; the later passes may go in again to finish what is left.

    explain=True adds "reasoning": a list of plain lines saying where every part stands and why (its cluster, the
    pin it serves, how far from it), which parts belong to no cluster, the order the nets were routed in and why,
    and every connection that changed layer, wandered or stayed open, with the cause.  Use it when the person wants
    to check the thinking behind a layout; read it for the line that is wrong and fix that step.

    free_pins=True (the default): connections still open at the end because earlier tracks boxed a pin in are freed one
    pin at a time (board.free_pins); a try that does not help is taken back.  It stops starting new pins after twice
    time_s (at least two minutes), so the whole call stays within about four times time_s.

    fanout=True escapes every fine-pitch chip (20 pins or more, 0.65 mm pitch or finer) to a staggered ring of vias
    before routing (board.fanout): for a dense QFN whose pins are left open because neighbouring tracks box them in.
    fanout={"U4": [nets]} drops only those pins to a via straight out (radial, rows staggered), the way the person's
    boards do it: name the pins whose other end lies behind the chip or across the other escapes.

    escapes (on by default, board.route(escapes=...)): each routing pass is routed once without escapes; where that
    leaves pins of a fine-pitch row open, those rows get Copper's analytic escapes (each connected pin leaves on its
    own layer as a stub, a 45-degree leg or a via where its net must change layer, closing no other pin's way out)
    and the pass is routed again from them, kept only when fewer connections are left open (Cyberboard 11 -> 9 open;
    Ledify, whose chips escape anyway, comes out unchanged).  escapes=False routes once without.

    plan=True plans every connection on a coarse tile graph before each routing pass (board.route(plan=...)): congestion
    negotiated over the tiles, forced crossings found, layers assigned along each coarse path; the connections it fought
    over are laid and taken up first, and those it moved off their direct path are steered into their corridors and
    onto the planned layers.  On by default in design() (plan=False turns it off); board.route() leaves it off.

    ripup="mincut" takes up only the cheapest set of routes in an open connection's way when the router repairs what
    its passes left open (a minimum cut, after Copper), and keeps the result only when fewer are open (board.route).
    ripup="ladder" runs Copper's whole repair ladder on what is left open: rescue (one extra via, half pitch, neck
    width, the other escape side; it moves nothing else), the min-cut rip, permutation of the routes fighting for the
    channel, and, with plan=True, feedback into the plan; each rung kept only when fewer are open and nothing routed
    is lost (board.route).  The result's routed.ladder counts what each rung laid.  design() uses the ladder by default.
    With gate=True (the default) and plan or ripup given, the board is routed both plainly and with them and the
    better of the two stays (fewer open, then fewer errors): out["variants"] says which won.  It costs a second route.

    reroute=True lays only the copper again on a board somebody placed: every track and via comes up, and the parts,
    the outline, the zones, the rules, the stackup and the silkscreen stay exactly as they are (no sync from the
    schematic either; only a board still on KiCad's stock 0.6/0.3 mm via gets the house 0.5/0.2 mm via, which the
    result's notes say).  It is how scripts/board-bench.py scores the router against a hand-routed board.

    outline: (x0, y0, x1, y1), the largest the board may be (fit=True, the default when an outline is given, pulls it in
    round the parts); leave it out to keep the outline the board has.  edges: {ref: "left"|"right"|"top"|"bottom"} for
    the connectors; near, groups, fixed, rotations go to autoplace on top of what the plan works out; swap: {"U1":
    [nets]} lets those nets trade pins on that chip so they leave side by side (board.swap_pins).  order, widths and
    kinds add to the plan's routing order, widths and net kinds.  place=False keeps the placement, route=False stops
    before routing.  A step that cannot run is listed under "skipped" with the reason and the rest still runs.

    Returns {"size_mm", "layers", "placed", "routed": {"routed", "connections", "vias", "length_mm", "left"},
    "added": {ground vias, fences, thermal vias, stitching}, "drc": {"errors", "by_kind"}, "review": {"errors",
    "warnings", "findings": [one line each]}, "notes": [what the plan could not do], "skipped": {step: why}}.
    Fix what "review" and "left" name and call the single step again; do not run design() twice on one board.

    The result is judged before anyone sees it.  "refused" lists what makes the layout unacceptable: a part off the
    board or on another part, a pin-serving part or crystal away from its pin, a via on a crystal or CC net, a matching
    network away from the radio pin, an open connection, a DRC error, a review error.  While it is not empty the script
    fails at its end and every edit is taken back (a dry run reports it instead), so work in a dry run until "refused"
    is gone.  accept=["rf.feed"] waives the named rules, only for a fault the person has agreed to live with."""
    out: dict = {"skipped": {}}
    import time as _time
    t_start = _time.time(); secs: dict = {}

    def step(what, fn):
        t0 = _time.time()
        try:
            return fn()
        except HarnessError as e:
            out["skipped"][what] = str(e).split("\n")[0][:200]
            return None
        finally:
            secs[what] = round(secs.get(what, 0) + _time.time() - t0, 1)

    def standing():
        """(open connections, rules errors other than open ones) with the pours filled: what a stage is judged by."""
        with contextlib.suppress(HarnessError):
            self.fill()
        by = (self.check(limit=0, refill=False) or {}).get("by_kind") or {}
        return (int(self.info().get("unrouted_connections") or 0), sum(v for k, v in by.items() if k != "unconnected_items"))

    def gated(what, fn):
        """Keep-best (as Copper's engine gates every stage): the stage's copper stays only when it leaves no more
        connections open and, at the same count, no more rules errors; otherwise every track and via goes back."""
        if not gate:
            return step(what, fn)
        before = standing()
        with self.trial() as t:
            res = step(what, fn)
            after = standing()
            t.keep = after[0] < before[0] or (after[0] == before[0] and after[1] <= before[1])
        if not t.keep:
            out.setdefault("gated", {})[what] = f"taken back: open {before[0]} -> {after[0]}, errors {before[1]} -> {after[1]}"
            return None
        return res

    if reroute:
        place, silk, outline = False, False, None
        step("take up", lambda: self.unroute(keep=()))
        base = step("drc before", lambda: self.check(limit=0))     # what the parts and rules bring with them: not the routing's doing
        before = {k: v for k, v in ((base or {}).get("by_kind") or {}).items() if k != "unconnected_items"}
    else:
        before = {}
        step("sync", self.sync)
    if outline:
        self.outline(*outline, radius=0 if place else 1.0)      # square while the placement may still pull it in; rounded after
    global_plan = plan      # the router's global plan option; `plan` below is the board's layout plan
    if gate and global_plan is None:      # on by default: with the gate the board is also routed without it and the better run stays
        global_plan = True
    if gate and ripup is None:
        ripup = "ladder"
    plan = step("plan", lambda: self.plan(edge=edge)) or {"place": {"near": {}, "edges": {}}, "route": {}, "notes": []}
    out["notes"] = [n.split(". ")[0] for n in plan.get("notes", [])][:6]
    rec = dict((plan.get("stackup") or {}).get("recommended") or {})
    all_layers = layers == "all"
    route_layers = list(layers) if isinstance(layers, (list, tuple)) else None
    if route_layers or all_layers:
        layers = None
    if layers:
        rec["layers"] = layers
    have_layers = len(self.info().get("copper_layers") or [])
    want = int(rec.get("layers") or have_layers or 2)
    if not layers and want < have_layers:       # never take copper layers off a board unless the caller asked for fewer
        want = rec["layers"] = have_layers
    if want > len(self.info().get("copper_layers") or []) and not reroute:
        step("layers", lambda: self.layers(want, planes=list(INNER_GROUND) if want >= 4 else None))
    if not reroute:
        step("stackup", lambda: self.stackup(fab=fab, rules=not keep_rules, **rec))
    if place:
        # a board laid out before is laid out again from its parts: its old copper comes up first, so a second run of
        # the script needs no board.clear() (what comes out the same is left alone when the plan is drawn)
        def take_up():
            n = self.unroute(keep=())
            for z in self._call("get_items", kinds=["zone"]).get("items", []):      # the pours and keep-outs are drawn again for the new placement
                self._edit({"op": "remove", "id": z["id"]}); n += 1
            self.flush()
            return n
        step("take up", take_up)
        kw = {"groups": groups, "near": {**plan["place"].get("near", {}), **(near or {})}, "edges": {**plan["place"].get("edges", {}), **(edges or {})},
              "fixed": fixed, "rotations": rotations, "fit": bool(outline) if fit is None else fit}
        if outline:
            kw["outline"] = tuple(outline)
        placed = step("place", lambda: self.autoplace(**kw))
        if "place" in out["skipped"]:      # routing an old placement wastes the whole run: stop here and say why
            raise HarnessError("design: placement failed, nothing was routed: " + out["skipped"]["place"])
        if placed:
            sc = placed.get("score") or {}
            out["placed"] = {"parts": placed.get("placed"), "clashes": len(sc.get("clashes") or []), "outside": sc.get("outside", 0)}
            if placed.get("motion_sensors"):      # IMUs square to the board, their axes said so the firmware can map them
                out["placed"]["motion_sensors"] = placed["motion_sensors"]
            if isinstance(placed.get("bypass"), dict):
                out["placed"]["bypass"] = placed["bypass"]
            if isinstance(out["placed"].get("bypass"), dict):      # only the capacitors that still stand in a pin's way
                out["placed"]["bypass"] = {c: {n: v for n, v in caps.items() if v.get("blocks")} for c, caps in out["placed"]["bypass"].items()}
                out["placed"]["bypass"] = {c: v for c, v in out["placed"]["bypass"].items() if v} or None
                if not out["placed"]["bypass"]:
                    del out["placed"]["bypass"]
        for ref, nets in (swap or {}).items():
            got = step(f"swap {ref}", lambda ref=ref, nets=nets: self.swap_pins(ref, list(nets)))
            if got:
                out.setdefault("swapped", {})[ref] = len(got.get("pins") or {})
    # ground on every layer that carries it, before anything is routed: the outer layers, and both inner layers of four
    if not _has_ground(self):
        copper = self.info().get("copper_layers") or ["F.Cu", "B.Cu"]
        names = [c if isinstance(c, str) else c.get("name") for c in copper]
        for layer in names:
            inner = [x for x in names if x.startswith("In")]
            # four layers: both inner layers ground; six and up: the inner layer next to each outer one, the middle ones left for power and signals
            if layer in ("F.Cu", "B.Cu") or (len(names) <= 4 and layer in INNER_GROUND) or (len(names) > 4 and inner and layer in (inner[0], inner[-1])):
                step(f"zone {layer}", lambda layer=layer: self.zone("GND", layer=layer, connect="solid" if layer.startswith("In") else "thermal"))
    if not reroute:
        step("corners", self.round_corners)      # board corners are always rounded
        if place and route:      # pads of one supply or switching net that stand together: a pour joins them, as a wide track would
            pp = step("power pours", self.power_pours)
            if pp:
                out["power_pours"] = pp
    step("prepare", self.prepare)
    if route:
        step("twins", self.bridge_twins)      # a USB-C connector's D+ and D- twins, joined at the pads before anything is routed
        r = dict(plan.get("route") or {})
        r["order"] = list(dict.fromkeys(list(order or []) + list(r.get("order") or [])))
        r["widths"] = {**(r.get("widths") or {}), **(widths or {})}
        r["kinds"] = {**(r.get("kinds") or {}), **(kinds or {})}
        # the clusters: each chip with the parts the plan ties to it (and the caller's own groups); the router wires
        # every cluster inside itself before it runs a track between two of them
        clusters: dict = {}
        near = {**(plan.get("place") or {}).get("near", {}), **(near or {})}
        def owner(ref, seen=()):
            o = near.get(ref)
            return ref if not o or o in seen else owner(o, (*seen, ref))
        for ref in near:
            clusters.setdefault(owner(ref), [owner(ref)]).append(ref)
        for gname, refs in (groups or {}).items():
            clusters[str(gname)] = list(refs)
        if fanout:      # fine-pitch chips escaped to a via ring first, the way they are by hand
            for part in self.geometry()["parts"]:
                if (part["ref"] in fanout) if isinstance(fanout, dict) else len([q for q in part["pads"] if q[0]]) >= 20:
                    fo = step(f"fanout {part['ref']}", lambda ref=part["ref"]: self.fanout(ref, nets=fanout.get(ref), style="radial") if isinstance(fanout, dict) else self.fanout(ref))
                    if fo and fo.get("vias"):
                        out.setdefault("fanout", {})[part["ref"]] = {"vias": fo["vias"], "skipped": len(fo.get("skipped") or {})}
        auto_layers = False
        if route_layers is None and not all_layers:      # six layers and up: the inner planes stay whole, signals keep to the other layers
            route_layers, planes = signal_layers(self)
            if route_layers:
                out.setdefault("notes", []).append(f"routed on {', '.join(route_layers)}: {', '.join(sorted(planes))} kept whole as planes (layers= to route on them)")
        def lay(**over):
            kw = dict(time_s=time_s, max_vias=max_vias, groups=clusters or None, explain=explain, layers=route_layers, keep_rules=keep_rules, keepouts=keepouts, escapes=escapes, plan=global_plan, ripup=ripup)
            kw.update(over)
            return self.route(**{k: v for k, v in r.items() if k in ("order", "widths", "kinds") and v}, **kw)
        if gate and (global_plan or ripup):
            # keep-best between variants (as Copper's engine keeps the better of two opinions): the board is routed with
            # the plan / repair ladder asked for, then again the plain way, and the one leaving fewer connections open
            # (then fewer rules errors) stays; a tie goes to the plain way.  A board those options make worse comes out as without them.
            ids0 = {it["id"] for it in self._all_items(["segment", "arc", "via"])}
            alt = step("route with options", lambda: lay())
            opts_st = standing()
            with self.trial() as t:      # the plain way second, on the same bare board, so a plain win is that run as it came
                for it in self._all_items(["segment", "arc", "via"]):
                    if it["id"] not in ids0:
                        self._edit({"op": "remove", "id": it["id"]})
                self.flush()
                got = step("route", lambda: lay(plan=None, ripup=None))
                plain = standing()
                t.keep = not (opts_st[0] < plain[0] or (opts_st[0] == plain[0] and opts_st[1] < plain[1]))
            out["variants"] = {"plain": {"open": plain[0], "errors": plain[1]}, "options": {"open": opts_st[0], "errors": opts_st[1]}, "kept": "plain" if t.keep else "options"}
            if t.keep:      # the later route calls go the way that won
                global_plan = ripup = None
            else:
                got = alt
        else:
            got = step("route", lambda: lay())
        if got and got.get("rules_changed"):
            out["rules_changed"] = got["rules_changed"]
        if got:
            out["routed"] = {k: got.get(k) for k in ("routed", "connections", "vias", "length_mm")}
            if got.get("groups"):
                out["routed"]["inside_groups"] = got["groups"]
            if got.get("fanout"):
                out["routed"]["fanout"] = got["fanout"]
            if got.get("plan"):
                out["routed"]["plan"] = got["plan"]
            if got.get("ladder"):
                out["routed"]["ladder"] = got["ladder"]
            if explain:
                try:
                    out["reasoning"] = _reasoning(self, plan, clusters, got)
                except HarnessError as e:
                    out["skipped"]["reasoning"] = str(e)[:120]
            if got.get("unrouted"):
                out["routed"]["why_open"] = [u[:160] for u in got["unrouted"][:8]]
            left = got.get("left") or {}
            if left:      # one more pass at only what is open, as a person goes back over the last few
                more = step("route again", lambda: self.route(nets=list(left), widths=r["widths"], kinds=r["kinds"], time_s=(time_s or 60) / 2, max_vias=max_vias, layers=None if auto_layers else route_layers, keep_rules=True, escapes=escapes, plan=global_plan, ripup=ripup))
                if more:
                    out["routed"]["vias"] = (out["routed"]["vias"] or 0) + (more.get("vias") or 0)
                    left = more.get("left") or {}
            out["routed"]["left"] = left
        rf = step("rf feeds", self.rf_feeds)      # every antenna feed to 50 ohm from the stackup: width, planes cut away under it, arcs, fence
        if rf and any(f.get("width") for f in rf.get("feeds", [])):
            out["rf_feeds"] = [{k: f[k] for k in ("net", "width", "impedance", "reference", "voided") if k in f} | ({"fence_vias": f["fence"].get("vias")} if isinstance(f.get("fence"), dict) else {}) for f in rf["feeds"] if f.get("width")]
        fin = step("finish", lambda: self.finish(stitch=stitch))
        if fin:
            out["added"] = {k: (sum(v.values()) if isinstance(v, dict) and all(isinstance(x, (int, float)) for x in v.values()) else v) for k, v in fin.items() if v not in (None, {}, 0)}
        gated("cleanup", self.cleanup)
        # what the real fill and the clean-up still leave open gets one last pass: a ground pad cut off from its pour
        # takes a via, anything else is routed again on its own
        still = step("unrouted", self.unrouted) or {}
        if still:
            if any(n.split("/")[-1].upper().endswith("GND") for n in still):
                gated("ground pads", self.ground_pads)
            gated("route last", lambda: self.route(nets=list(still), widths=r["widths"], kinds=r["kinds"], time_s=30, max_vias=max_vias, layers=None if auto_layers else route_layers, keep_rules=True, escapes=escapes, plan=global_plan, ripup=ripup))
            out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        if (out.get("routed") or {}).get("left") and free_pins:     # pins boxed in by earlier tracks: free each and lay it first, never worse
            fp = step("free pins", lambda: self.free_pins(passes=1, keep_rules=True, layers=None if auto_layers else route_layers, time_s=min(60, max(20, (time_s or 60) / 3)), budget_s=max(120, 2 * (time_s or 60))))
            if fp:
                out["routed"]["freed"] = f"open {fp['before']} -> {fp['after']}"
                if fp["after"] < fp["before"]:
                    gated("finish again", self.finish)
                out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        if silk:
            s = step("silkscreen", lambda: self.silkscreen(name=name, rev=rev))
            if s and s.get("hidden"):
                out["silk_hidden"] = s["hidden"]
    if route:
        dropped = gated("bad stitches", lambda: _drop_bad_stitches(self))      # a stitching or fence via the later passes routed against
        if dropped:
            out.setdefault("added", {})["stitches_dropped"] = dropped
    step("thermals", self.fix_thermals)      # a relief the last tracks left with too few spokes joins its pour solidly
    fit = None if reroute else step("3d models", self.align_models)   # every model's pins on its pads (pin 1 and the farthest pad), turned when not
    if fit and (fit.get("turned") or fit.get("misaligned")):
        out["models_3d"] = {k: fit[k] for k in ("turned", "misaligned") if fit.get(k)}
    if route:
        cut = gated("corners", self.fix_corners)      # a square corner the router or a repair left: two 45-degree bends
        if cut:
            out.setdefault("added", {})["corners_cut"] = cut
    info = self.info()
    out["size_mm"], out["layers"], out["vias"] = info.get("size_mm"), len(info.get("copper_layers") or []), info.get("vias")
    chk = step("drc", lambda: self.check(limit=4))
    if chk:
        out["drc"] = {"errors": chk["errors"], "by_kind": chk["by_kind"], "first": chk["first"]} if chk["errors"] else {"errors": 0}
    rv = step("review", lambda: _brief(self))
    if rv:
        out["review"] = rv
    # the gate: what nobody should be shown
    waived = {str(a).lower() for a in (accept or [])}; refused: list = []
    def refuse(rule: str, text: str) -> None:
        if rule.lower() not in waived:
            refused.append(f"{rule}: {text}")
    fixed_place = reroute      # the person's placement: report what is wrong with it, never refuse the routing for it
    _refuse = refuse
    def refuse(rule: str, text: str) -> None:   # noqa: F811
        if fixed_place and (rule.startswith("placement") or rule in ("serve.near", "crystal.near", "usb.cc", "rf.match", "assembly.space")):
            out.setdefault("placement_notes", []).append(f"{rule}: {text}")
        else:
            _refuse(rule, text)
    try:
        for a, b, ox, oy in self.clashes():
            refuse("placement.clash", f"{a} stands on {b} (courtyards overlap by {min(ox, oy)} mm). Move one of them or make the board larger.")
    except HarnessError:
        pass
    try:
        for f in self.seating()["findings"]:
            if f.startswith("error "):
                rule, _, text = f[6:].partition(": ")
                refuse(rule, text)
    except HarnessError:
        pass
    if route:
        left = (out.get("routed") or {}).get("left") or {}
        if left:      # the later steps (ground vias, stitching, pours) close ground connections the router left: count what is open now
            try:
                left = self.unrouted()
            except HarnessError:
                pass
        if left:
            refuse("routing.open", f"{sum(left.values())} connections are not routed ({', '.join(f'{n} {c}' for n, c in list(left.items())[:8])}). An open net is a crossing: move or turn the part it starts at, or give swap= more nets, then route again.")
        if (out.get("drc") or {}).get("errors"):
            kinds = {k: v - before.get(k, 0) for k, v in out["drc"]["by_kind"].items() if (k != "unconnected_items" or not left) and v > before.get(k, 0)}
            if before:
                out["drc"]["already_there"] = before      # errors the board had before routing (inside footprints, at the edge): not counted against it
            if kinds:
                refuse("drc", f"{sum(kinds.values())} DRC errors ({', '.join(f'{k} {v}' for k, v in kinds.items())}). First: {'; '.join(out['drc']['first'][:2])}")
        for f in (out.get("review") or {}).get("findings", []):
            if f.startswith("error ") and not f.startswith("error drc"):
                rule, _, text = f[6:].partition(": ")
                refuse(rule, text)
    elif "skipped" in out and out["skipped"].get("place"):
        refuse("placement", out["skipped"]["place"])
    out["seconds"] = {"total": round(_time.time() - t_start, 1), **{k: v for k, v in sorted(secs.items(), key=lambda kv: -kv[1]) if v >= 1}}   # where the time went
    if refused:
        out["refused"] = refused
    self.project.refused = [r for r in self.project.refused if not r.startswith("board ")] + ["board " + r for r in refused]
    if not out["skipped"]:
        del out["skipped"]
    # the verdict first, the long explanations last: a printed result that gets cut keeps what matters
    head = ("refused", "rules_changed", "routed", "drc", "seconds")
    out = {**{k: out[k] for k in head if k in out}, **{k: v for k, v in out.items() if k not in head and k != "reasoning"}, **({"reasoning": out["reasoning"]} if "reasoning" in out else {})}
    self.project.note(f"board: design() {out.get('routed', {}).get('routed', 0)} connections routed, {out.get('vias')} vias, DRC {out.get('drc', {}).get('errors', '?')} errors, review {out.get('review', {}).get('errors', '?')} errors")
    return out


def _reasoning(self, plan: dict, clusters: dict, got: dict) -> list:
    """The layout's thinking as plain lines: each cluster with where its parts stand and why, the parts in no
    cluster, then the routing order and every connection that did not come out short and flat."""
    import math
    parts = {p["ref"]: p for p in self.parts()}
    why = plan.get("why") or {}
    ex = got.get("explain") or {}
    found = ex.get("clusters") or {}
    lines = ["PLACEMENT, cluster by cluster (a cluster is one chip and the parts that serve it; each part belongs at the pin it serves, about 2 mm away, far end outward):"]
    seen = set()
    names = dict(clusters)
    for g, refs in found.items():      # the engine's own clusters, for parts the plan did not tie to a chip
        names.setdefault(g, [])
        names[g] = list(dict.fromkeys(list(names[g]) + [g] + list(refs)))
    for head, refs in names.items():
        c = parts.get(head)
        at = f"at ({c['x']}, {c['y']}) turned {c['rotation']}" if c else ""
        lines.append(f"Cluster {head} {at}: {len(refs) - (1 if head in refs else 0)} parts round it.")
        seen.add(head)
        for r in refs:
            p = parts.get(r)
            if r == head or not p or r in seen:
                continue
            seen.add(r)
            d = round(math.hypot(p["x"] - c["x"], p["y"] - c["y"]), 1) if c else None
            note = why.get(r) or "shares a net with it and stands closest to it (no rule of the plan placed it)"
            far = "  <-- FAR: more than 6 mm from its chip, check this one" if d is not None and d > 6 else ""
            lines.append(f"  {r} ({p.get('value', '')}) at ({p['x']}, {p['y']}) turned {p['rotation']}, {d} mm from {head}'s centre: {note}.{far}")
    loose = [r for r in parts if r not in seen]
    if loose:
        lines.append("In no cluster (placed by the floor plan, an edge, or left where they were): " + ", ".join(f"{r} at ({parts[r]['x']}, {parts[r]['y']})" for r in loose[:40]) + ".")
    for ref, side in ((plan.get("place") or {}).get("edges") or {}).items():
        lines.append(f"{ref} goes on the {side} edge: {why.get(ref) or 'it must reach the outside (a connector or an antenna)'}.")
    for a, b in plan.get("apart") or []:
        lines.append(f"{a} and {b} are kept apart: one disturbs the other.")
    r = plan.get("route") or {}
    lines.append("ROUTING ORDER: 1. critical nets, short, on one layer, no via (" + (", ".join(ex.get("critical_first") or r.get("order") or []) or "none found") + "); 2. the connections inside each cluster; 3. power (a pin of a net with an inner plane drops straight into it); 4. fine-pitch escapes; 5. the tracks between clusters.")
    g = got.get("groups") or {}
    if g:
        lines.append(f"Inside clusters: {g.get('routed')} of {g.get('inside')} connections made, with {g.get('vias')} vias. A via here means a part of that cluster faces the wrong way or stands too far out.")
    if r.get("widths"):
        lines.append("Widths: " + ", ".join(f"{n} {w} mm" for n, w in r["widths"].items()) + " (supplies wide, RF at its impedance); plain signals 0.2 mm where they fit.")
    for c in ex.get("layer_changes") or []:
        ratio = f", {c['length_mm']} mm for {c['straight_mm']} mm straight" if c.get("straight_mm") else ""
        lines.append(f"Layer change: {c['net']} {c.get('from')} to {c.get('to')} took {c['vias']} via{'s' if c['vias'] != 1 else ''} over {'/'.join(c.get('layers') or [])}{ratio}: no way on one layer within 1.6 times the straight line, so something crosses it between those pads.")
    for c in ex.get("longest_detours") or []:
        lines.append(f"Detour: {c['net']} {c.get('from')} to {c.get('to')} is {c['length_mm']} mm, {c['detour_ratio']} times the straight line: the direct way was taken by earlier tracks or parts.")
    for u in got.get("unrouted") or []:
        lines.append(f"Open: {u}")
    return lines


def signal_layers(self) -> tuple:
    """On six copper layers and up: the layers signals may use, and the inner layers kept whole as planes (an inner
    layer with a single-layer pour over 60% of the outline).  (None, set()) when every layer may carry signals."""
    with contextlib.suppress(HarnessError):
        names = [c if isinstance(c, str) else c.get("name") for c in (self.info().get("copper_layers") or [])]
        ob = self.geometry().get("outline")
        if len(names) > 4 and ob:
            area = abs((ob[2] - ob[0]) * (ob[3] - ob[1])) or 1
            planes = {l for z in self.zones() if not z.get("keepout") and z.get("box") and (z["box"][2] - z["box"][0]) * (z["box"][3] - z["box"][1]) > 0.6 * area
                      for l in z["layers"] if l.startswith("In") and len(z["layers"]) == 1}
            if planes and len(names) - len(planes) >= 2:
                return [l for l in names if l not in planes], planes
    return None, set()


def _drop_bad_stitches(self) -> int:
    """Ground vias with no track of their own (stitching, fences) that a rules error now sits on: taken out, since the
    router's later passes may have laid tracks past them and a stitch is worth less than a clean board."""
    gone = 0
    for v in self._fresh_checks().get("violations", []):
        if v.get("severity") != "error" or v.get("code") not in ("clearance", "shorting_items", "hole_clearance", "copper_edge_clearance", "tracks_crossing", "hole_to_hole"):
            continue
        items = self.whats_at((v["x"], v["y"]), radius=0.5)
        for it in items:
            if it.get("kind") != "via" or not re.fullmatch(r"/?(A|D|P)?(GND|VSS)\w*", it.get("net") or "", re.I):
                continue
            at = it.get("at") or [v["x"], v["y"]]
            own = [t for t in self.whats_at(at, radius=float((it.get("size")[0] if isinstance(it.get("size"), list) else it.get("size")) or 0.5) / 2) if t.get("kind") in ("track", "segment", "arc") and t.get("net") == it.get("net")]
            if own:
                continue
            with contextlib.suppress(HarnessError):
                self.remove(it["id"]); gone += 1
            break
    if gone:
        self.flush()
    return gone


def _has_ground(self) -> bool:
    from . import physics as _physics
    try:
        return bool(_physics._has_zones(self))
    except HarnessError:
        return False


def _seg_dist(p, a, b) -> float:
    ax, ay = b[0] - a[0], b[1] - a[1]; L = ax * ax + ay * ay
    u = 0.0 if L < 1e-12 else max(0.0, min(1.0, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / L))
    return math.hypot(p[0] - a[0] - u * ax, p[1] - a[1] - u * ay)


def _segs_dist(a, b, c, d) -> float:
    return min(_seg_dist(a, c, d), _seg_dist(b, c, d), _seg_dist(c, a, b), _seg_dist(d, a, b))


def _fanout(self, ref: str, nets: list | None = None, far: float = 4.0, pad_len: float | None = None, apply: bool = True,
            rows: int | None = None, first: float | None = None, style: str = "ring", length: float = 1.5, spacing: float | None = None,
            turn: str | None = None, toward=None, vias: bool = False, via: tuple | None = None) -> dict:
    """Escape a fine-pitch chip (QFN or QFP, 0.5 mm pitch or finer) the way it is done by hand, before anything else is
    routed: every pin whose net goes far (another pad more than `far` mm away) gets a short stub straight out of its pad
    and a via in a staggered ring of two rows just outside the pin row, the vias in the order of the pins so no two stubs
    cross.  The router then starts those nets from the via, on whichever layer is free, instead of fighting for the
    narrow space in front of the chip, where neighbouring escapes otherwise box pins in.  Supply and ground pins, pins
    whose net stays close (a decoupling capacitor, the crystal) and pins with no free site keep their pads for the router.

    style="ring" (default) assigns pins to staggered via sites in pin order; style="radial" puts each via straight out
    from its own pin, the rows staggered (needs a via, a stub and the clearance to fit in one pin pitch: at 0.4 mm
    pitch with 0.15 mm clearance it does not, and every other pin is skipped); style="bus" is the owner's Ember
    escape: no vias, every far pin straight out `first` mm (0.3) past its pad, then the side's bus turns 45 degrees
    towards where its nets go, lanes `spacing` mm apart (default track + clearance, the tightest the rules allow), and runs on `length` mm (1.5) for the router to carry on
    from (layer changes then happen out there, where the bus has room).

    Bus options: turn="cw"|"ccw" turns the whole side one way round the chip (clockwise as seen on screen, Y down)
    instead of towards the nets, for when that way runs into a capacitor or a supply track; toward=(x, y) turns each
    side towards that point instead of the nets' own pads.  vias=True ends every lane in a via, staggered: the lane on
    the outside of the turn (away from the chip) stops first and each next lane runs on one via pitch further, every
    via stepped outwards just enough to clear the lane beside it, the way the owner's Ember drops its buses.
    via=(0.4, 0.2) sets that via's size and drill (default the net class's; 0.4/0.2 is what fits beside 0.4 mm pitch
    lanes when the rules allow it).  At 0.4 mm pitch two neighbouring pins can never both drop to vias straight out:
    the deeper stub passes the shallower via closer than via/2 + clearance + track/2, so let the bus turn first.

    nets: only these (default: every far-going signal net).  apply=False only plans.  Returns {"vias": n, "pins":
    [pin numbers fanned], "skipped": {pin: why}}.  board.design() calls it for every fine-pitch chip unless fanout=False."""
    parts = {p["ref"]: p for p in self.geometry()["parts"]}
    part = parts.get(ref)
    if not part:
        raise HarnessError(f"fanout: no part {ref} on the board")
    pads = [q for q in part["pads"] if q[0]]
    if len(pads) < 20:
        return {"vias": 0, "pins": [], "skipped": {}, "note": f"{ref} has fewer than 20 pins"}
    cx, cy, rot = float(part["x"]), float(part["y"]), math.radians(-float(part["rotation"] or 0))
    normals = [(math.cos(rot + k * math.pi / 2), math.sin(rot + k * math.pi / 2)) for k in range(4)]
    r = (self.project.transport.call("get_board_info", {}).get("design_rules") or {})
    nc = (r.get("net_classes") or {}).get("Default") or {}
    clr = float(nc.get("clearance") or r.get("clearance") or 0.15); vd = float(nc.get("via_diameter") or 0.5); tw = min(0.2, float(nc.get("track_width") or 0.2))
    if via:
        vd = float(via[0])
    vr = vd / 2
    if style in ("radial", "bus"):
        tw = min(tw, 0.15)      # a stub passes a neighbour's via 0.4 mm away on a 0.4 mm pitch
    sides = {}
    for q in pads:
        dx, dy = q[1] - cx, q[2] - cy
        k = max(range(4), key=lambda i: dx * normals[i][0] + dy * normals[i][1])
        sides.setdefault(k, []).append(q)
    pitch = min((math.hypot(a[1] - b[1], a[2] - b[2]) for s in sides.values() for a, b in zip(sorted(s, key=lambda q: (q[1], q[2])), sorted(s, key=lambda q: (q[1], q[2]))[1:])), default=1)
    if pitch > 0.65:
        return {"vias": 0, "pins": [], "skipped": {}, "note": f"{ref} pitch {pitch:.2f} mm is not fine"}
    half = pad_len / 2 if pad_len else 0.4
    # where every net's pads are, to tell a far-going net from a local one
    where = {}
    for p in parts.values():
        for q in p["pads"]:
            if q[3]:
                where.setdefault(q[3], []).append((q[1], q[2], p["ref"]))
    from .rules import _SUPPLY as _sup
    is_supply = lambda nm: bool(_sup.match(nm.lstrip("/")) or _sup.match(nm))   # noqa: E731
    others = [(q[1], q[2], q[3]) for p in parts.values() if p["ref"] != ref for q in p["pads"]]
    placed_v, placed_s, plan, skipped = [], [], [], {}
    for k, side in sides.items():
        n = normals[k]; tng = (-n[1], n[0])
        proj = max((q[1] - cx) * n[0] + (q[2] - cy) * n[1] for q in side)
        row = [q for q in side if (q[1] - cx) * n[0] + (q[2] - cy) * n[1] > proj - 0.2]
        s_of = lambda x, y: (x - cx) * tng[0] + (y - cy) * tng[1]   # noqa: E731
        want = []
        for q in sorted(row, key=lambda q: s_of(q[1], q[2])):
            net = q[3]
            if not net or (nets and net not in nets and net.lstrip("/") not in nets) or (not nets and (is_supply(net) or net.upper().endswith("GND"))):
                continue
            if not any(math.hypot(x - q[1], y - q[2]) > far for x, y, rr in where.get(net, []) if rr != ref):
                skipped[q[0]] = "net stays close"
                continue
            want.append(q)
        if not want:
            continue
        if style == "bus":
            # the person's Ember escape: every far-going pin leaves straight out on the chip's own layer, side by side
            # at the pin pitch, then the bus turns 45 degrees towards where its nets go (the side splits where the
            # destinations do) and runs on `length` mm, with no via near the chip; the bends of each half lie on the
            # line that keeps the lanes one pin pitch apart through the turn (the inside lane turns first, each lane
            # further out (sqrt(2) - 1) x its distance later), and the router carries on from the bus ends
            # lanes `spacing` apart after the turn (default: track width + clearance, the tightest the rules allow)
            sp = max(spacing if spacing else tw + clr, tw + clr)
            T = math.sqrt(2) * sp / pitch - 1
            obst = [(q[1], q[2], q[3], (max(q[4], q[5]) / 2 if len(q) > 5 and q[4] else 0.4)) for pp in parts.values() if pp["ref"] != ref for q in pp["pads"]]
            def toward_(q):
                pts = [tuple(toward)] if toward else [(x, y) for x, y, rr in where.get(q[3], []) if rr != ref]
                if not pts:
                    return 0.0
                mx, my = sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)
                return (mx - q[1]) * tng[0] + (my - q[2]) * tng[1]
            order_ = sorted(want, key=lambda q: s_of(q[1], q[2]))
            # the split: pins before it turn to -t, from it on to +t, with the fewest pins turned against their net
            best_k, best_bad = 0, None
            for k in range(len(order_) + 1):
                bad = sum(1 for q in order_[:k] if toward_(q) > 0) + sum(1 for q in order_[k:] if toward_(q) < 0)
                if best_bad is None or bad < best_bad:
                    best_k, best_bad = k, bad
            groups = [(order_[:best_k], -1), (order_[best_k:], 1)]
            if turn in ("cw", "ccw"):      # tng points clockwise round the chip on screen (Y down)
                groups = [(order_, 1 if turn == "cw" else -1)]
            d0 = proj + half + (first if first is not None else 0.3)
            run = length
            for grp, sg in groups:
                if not grp:
                    continue
                ss = [s_of(q[1], q[2]) for q in grp]; inner = max(ss) if sg > 0 else min(ss)
                vstep = vd + clr + 0.05                            # how much further each next lane runs before its via
                jog = max(0.0, vr + clr + tw / 2 - sp) + 0.01      # how far a via steps out to clear the lane beside it
                rank = {si: k for k, si in enumerate(sorted(ss, key=lambda x_: sg * x_))}     # 0: the lane outside the turn
                for q, si in zip(grp, ss):
                    far_ = max(abs(inner - x_) for x_ in ss)
                    D = d0 + T * abs(inner - si) - min(0.0, T * far_)      # the bend line; never inside the first ring
                    pt = lambda s_, d_: (cx + n[0] * d_ + tng[0] * s_, cy + n[1] * d_ + tng[1] * s_)   # noqa: E731
                    a, bnd = (q[1], q[2]), pt(si, D)
                    rl = run + (rank[si] * vstep if vias else 0.0)
                    end = pt(si + sg * rl / math.sqrt(2), D + rl / math.sqrt(2))
                    path = [a, bnd, end] if rl > 0 else [a, bnd]
                    if vias and jog > 0.011:       # a short step straight out from the chip puts the via clear of the next lane
                        path.append(pt(si + sg * rl / math.sqrt(2), D + rl / math.sqrt(2) + math.sqrt(2) * jog))
                    full_end = path[-1]
                    # a lane stops short of another part's pad in its way (a decoupling capacitor in front of the chip)
                    cut = []
                    for x0, x1 in zip(path, path[1:]):
                        L = math.hypot(x1[0] - x0[0], x1[1] - x0[1]); steps = max(1, int(L / 0.05)); stop = None
                        for k in range(steps + 1):
                            t_ = k / steps; px, py = x0[0] + (x1[0] - x0[0]) * t_, x0[1] + (x1[1] - x0[1]) * t_
                            if any(nt != q[3] and math.hypot(px - ox, py - oy) < rr_ + clr + tw / 2 for ox, oy, nt, rr_ in obst):
                                stop = max(0.0, t_ - 0.1 / max(L, 1e-6)); break
                        if not cut:
                            cut.append(x0)
                        if stop is None:
                            cut.append(x1); continue
                        if stop > 0:
                            cut.append((x0[0] + (x1[0] - x0[0]) * stop, x0[1] + (x1[1] - x0[1]) * stop))
                        break
                    path = cut
                    v_at = path[-1] if vias and path and math.hypot(path[-1][0] - full_end[0], path[-1][1] - full_end[1]) < 1e-6 else None
                    if v_at is not None and (any(math.hypot(v_at[0] - ox, v_at[1] - oy) < rr_ + clr + vr for ox, oy, nt, rr_ in obst if nt != q[3])
                                             or any(math.hypot(v_at[0] - x_[0], v_at[1] - x_[1]) < vd + clr - 1e-6 for x_ in placed_v)):
                        v_at = None
                    if len(path) < 2 or math.hypot(path[-1][0] - a[0], path[-1][1] - a[1]) < half + 0.3:
                        skipped[q[0]] = "no room: another part's pad stands in front of it"; continue
                    segs = list(zip(path, path[1:]))
                    why = ""
                    for x0, x1 in segs:
                        if any(_seg_dist((o[1], o[2]), x0, x1) < pitch / 4 + tw / 2 + clr - 1e-6 for o in pads if o[0] != q[0] and o[0]):
                            why = why or "stub by a pin"
                        if any(_segs_dist(x0, x1, c, d) < tw + clr - 1e-6 for c, d, _ in placed_s):
                            why = why or "stub by a stub"
                    if why:
                        skipped[q[0]] = "too close: " + why; continue
                    for x0, x1 in segs:
                        placed_s.append((x0, x1, q[3]))
                    if v_at is not None:
                        placed_v.append(v_at)
                    plan.append((q, path, v_at))
            continue
        span = max(abs(s_of(q[1], q[2])) for q in row) + 0.3
        # rows of via sites, each row in the gaps of the one inside it; as many rows as the pin pitch needs (a 0.4 mm
        # QFN with 0.45 mm vias takes three, as the person's Cyberboard does), the first row 1.3 mm out like theirs
        P = vd + 2 * clr + tw + 0.05
        nrows = rows or max(2, math.ceil(P / max(pitch, 0.1) - 1e-6))
        step_s = P / nrows
        gap = max(vd + clr, math.sqrt(max(0.0, (vd + clr) ** 2 - step_s ** 2)) + vd / 2)
        d1 = max(half + clr + vr + 0.15, first or 0.0)
        sites = []
        j = -int(span / P) - 1
        while j * P <= span + P:
            for k in range(nrows):
                s_, d_ = j * P + k * step_s, d1 + k * gap
                if abs(s_) <= span:
                    sites.append((s_, d_))
            j += 1
        sites.sort()
        # order-keeping assignment of pins to sites, least total sideways travel; a pin may stay unfanned
        m, ns = len(want), len(sites)
        INF = float("inf")
        best = [[INF] * (ns + 1) for _ in range(m + 1)]; how = [[0] * (ns + 1) for _ in range(m + 1)]
        for jj in range(ns + 1):
            best[0][jj] = 0
        for i in range(1, m + 1):
            si = s_of(want[i - 1][1], want[i - 1][2])
            for jj in range(1, ns + 1):
                skip_site = best[i][jj - 1]
                s, d = sites[jj - 1]; dev = abs(s - si)
                use = best[i - 1][jj - 1] + dev if dev <= d - half - 0.1 else INF
                skip_pin = best[i - 1][jj] + 3.0
                best[i][jj], how[i][jj] = min((skip_site, 0), (use, 1), (skip_pin, 2))
        i, jj, pairs = m, ns, []
        while i > 0 and jj > 0:
            h = how[i][jj]
            if h == 1:
                pairs.append((want[i - 1], sites[jj - 1])); i -= 1; jj -= 1
            elif h == 0:
                jj -= 1
            else:
                skipped[want[i - 1][0]] = "no via site"; i -= 1
        while i > 0:
            skipped[want[i - 1][0]] = "no via site"; i -= 1
        if style == "radial":
            # the person's Cyberboard escape: each via straight out from its own pin (no sideways jog), the rows
            # 1.3 mm and further out, a pin next to another diving pin going one row further so the vias stagger
            pairs = []; last = []   # (tangent, row) of the pins placed so far on this side
            rowgap = vd + clr
            for q in want:
                si = s_of(q[1], q[2])
                busy = {k for (t, k) in last if abs(t - si) < vd + clr + 0.05}
                k = next((k for k in range(nrows) if k not in busy), None)
                if k is None:
                    skipped[q[0]] = "no via site"
                    continue
                last.append((si, k))
                pairs.append((q, (si, max(d1, 1.3) + k * rowgap)))
        for q, (s, d) in sorted(pairs, key=lambda pq: pq[1][1]):   # inner row first
            si = s_of(q[1], q[2]); dev = s - si
            base = (q[1] - cx) * n[0] + (q[2] - cy) * n[1]
            pt = lambda s_, d_: (cx + n[0] * (proj + d_) + tng[0] * s_, cy + n[1] * (proj + d_) + tng[1] * s_)   # noqa: E731
            exit_ = pt(si, half + 0.05 + (proj - base))
            v = pt(s, d); bend = pt(si, d - abs(dev)) if abs(dev) > 1e-3 else v
            path = [(q[1], q[2]), exit_, bend, v] if abs(dev) > 1e-3 else [(q[1], q[2]), exit_, v]
            segs = list(zip(path[1:], path[2:]))
            why = ""
            for (x, y) in [v]:
                if any(math.hypot(x - a[0], y - a[1]) < 2 * vr + clr - 1e-6 for a in placed_v):
                    why = why or "via by a via"
                if any(math.hypot(x - o[0], y - o[1]) < vr + clr + 0.3 for o in others):
                    why = why or "via by another part's pad"
                if any(math.hypot(x - o[1], y - o[2]) < vr + clr + 0.15 for o in pads if o[0] != q[0]):
                    why = why or "via by a pin"
                if any(_seg_dist((x, y), a, b) < vr + tw / 2 + clr - 1e-6 for a, b, _ in placed_s):
                    why = why or "via by a stub"
            for a, b in segs:
                if any(_seg_dist(c, a, b) < vr + tw / 2 + clr - 1e-6 for c in placed_v):
                    why = why or "stub by a via"
                if any(_segs_dist(a, b, c, d) < tw + clr - 1e-6 for c, d, _ in placed_s):
                    why = why or "stub by a stub"
                if any(_seg_dist((o[1], o[2]), a, b) < pitch / 4 + tw / 2 + clr - 1e-6 for o in pads if o[0] != q[0] and o[0]):
                    why = why or "stub by a pin"
            if why:
                skipped[q[0]] = "too close: " + why
                continue
            placed_v.append(v)
            for a, b in segs:
                placed_s.append((a, b, q[3]))
            plan.append((q, path, v))
    if apply and plan:
        # on a board that already has copper a stub or via can land on another net's track: each pin's escape is laid,
        # the rules checked, and any escape a new error sits on is taken out again, so fanout never adds a DRC error
        before = {(v["code"], round(v["x"], 2), round(v["y"], 2)) for v in self._call("run_checks").get("violations", []) if v.get("severity") == "error"}
        laid = []
        for q, path, v in plan:
            self.track(q[3], [[round(x, 4), round(y, 4)] for x, y in path], layer="F.Cu" if part.get("side", "front") == "front" else "B.Cu", width=tw)
            if v is not None:
                self.via(q[3], [round(v[0], 4), round(v[1], 4)], size=via[0] if via else None, drill=via[1] if via else None)
            res = self.flush() or {}
            laid.append((q, path, list(res.get("added") or [])))
        bad = {}
        with contextlib.suppress(Exception):
            self.fill()          # a pour filled before the escapes were drawn would sit on them: refill, then judge
        for e in self._call("run_checks").get("violations", []):
            if e.get("severity") != "error" or e.get("code") in ("unconnected_items", "track_right_angle") or (e["code"], round(e["x"], 2), round(e["y"], 2)) in before:
                continue
            for i, (q, path, _) in enumerate(laid):
                if any(_seg_dist((e["x"], e["y"]), a, b) < 0.6 for a, b in zip(path, path[1:])) or (plan[i][2] is not None and math.hypot(e["x"] - plan[i][2][0], e["y"] - plan[i][2][1]) < 0.6):
                    bad.setdefault(i, (e.get("message") or e.get("code") or "")[:120] + (f" {e.get('refs')}" if e.get("refs") else "") + f" at ({round(e['x'], 2)}, {round(e['y'], 2)})")
        for i in bad:
            for item in laid[i][2]:
                self._edit({"op": "remove", "id": item})
            skipped[laid[i][0][0]] = "taken back: " + bad[i]
        if bad:
            self.flush()
        plan = [p for i, p in enumerate(plan) if i not in bad]
        if plan:
            self.project.note(f"board: fanned out {ref}: {len(plan)} pins " + ("as a bus of stubs" if style == "bus" else "to a staggered via ring"))
    return {"vias": sum(1 for p in plan if p[2] is not None), "stubs": len(plan), "pins": sorted((q[0] for q, _, _ in plan), key=lambda x: (len(x), x)), "skipped": skipped}


def install(Board) -> None:
    Board.design = _design
    Board.brief = _brief
    Board.fanout = _fanout
