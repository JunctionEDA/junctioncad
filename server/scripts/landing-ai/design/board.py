# Board for the ESP32-C3 battery devboard (V1): Raspberry Pi Pico outline (21 x 51 mm), four layers, USB at the top, antenna at the bottom.
X0, Y0, W, H = 100, 50, 21, 51
FLOOR = {
    "J1": (10.5, 2.5, 180), "U6": (10.5, 9.4, 90), "R1": (6.4, 8.7, 0), "R2": (14.6, 8.7, 0),
    "J4": (6.1, 13.0, 90),
    "U2": (13.9, 13.7, 0), "R5": (11.3, 17.6, 90), "R3": (13.25, 10.9, 0), "C1": (15.2, 10.9, 0), "C3": (10.9, 13.7, 90),
    "R4": (17.0, 12.0, 90), "C2": (16.83, 14.6, 90), "D1": (16.2, 16.7, 0), "R6": (14.2, 16.7, 0),
    "U3": (14.6, 19.8, 180), "C4": (15.9, 22.1, 0), "C5": (12.9, 22.1, 180),
    "C18": (10.6, 23.3, 0), "C19": (12.5, 23.3, 0), "C20": (14.4, 23.3, 0), "C21": (16.3, 23.3, 0),
    "U4": (12.6, 26.0, 180), "U5": (16.0, 26.0, 180), "R13": (15.9, 28.05, 180), "R14": (15.9, 29.1, 180),
    "R8": (5.4, 19.8, 0), "SW2": (5.4, 23.5, 90),
    "U1": (10.5, 33.5, 90), "C9": (12.7, 29.3, 90), "C10": (11.5, 29.3, 90), "C8": (15.4, 34.25, 0), "R9": (15.6, 31.0, 180),
    "C7": (9.6, 37.6, 270), "C6": (5.3, 38.2, 0), "R10": (12.6, 37.75, 90),
    "Y1": (4.7, 34.0, 90), "C15": (4.5, 31.9, 180), "C14": (4.45, 36.1, 180), "C11": (6.4, 36.1, 180),
    "C16": (8.27, 40.9, 180), "L1": (8.75, 42.5, 270), "C17": (8.27, 44.1, 180), "AE1": (10.2, 48.3, 0),
    "R7": (14.2, 37.2, 180), "C13": (16.2, 37.2, 0), "R15": (14.2, 38.4, 0), "R16": (16.2, 38.4, 0), "SW1": (14.65, 41.9, 0),
}
board = project.board()
board.clear(outline=False)
print("sync", board.sync().get("added"))
board.outline(X0, Y0, X0 + W, Y0 + H)
board.rules(clearance=0.15, track_width=0.15, via_diameter=0.4, via_drill=0.25, min_track_width=0.15, min_clearance=0.15, edge_clearance=0.3, hole_clearance=0.15)
fixed = {r: (X0 + x, Y0 + y, rot) for r, (x, y, rot) in FLOOR.items()}
fixed["J2"] = (X0 + 1.61, Y0 + 1.37, 0)
fixed["J3"] = (X0 + 1.61 + 17.78, Y0 + 1.37 + 48.26, 180)
placed = board.autoplace(fixed=fixed, outline=(X0, Y0, X0 + W, Y0 + H))
print("placed", placed.get("score"), "clashes", board.clashes())
if len(board.info().get("copper_layers", [])) < 4:
    board.layers(4, planes=["In1.Cu", "In2.Cu"])
board.zone("GND", layer="In1.Cu", connect="solid")
board.zone("+3V3", layer="In2.Cu", connect="solid")
board.zone("GND", layer="B.Cu", connect="solid")
board.zone("GND", layer="F.Cu", connect="solid")
board.keepout((X0, Y0, X0 + 0.7, Y0 + H), tracks=True, vias=True, copper=False, name="left edge")
board.keepout((X0 + W - 0.7, Y0, X0 + W, Y0 + H), tracks=True, vias=True, copper=False, name="right edge")
board.stackup(fab="jlcpcb", layers=4)
board.rules(clearance=0.15, track_width=0.15, via_diameter=0.4, via_drill=0.25, min_track_width=0.15, min_clearance=0.15, edge_clearance=0.3, hole_clearance=0.15)
plan = board.plan(edge="bottom")
RFW = plan["route"]["widths"].get("RF_LNA", 0.35)
board.track("RF_LNA", ["U1.1", "C16.1", "L1.1"], width=RFW)
board.track(next(n for n, v in board.nets().items() if "AE1.1" in v["pads"]), ["L1.2", "C17.1", "AE1.1"], width=RFW)
board.track("GPIO8", ["U1.14", (114.2, 82.75), (115.09, 81.86), "R9.2"])
# USB pair, laid first as one coupled run (0.5 mm pitch): connector B6/B7 straight down through the ESD part's pads,
# down the lane between J4 and the charger, then round SW2 into U1's west pins. A6/A7 tie in: D+ under the connector, D- beside it.
UW = plan["route"]["widths"].get("USB_D+", 0.26)
board.track("USB_D+", ["J1.B6", (109.75, 59.1), (109.85, 59.2), "U6.1", (109.85, 60.9), (108.95, 61.8), (108.95, 77.0), (106.6, 79.35), (106.6, 81.557), (107.293, 82.25), "U1.26"], width=UW)
board.track("USB_D-", ["J1.B7", (111.25, 59.1), (111.15, 59.2), "U6.2", (111.15, 60.307), (109.45, 62.007), (109.45, 77.207), (107.1, 79.557), (107.1, 81.35), (107.5, 81.75), "U1.25"], width=UW)
board.track("USB_D+", ["J1.A6", (110.75, 55.3), (110.35, 54.9), (110.15, 54.9), (109.75, 55.3), "J1.B6"], width=UW)
board.track("USB_D-", ["J1.A7", (110.25, 56.85), (111.25, 57.85)], width=UW)
board.track("GND", ["U6.3", (110.5, 59.4)], width=0.2)
board.via("GND", (110.5, 59.4))
# the boot line crosses under the pair once, on the bottom layer, square to it
board.track("GPIO9_BOOT", ["R8.2", (108.3, 69.8)])
board.track("GPIO9_BOOT", ["SW2.1", (107.3, 75.6), (107.8, 75.1), (107.8, 70.3), (108.3, 69.8)])
board.via("GPIO9_BOOT", (108.3, 69.8))
board.track("GPIO9_BOOT", [(108.3, 69.8), (109.5, 71.0), (118.7, 71.0), "J3.12"], layer="B.Cu")
board.track("GPIO9_BOOT", ["U1.15", (113.75, 82.25)])
board.via("GPIO9_BOOT", (113.75, 82.25))
board.track("GPIO9_BOOT", [(113.75, 82.25), (113.75, 72.2), (114.95, 71.0)], layer="B.Cu")
print("antenna", board.antenna())
print("thermal vias", board.thermal_vias())
def ground_at(x, y):
    for dx, dy in ((0.75, 0), (0, 0.75), (0, -0.75), (0.75, 0.75), (0.75, -0.75), (-0.75, 0)):
        p = (X0 + x + dx, Y0 + y + dy)
        if board.fence([p, (p[0] + 0.01, p[1])], spacing=1.0, net="GND")["vias"]:
            board.track("GND", [(X0 + x, Y0 + y), p], width=0.2)
            return (round(dx, 2), round(dy, 2))
print("ground vias", {r: ground_at(*xy) for r, xy in {"C13": (16.68, 37.2), "C8": (15.88, 34.25), "C14": (3.97, 36.1), "U5.7": (16.325, 25.2), "U5.5": (15.025, 25.2), "U5.1": (16.975, 26.8)}.items()})
have = board.nets()
R = plan["route"]
order = [n for n in ["GPIO9_BOOT"] + R["order"] + ["I2C_SDA", "I2C_SCL", "IMU_INT1", "VBUS", "VSYS", "+BATT"] if n in have]
order = [n for n in dict.fromkeys(order) if n not in ("USB_D+", "USB_D-")]
widths = {**R["widths"], "VBUS": 0.4, "VSYS": 0.4, "+BATT": 0.4, "+3V3": 0.3, "VDD_SPI": 0.3}
# cluster first: each chip with the parts the plan seats at its pins is wired inside itself before anything runs
# between clusters; pads of one supply that stand together share a pour instead of a track
near = plan["place"].get("near", {})
def owner(ref, seen=()):
    o = near.get(ref)
    return ref if not o or o in seen else owner(o, (*seen, ref))
clusters = {}
for ref in near:
    clusters.setdefault(owner(ref), [owner(ref)]).append(ref)
print("power pours", board.power_pours())
r = board.route(order=order, widths=widths, kinds=R["kinds"], time_s=180, max_vias=2, groups=clusters or None)
print("routed", {k: r.get(k) for k in ("routed", "connections", "vias", "length_mm", "left")})
left = board.unrouted()
if left:
    print("retry", board.route(nets=list(left), widths=widths, kinds=R["kinds"], time_s=60, max_vias=2).get("left"))
left = [n for n in board.unrouted() if n != "GND"]
if left:
    print("retry 2", board.route(nets=left, widths=widths, time_s=60, max_vias=2, separate=False).get("left"))
import re
for _ in range(3):
    d = board.check(kind="unconnected_items", limit=10)
    lone = [m.groups() for m in (re.search(r"net 'GND'.*at \(([\d.]+), ([\d.]+)\)", t) for t in d["first"]) if m]
    if not lone:
        break
    print("lone ground pads", [(x, y, ground_at(float(x) - X0, float(y) - Y0)) for x, y in lone])
    board.fill()
print("finish", board.finish())
board.track("GND", ["U4.3", "U4.2"], width=0.2)      # the IMU's ground pads side by side: tied pad to pad, straight
board.fill()
if board.unrouted():
    print("last ground", board.route(nets=list(board.unrouted()), time_s=40, max_vias=4, separate=False).get("left"))
    board.fill()
board.rules(min_text_height=0.6)
print("silk", board.silkscreen(rev="V1"))
d = board.check(limit=20)
print("drc", d["errors"], d["warnings"], d["by_kind"], d["first"])
print("board", board.info())
rv = board.review()
print("review", rv["errors"], rv["warnings"], rv["findings"])
if d["errors"] or rv["errors"] or board.unrouted():
    raise RuntimeError("not clean: rolled back")
