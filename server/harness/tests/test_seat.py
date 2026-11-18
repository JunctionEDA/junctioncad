"""Seating (seat.py): small parts in front of the pins they serve, crystals turned to their pins, the faults a layout
is refused for, and calls that are safe to make twice.  Needs Node and the built engine; skipped when they are missing."""
import math
import unittest

import kicad_harness as kh
from kicad_harness import seat
from test_physics import Boards, edge, part, via

BOX = (0, 0, 40, 30)
R = lambda ref, at, a, b: part(ref, at, [("1", -0.5, 0, 0.5, 0.6, a), ("2", 0.5, 0, 0.5, 0.6, b)], value="5k1", lib="Resistor_SMD:R_0402_1005Metric")


def usb(at=(20, 26)):
    """A USB-C style row at the bottom edge: ground at both ends, CC1 and CC2 inside, the body below the row."""
    row = [("A1", -3.2, "GND"), ("A4", -2.4, "VBUS"), ("A5", -1.25, "CC1"), ("A6", -0.25, "USB_DP"), ("A7", 0.25, "USB_DN"), ("B5", 1.75, "CC2"), ("B4", 2.4, "VBUS"), ("B1", 3.2, "GND")]
    return part("J1", at, [(n, x, 0, 0.3, 1.0, net) for n, x, net in row] + [("S1", -4.3, 3, 1, 2, "GND"), ("S2", 4.3, 3, 1, 2, "GND")], value="USB-C", lib="Connector_USB:USB_C")


def mcu(at=(20, 12)):
    """Five pads down each side at 0.5 mm: crystal on the right, a bus line and a radio pin on the left."""
    left = {"1": "RF", "2": "GND", "3": "SDA", "4": "", "5": ""}; right = {"10": "", "9": "XI", "8": "XO", "7": "", "6": ""}
    pads = [(n, -1.5, (i - 2) * 0.5, 0.8, 0.25, net) for i, (n, net) in enumerate(left.items())] + [(n, 1.5, (i - 2) * 0.5, 0.8, 0.25, net) for i, (n, net) in enumerate(right.items())]
    return part("U1", at, pads, value="MCU", lib="Package_DFN_QFN:QFN")


def xtal(at):
    return part("Y1", at, [("1", -0.7, 0.55, 0.9, 0.8, "XI"), ("2", 0.7, 0.55, 0.9, 0.8, "GND"), ("3", 0.7, -0.55, 0.9, 0.8, "XO"), ("4", -0.7, -0.55, 0.9, 0.8, "GND")], value="32MHz", lib="Crystal:Crystal_SMD_2016-4Pin_2.0x1.6mm")


class Seat(Boards):
    def pad(self, b, spec):
        b._geom = None
        p = b.pad(spec)
        return p["x"], p["y"]

    def test_cc_pull_downs_stand_in_front_of_their_pins_with_ground_ends_out(self):
        b = self.open(edge(BOX), usb(), R("R1", (5, 5), "CC1", "GND"), R("R2", (8, 5), "GND", "CC2"))
        self.assertIn("serve.near", " ".join(b.seating()["findings"]))
        got = b.seat()
        self.assertLess(got["R1"]["mm"], 2.5)
        self.assertLess(got["R2"]["mm"], 2.5)
        cc1, g1 = self.pad(b, "R1.1"), self.pad(b, "R1.2")
        g2, cc2 = self.pad(b, "R2.1"), self.pad(b, "R2.2")
        self.assertLess(abs(cc1[0] - 18.75), 0.6)          # in line with its pin, not beside it
        self.assertLess(abs(cc2[0] - 21.75), 0.6)
        self.assertLess(g1[0], cc1[0])                    # ground ends towards the outer ends of the connector
        self.assertGreater(g2[0], cc2[0])
        self.assertLess(cc1[1], 26)                       # on the board side of the row, not under the plug
        self.assertEqual(b.clashes(), [])
        self.assertEqual(b.seating()["errors"], 0)

    def test_a_crystal_is_turned_so_its_tracks_do_not_cross(self):
        b = self.open(edge(BOX), mcu(), xtal((33, 24)))
        self.assertIn("crystal.near", " ".join(b.seating()["findings"]))
        got = b.seat()
        self.assertLess(got["Y1"]["mm"], 4.5)
        xi, xo = self.pad(b, "Y1.1"), self.pad(b, "Y1.3")
        pi_, po = self.pad(b, "U1.9"), self.pad(b, "U1.8")
        self.assertFalse(seat._cross(xi, pi_, xo, po))
        for end, pin in ((xi, pi_), (xo, po)):            # neither track runs over one of the crystal's ground pads
            for g in ("Y1.2", "Y1.4"):
                self.assertGreater(seat._seg_dist(self.pad(b, g), end, pin), 0.4)
        self.assertEqual(b.seating()["errors"], 0)

    def test_a_via_on_a_crystal_or_cc_net_is_a_fault(self):
        b = self.open(edge(BOX), mcu(), xtal((24, 12)), usb(), R("R1", (18.25, 24.4), "GND", "CC1"), via("XI", (22.5, 14)), via("CC1", (18.75, 23.5)))
        text = " ".join(b.seating()["findings"])
        self.assertIn("crystal.vias", text)
        self.assertIn("usb.cc", text)

    def test_a_matching_network_stands_in_line_at_the_radio_pin(self):
        ant = part("AE1", (6, 3), [("1", -1.2, 0, 1, 1.4, "FEED"), ("2", 1.2, 0, 1, 1.4, "")], value="2450AT18A100E", lib="RF_Antenna:Chip")
        b = self.open(edge(BOX), mcu((12, 8)), ant, R("R3", (30, 25), "RF", "FEED"),
                      part("C7", (33, 25), [("1", -0.5, 0, 0.5, 0.6, "RF"), ("2", 0.5, 0, 0.5, 0.6, "GND")], value="DNP"), part("C8", (36, 25), [("1", -0.5, 0, 0.5, 0.6, "FEED"), ("2", 0.5, 0, 0.5, 0.6, "GND")], value="DNP"))
        self.assertIn("rf.match", " ".join(b.seating()["findings"]))
        got = b.seat()
        self.assertTrue(got["R3"]["pin"].startswith("U1."))
        self.assertEqual(got["C7"]["pin"], "R3.1")       # each shunt hangs on its end of the series part
        self.assertEqual(got["C8"]["pin"], "R3.2")
        self.assertLess(got["C7"]["mm"], 1.6)
        self.assertLess(got["C8"]["mm"], 1.6)
        self.assertNotIn("rf.match", " ".join(b.seating()["findings"]))
        self.assertEqual(b.clashes(), [])

    def test_nothing_but_the_matching_network_stands_in_the_ground_beside_an_antenna(self):
        ant = part("AE1", (6, 3), [("1", -1.2, 0, 1, 1.4, "FEED"), ("2", 1.2, 0, 1, 1.4, "")], value="2450AT18A100E", lib="RF_Antenna:Chip")
        cap = part("C1", (9.6, 6.0), [("1", -0.5, 0, 0.5, 0.6, "+3V3"), ("2", 0.5, 0, 0.5, 0.6, "GND")], value="100n")
        b = self.open(edge(BOX), mcu((20, 14)), ant, cap)
        from kicad_harness import seat as seating
        geo = b.geometry(); S = seating._Survey(b); band = seating._band(S, b.courtyards()["AE1"])
        self.assertTrue(band[0] < 9.6 < band[2] and band[1] < 6.0 < band[3])      # the capacitor starts in the band
        moved = b.settle()
        self.assertIn("C1", moved)
        x, y = moved["C1"]
        self.assertFalse(band[0] < x < band[2] and band[1] < y < band[3])

    def test_a_part_off_the_board_is_a_fault(self):
        b = self.open(edge(BOX), usb(), R("R1", (60, 5), "CC1", "GND"))
        self.assertIn("placement.outside", " ".join(b.seating()["findings"]))

    def test_outline_and_pour_are_safe_to_call_twice(self):
        b = self.open(part("J9", (10, 10), [("1", 0, 0, 1, 1, "GND")]))
        for _ in range(3):
            b.outline(0, 0, 30, 20)
            b.zone("GND", layer="B.Cu")
        b.flush()
        edge_items = lambda: [i for i in b._call("get_items", kinds=["gr_rect", "gr_line", "gr_arc"])["items"] if "Edge.Cuts" in i.get("sexpr", "")]
        self.assertEqual(sorted(i["kind"] for i in edge_items()), ["gr_arc"] * 4 + ["gr_line"] * 4)      # corners are always rounded
        self.assertEqual(len(b._call("get_items", kinds=["zone"])["items"]), 1)
        b.outline(0, 0, 32, 20)                           # a new size replaces the old outline
        b.flush()
        self.assertEqual(len(edge_items()), 8)
        self.assertEqual(b.geometry()["outline"], [0, 0, 32, 20])
        b.outline(0, 0, 32, 20, radius=0)                 # square on request: one rectangle
        b.flush()
        self.assertEqual([i["kind"] for i in edge_items()], ["gr_rect"])

    def test_a_refused_layout_is_not_saved(self):
        b = self.open(edge(BOX), usb(), R("R1", (60, 5), "CC1", "GND"))
        got = b.design(place=False, route=False, silk=False)
        self.assertTrue(any(r.startswith("placement.outside") for r in got["refused"]))
        with self.assertRaises(kh.HarnessError) as e:
            self.project.save()
        self.assertIn("refused", str(e.exception))
        self.assertIn("placement.outside", str(e.exception))


    def twin_usb(self, chip_pads):
        row = [("B7", -0.75, "USB_DN"), ("A6", -0.25, "USB_DP"), ("A7", 0.25, "USB_DN"), ("B6", 0.75, "USB_DP")]
        j = part("J1", (20, 26), [(n, x, 0, 0.3, 1.45, net) for n, x, net in row] + [("S1", -4.3, 3, 1, 2, "GND"), ("S2", 4.3, 3, 1, 2, "GND")], value="USB-C", lib="Connector_USB:USB_C")
        u = part("U1", (20, 14), chip_pads, value="MCU", lib="Package_DFN_QFN:QFN")
        return self.open(edge(BOX), j, u)

    def test_usb_c_twins_are_joined_at_the_pads_without_a_via_when_the_order_allows(self):
        b = self.twin_usb([("1", -0.25, 1.5, 0.25, 0.8, "USB_DN"), ("2", 0.25, 1.5, 0.25, 0.8, "USB_DP"), ("3", 0, -1.5, 0.25, 0.8, "GND")])
        got = b.bridge_twins()
        self.assertEqual(got["J1"]["exits"], "outer"); self.assertEqual(got["J1"]["vias"], 0)
        for n in ("USB_DP", "USB_DN"):
            t = b.trace(n)
            self.assertEqual(t["vias"], 0); self.assertLess(t["routed_length_mm"], 4.5)      # a U at the pads, not a loop round the connector
        self.assertEqual(b.bridge_twins(), {})      # asked again: nothing more

    def test_usb_c_twins_take_one_hop_on_the_back_when_the_chip_wants_the_pair_the_other_way(self):
        b = self.twin_usb([("1", -0.25, 1.5, 0.25, 0.8, "USB_DP"), ("2", 0.25, 1.5, 0.25, 0.8, "USB_DN"), ("3", 0, -1.5, 0.25, 0.8, "GND")])
        got = b.bridge_twins()
        self.assertEqual(got["J1"]["exits"], "inner"); self.assertEqual(got["J1"]["vias"], 2)
        dn, dp = b.trace("USB_DN"), b.trace("USB_DP")
        self.assertEqual(dn["vias"], 0)
        self.assertEqual(dp["vias"], 2)
        self.assertLess(dp["by_layer"]["B.Cu"]["length_mm"], 4.5)
        r = b.route(nets=["USB_DP", "USB_DN"])
        self.assertFalse({"USB_DP", "USB_DN"} & set(r["left"]))
        self.assertEqual(b.trace("USB_DP")["vias"], 2)      # the pair itself, connector to chip, stays on the top
        self.assertNotIn("usb.vias", " ".join(b.brief()["findings"]))


if __name__ == "__main__":
    unittest.main()
