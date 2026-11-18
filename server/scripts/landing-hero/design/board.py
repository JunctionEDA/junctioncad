# Board for the STM32F042 USB-C devboard (V1): two layers, USB-C hanging over the left edge, breadboard pin rows 15.24 mm apart.
# The chip's pins fan out by hand in tight bundles, each bundle in pin order so nothing crosses: the left column up to J2 and
# down to J3, the right column round the chip to the same rows. Only three nets change layer, through vias set side by side.
X0, Y0, W, H = 100, 100, 43, 19
YS = 0.5      # the layout is drawn on an 18 mm tall floor that sits in the middle, which keeps the pin rows' silkscreen off the edges
OVER = 1.2    # how far the USB-C shell hangs over the board edge
FLOOR = {
    # USB-C and its protection: each CC resistor right in front of its CC pin, ground end outward, so VBUS leaves the
    # connector straight past it
    "J1": (3.66, 9.0, 270), "U2": (10.56, 9.0, 180), "R1": (8.95, 6.85, 90), "R2": (8.95, 11.15, 270),
    # 3.3 V regulator above the USB pair
    "C1": (11.35, 5.2, 270), "U3": (13.9, 5.6, 0), "C2": (16.5, 5.2, 270),
    # STM32: USB pins (17, 18) face the connector; its supply capacitors sit in a row at pins 15 and 16, the analog one at pin 5
    "U1": (27.0, 9.0, 180), "C3": (22.6, 8.95, 90), "C4": (20.9, 8.45, 90), "C6": (19.4, 8.75, 90), "C5": (31.8, 9.325, 0),
    # user LED on PB1, hanging off its header pin
    "R5": (18.08, 4.2, 270), "D2": (18.08, 6.17, 90),
    # reset above boot at the right end, each with its part beside it, and the power LED along the bottom
    "SW1": (39.9, 8.6, 0), "C7": (36.0, 10.89, 90), "SW2": (39.9, 12.6, 180), "R3": (36.0, 12.96, 270), "R4": (38.7, 16.3, 0), "D1": (40.9, 16.3, 180),
    "J2": (13.0, 1.38, 90), "J3": (13.0, 16.62, 90),
}
board = project.board()
board.clear(outline=False)
print("sync", board.sync().get("added"))
board.outline(X0 + OVER, Y0, X0 + W, Y0 + H)
board.rules(clearance=0.15, track_width=0.2, min_track_width=0.15, min_clearance=0.15, edge_clearance=0.3, hole_clearance=0.15)
fixed = {r: (X0 + x, Y0 + YS + y, rot) for r, (x, y, rot) in FLOOR.items()}
placed = board.autoplace(fixed=fixed, bypass=False, outline=(X0, Y0, X0 + W, Y0 + H))
print("placed", placed.get("score"), "clashes", board.clashes())
board.zone("GND", layer="B.Cu", connect="solid", clearance=0.2)
board.zone("GND", layer="F.Cu", connect="solid", clearance=0.2)
P = lambda x, y: (X0 + x, Y0 + YS + y)
def at(pin):                                  # a pad's centre on the floor
    ref, num = pin.split(".")
    for p in board.pads(ref):
        if str(p.get("number") or p.get("pad") or p.get("name")) == num:
            return (round(p["x"] - X0, 3), round(p["y"] - Y0 - YS, 3))
    raise KeyError(pin)
def lay(net, pts, width=0.2, layer="F.Cu"):
    board.track(net, [p if isinstance(p, str) else P(*p) for p in pts], width=width, layer=layer)

# USB pair, laid first as one coupled run with no via: connector B6/B7 straight through the ESD part's pads, then side by side
# into pins 18 and 17. A6 ties to B6 under the connector, A7 to B7 beside it.
lay("USB_D+", ["J1.B6", (10.26, 9.75), (10.36, 9.65), "U2.1", (12.06, 9.65), (13.03, 10.62), "U1.18"])
lay("USB_D-", ["J1.B7", (10.26, 8.25), (10.36, 8.35), "U2.2", (11.47, 8.35), (13.09, 9.97), "U1.17"])
lay("USB_D+", ["J1.A6", (6.46, 8.75), (6.06, 9.15), (6.06, 9.35), (6.46, 9.75), "J1.B6"])
lay("USB_D-", ["J1.A7", (8.01, 9.25), (9.01, 8.25)])
lay("GND", ["U2.3", (10.56, 9.0)])
board.via("GND", P(10.56, 9.0))

# Right column, upper pins: out to the right 0.45 mm apart, up, then each at 45 degrees into its J2 pin.
for pin, x, net, to in ((10, 31.0, "PA4", "J2.7"), (9, 31.45, "PA3", "J2.8"), (8, 31.9, "PA2", "J2.9"), (7, 32.35, "PA1", "J2.10")):
    (px, py), (jx, jy) = at("U1.%d" % pin), at(to)
    lay(net, ["U1.%d" % pin, (x, py), (x, jy + abs(jx - x)), to])
# Right column, lower pins: out, down, and under the chip to J3, the lowest pin innermost. PA0 passes above the analog capacitor.
(px, py), (jx, jy) = at("U1.1"), at("J3.5")
lay("BOOT0", ["U1.1", (31.0, py), (31.0, 12.45), (jx + (jy - 12.45), 12.45), "J3.5"])
(px, py), (jx, jy) = at("U1.2"), at("J3.6")
lay("PF0", ["U1.2", (31.5, py), (31.5, 12.85), (jx + (jy - 12.85), 12.85), "J3.6"])
for pin, x, net, to in ((3, 31.95, "PF1", "J3.7"), (4, 32.6, "NRST", "J3.8")):
    (px, py), (jx, jy) = at("U1.%d" % pin), at(to)
    lay(net, ["U1.%d" % pin, (x, py), (x, jy - (x - jx)), to])
(px, py), (jx, jy) = at("U1.6"), at("J3.9")
lay("PA0", ["U1.6", (33.9, py), (33.9, jy - (33.9 - jx)), "J3.9"])
# Left column, upper pins: away from the pads at 45 degrees, up 0.4 mm apart, into J2.
for pin, x, net, to in ((11, 23.0, "PA5", "J2.6"), (12, 22.6, "PA6", "J2.5"), (13, 22.2, "PA7", "J2.4"), (14, 21.8, "PB1_LED", "J2.3")):
    (px, py), (jx, jy) = at("U1.%d" % pin), at(to)
    lay(net, ["U1.%d" % pin, (23.4, py), (x, py - (23.4 - x)), (x, jy + abs(jx - x)), to])
lay("PB1_LED", ["J2.3", "R5.1"])
# Left column, the debug pins: down to J3.
for pin, x, net, to in ((19, 22.55, "SWDIO", "J3.3"), (20, 23.0, "SWCLK", "J3.4")):
    (px, py), (jx, jy) = at("U1.%d" % pin), at(to)
    lay(net, ["U1.%d" % pin, (x, py), (x, jy - (x - jx)), to])

# Supply: capacitors straight onto pins 15 and 16; the analog pin takes 3.3 V across under the chip, where one via also feeds
# the 3.3 V header pin and everything at the right end through a single track on the back.
lay("GND", ["U1.15", "C3.2"])
lay("+3V3", ["U1.16", "C3.1"], width=0.3)
lay("+3V3", ["U1.16", "U1.5", "C5.1"], width=0.3)
y16 = at("U1.16")[1]
board.via("+3V3", P(26.4, y16))                 # two vias side by side: a supply does not change layer through one small hole
board.via("+3V3", P(27.0, y16))
lay("+3V3", [(26.4, y16), (27.0, y16), (32.5, y16 + 5.5), (34.07, y16 + 5.5), "J3.10"], width=0.3, layer="B.Cu")
lay("GND", ["C5.2", (33.05, at("C5.2")[1])])
board.via("GND", P(33.05, at("C5.2")[1]))
lay("GND", ["SW1.2", (42.0, 10.25)])
board.via("GND", P(42.0, 10.25))
# Reset and boot cross the pin bundle on the back as a pair: two vias side by side at each end.
y1 = at("U1.1")[1]
board.via("BOOT0", P(31.0, y1))
lay("BOOT0", [(31.0, y1), (31.0 + 12.45 - y1, 12.45), (34.4, 12.45)], layer="B.Cu")
board.via("BOOT0", P(34.4, 12.45))
lay("BOOT0", [(34.4, 12.45), "R3.1", (37.5, 12.45)])
board.via("NRST", P(32.6, 11.9))
lay("NRST", [(32.6, 11.9), (34.4, 11.9)], layer="B.Cu")
board.via("NRST", P(34.4, 11.9))
lay("NRST", [(34.4, 11.9), (34.9, 11.4), "C7.1", (36.9, 11.4), (37.8, 10.5), (37.8, 9.4)])

done = ("USB_D+", "USB_D-", "PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PF0", "PF1", "SWDIO", "SWCLK", "BOOT0", "NRST", "PB1_LED")
widths = {"VBUS": 0.4, "+3V3": 0.3}
print("by hand", {n: c for n, c in board.unrouted().items() if n in done})
r = board.route(nets=[n for n in board.nets() if n not in done], widths=widths, time_s=90, max_vias=2)
print("routed", {k: r.get(k) for k in ("routed", "connections", "vias", "length_mm", "left")})
left = board.unrouted()
if left:
    print("retry", board.route(nets=list(left), widths=widths, time_s=60, max_vias=2).get("left"))
print("finish", board.finish(stitch=4))
# the board's name, its version and what the buttons do, on the front where there is bare board
import uuid
for text, x, y, size in (("STM32", 40.2, 1.2, 0.9), ("USB-C", 40.2, 2.7, 0.9), ("V1", 40.2, 4.2, 0.9), ("RST", 39.9, 6.1, 0.8), ("BOOT", 39.9, 15.0, 0.8), ("2026-11-15", 6.5, 16.0, 0.8)):
    board.add_item('(gr_text "%s" (at %s %s) (layer "F.SilkS") (uuid "%s") (effects (font (size %s %s) (thickness %s))))' % (text, X0 + x, Y0 + YS + y, uuid.uuid4(), size, size, round(size * 0.15, 2)))
board.rules(min_text_height=0.6)
sk = board.silkscreen(rev="V1")
print("silk", {k: sk.get(k) for k in ("references", "hidden", "smallest", "pin_labels", "mark")})
d = board.check(limit=20, warnings=True)
print("drc", d["errors"], d["warnings"], d["by_kind"], d["first"])
rv = board.review()
print("review", rv["errors"], rv["warnings"], [f[:400] for f in rv["findings"]])
print("final unrouted", dict(board.unrouted()), board.info())
