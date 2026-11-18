"""A connector's twin pins.

A USB-C receptacle carries each data line on two pads, interleaved in one row (D- D+ D- D+), so the plug works both
ways up.  Left to the router, the second twin of a line is reached by whatever way is still free, which is a loop round
the connector.  `bridge_twins()` lays those joints the way a person does, before anything else is routed:

- when the chip wants the pair in the order of the two outer pads, one line is joined by a short U on the board side of
  the pads and the other by a short U under the connector: no via at all;
- when the chip wants the pair the other way round (the order of the two inner pads) no layout on one layer exists.
  The two inner pads then start the pair, side by side; one line's outer pad joins it by a U under the connector, the
  other's by a hop of a couple of millimetres on the back, with a via under the connector and one beside the pair.
  The pair itself, from the connector to the chip, never changes layer.
"""
from __future__ import annotations

import math
import re

from .seat import _Survey, _gnd

_CONN = re.compile(r"^(J|P|CN|USB|X)\d", re.I)


def _bridge_twins(self, refs=None, width: float = 0.2, clearance: float = 0.2, apply: bool = True) -> dict:
    """Join the twin pads of a connector's differential pair (USB-C D+ and D-) with the shortest tracks there are, and
    start the pair from the pads that face the chip in the right order.  design() calls it before routing.

    Returns {ref: {"nets": [low, high], "exits": "outer" | "inner", "vias": 0 | 2}}; a connector whose twins already
    have tracks is left alone."""
    self.flush(); self._geom = None
    S = _Survey(self); out: dict = {}
    want = {str(r).lower() for r in ([refs] if isinstance(refs, str) else refs)} if refs else None
    sizes: dict = {}

    def pad_size(part):
        if part["ref"] not in sizes:
            sx = next((it.get("sexpr", "") for it in self._call("get_items", kinds=["footprint"]).get("items", []) if it.get("id") == part.get("id") or f'"{part["ref"]}"' in it.get("sexpr", "")[:4000]), "")
            sizes[part["ref"]] = {m.group(1): (float(m.group(2)), float(m.group(3))) for m in re.finditer(r'\(pad "([^"]+)" smd[^\n]*?\(size ([\d.]+) ([\d.]+)\)', sx.replace("\n", " ").replace("(pad ", "\n(pad "))}
        return sizes[part["ref"]]

    for part in S.parts:
        if not _CONN.match(part["ref"]) or (want is not None and part["ref"].lower() not in want):
            continue
        by: dict = {}
        for q in part["pads"]:
            if q[3] and not _gnd(q[3]) and not S.rail(q[3]) and not q[3].startswith("unconnected-"):
                by.setdefault(q[3], []).append(q)
        twins = {n: v for n, v in by.items() if len(v) == 2}
        names = sorted(twins)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                four = twins[names[i]] + twins[names[j]]
                xs = [q[1] for q in four]; ys = [q[2] for q in four]
                if max(ys) - min(ys) < 0.05:
                    r = (1.0, 0.0)
                elif max(xs) - min(xs) < 0.05:
                    r = (0.0, 1.0)
                else:
                    continue
                four.sort(key=lambda q: q[1] * r[0] + q[2] * r[1])
                span = math.hypot(four[3][1] - four[0][1], four[3][2] - four[0][2])
                if span > 3.0 or not (four[0][3] == four[2][3] and four[1][3] == four[3][3]):
                    continue      # not interleaved: an ordinary joint, the router's
                a, b = four[0][3], four[1][3]
                if any((self._call("get_items", net=n, kinds=["segment"]) or {}).get("items") for n in (a, b)):
                    continue
                p = [(q[1], q[2]) for q in four]; mid = ((p[0][0] + p[3][0]) / 2, (p[0][1] + p[3][1]) / 2)
                far = {n: [(u[1], u[2]) for o, u in S.net.get(n, []) if o is not part] for n in (a, b)}
                both = far[a] + far[b]
                if not both:
                    continue
                tx = sum(u[0] for u in both) / len(both) - mid[0]; ty = sum(u[1] for u in both) / len(both) - mid[1]
                n_ = (-r[1], r[0])
                if tx * n_[0] + ty * n_[1] < 0:
                    n_ = (r[1], -r[0])      # the board side of the row: towards the chip
                along = lambda n: (min(far[n], key=lambda u: math.hypot(u[0] - mid[0], u[1] - mid[1]))[0] - mid[0]) * r[0] + (min(far[n], key=lambda u: math.hypot(u[0] - mid[0], u[1] - mid[1]))[1] - mid[1]) * r[1] if far[n] else 0.0
                # where each line arrives at the chip: by its pad, and for a pad on the chip's side by the way it leaves
                inner = bool(far[a] and far[b]) and self._twin_order(S, a, b, r, mid) < 0 if hasattr(self, "_twin_order") else along(b) < along(a)
                sz = pad_size(part).get(four[0][0], (0.3, 1.45)); L = max(sz) / 2; pitch = span / 3
                w = min(width, min(sz)); h = L + clearance + w / 2; k = min(0.25, pitch / 2)
                at = lambda q, dr, dn: (round(q[0] + r[0] * dr + n_[0] * dn, 4), round(q[1] + r[1] * dr + n_[1] * dn, 4))

                def u_turn(net, qa, qb, s):
                    self.track(net, [qa, at(qa, 0, s * (h - k)), at(qa, k, s * h), at(qb, -k, s * h), at(qb, 0, s * (h - k)), qb], width=w)

                vias = 0
                if not apply:
                    out[part["ref"]] = {"nets": [a, b], "exits": "inner" if inner else "outer", "vias": 2 if inner else 0}
                    continue
                if not inner:      # a leaves from its U on the board side, b from its outer pad; b's twin is joined under the connector
                    u_turn(a, p[0], p[2], 1); u_turn(b, p[1], p[3], -1)
                else:              # the inner pads p[1] (b) and p[2] (a) start the pair
                    via = getattr(self, "_via_size", None) or (0.5, 0.2); vr = via[0] / 2
                    d = L + clearance + vr + 0.4
                    u_turn(a, p[0], p[2], -1)
                    self.track(a, [p[2], at(p[2], 0, d)], width=w)
                    self.track(b, [p[1], at(p[1], 0, d)], width=w)
                    v2 = at(p[1], -(vr + 0.15), d); self.track(b, [at(p[1], 0, d - (vr + 0.15)), v2], width=w)
                    v1 = at(p[3], 0.15, -(L + clearance + 0.1 + vr)); self.track(b, [p[3], at(p[3], 0, -(L + 0.05)), v1], width=w)
                    self.via(b, v1, size=via[0], drill=via[1]); self.via(b, v2, size=via[0], drill=via[1])
                    dr = (v2[0] - v1[0]) * r[0] + (v2[1] - v1[1]) * r[1]; dn = (v2[0] - v1[0]) * n_[0] + (v2[1] - v1[1]) * n_[1]
                    if abs(dn) >= abs(dr):
                        m = (v1[0] + n_[0] * math.copysign(abs(dn) - abs(dr), dn), v1[1] + n_[1] * math.copysign(abs(dn) - abs(dr), dn))
                    else:
                        m = (v1[0] + r[0] * math.copysign(abs(dr) - abs(dn), dr), v1[1] + r[1] * math.copysign(abs(dr) - abs(dn), dr))
                    self.track(b, [v1, m, v2], layer="B.Cu", width=w)
                    vias = 2
                self.flush()
                out[part["ref"]] = {"nets": [a, b], "exits": "inner" if inner else "outer", "vias": vias}
    if out and apply:
        self.project.note("board: connector twin pins joined: " + "; ".join(f"{r} {v['nets'][0]} and {v['nets'][1]} ({'no vias' if not v['vias'] else 'one hop on the back'})" for r, v in out.items()))
    return out


def _twin_order(self, S, a: str, b: str, r, mid) -> float:
    """> 0 when net a arrives at its chip on the low side of net b (seen along the connector's row), < 0 when the
    other way round.  A pin on the chip's side row is counted where its track leaves it, outwards."""
    def where(n):
        best = None
        for o, u in S.net.get(n, []):
            if _CONN.match(o["ref"]):
                continue
            _, outd = S.out_of(o, u)
            x, y = u[1] + 1.0 * outd[0], u[2] + 1.0 * outd[1]
            d = math.hypot(u[1] - mid[0], u[2] - mid[1])
            if best is None or d < best[0]:
                best = (d, (x - mid[0]) * r[0] + (y - mid[1]) * r[1])
        return best[1] if best else 0.0
    return where(b) - where(a)


def install(Board) -> None:
    Board.bridge_twins = _bridge_twins
    Board._twin_order = _twin_order
