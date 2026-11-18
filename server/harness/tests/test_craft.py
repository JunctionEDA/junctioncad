"""Workshop practice (review-craft.ts): each rule on a board that states exactly the copper it is about, and the
short review and one-call layout of craft.py.  Needs Node and the built engine; skipped when they are missing."""
import unittest

from kicad_harness import craft
from test_physics import Boards, edge, part, track, via, zone

BOX = (0, 0, 40, 30)
GROUND = [edge(BOX), zone("GND", "F.Cu", BOX), zone("GND", "B.Cu", BOX)]


def chip(ref, at, nets, pitch=0.5, n=4):
    """A small fine-pitch part: n pads down each side, 0.25 x 0.8 mm, lying across; nets: {pad number: net}."""
    pads = []
    for i in range(n):
        y = (i - (n - 1) / 2) * pitch
        pads.append((str(i + 1), -1.5, y, 0.8, 0.25, nets.get(str(i + 1), "")))
        pads.append((str(2 * n - i), 1.5, y, 0.8, 0.25, nets.get(str(2 * n - i), "")))
    return part(ref, at, pads, value="MCU", lib="Package_DFN_QFN:QFN")


class Craft(Boards):
    def test_thin_track_in_the_open_is_reported_and_a_neck_at_the_pad_is_not(self):
        b = self.open(*GROUND, chip("U1", (10, 10), {"8": "SIG", "7": "NECK"}), part("R1", (30, 9.25), [("1", 0, 0, 0.6, 0.6, "SIG")]), part("R2", (13.5, 12, ), [("1", 0, 0, 0.6, 0.6, "NECK")]),
                      track("SIG", [(11.5, 9.25), (30, 9.25)], width=0.1), track("NECK", [(11.5, 9.75), (12.5, 9.75), (13.5, 10.75), (13.5, 12)], width=0.1))
        got = self.finding(b.review(), "tracks.minimum")
        self.assertIn("SIG", got)
        self.assertNotIn("NECK", got)

    def test_reset_beside_a_clock_is_crosstalk_and_apart_it_is_not(self):
        def board(gap):
            return self.open(*GROUND, part("J1", (2, 10), [("1", 0, 0, 0.6, 0.6, "NRST"), ("2", 0, 2, 0.6, 0.6, "SPI_SCK")]), part("J2", (38, 10), [("1", 0, 0, 0.6, 0.6, "NRST"), ("2", 0, 2, 0.6, 0.6, "SPI_SCK")]),
                             track("NRST", [(2, 10), (38, 10)], width=0.2), track("SPI_SCK", [(2, 12), (4, 10 + gap), (36, 10 + gap), (38, 12)], width=0.2))
        self.assertIn("crosstalk.victims", self.failed(board(0.4).review()))
        self.assertNotIn("crosstalk.victims", self.failed(board(1.5).review()))

    def test_a_tight_row_of_vias_is_a_slot_and_a_spaced_row_is_not(self):
        def board(pitch):
            return self.open(*GROUND, *[via(f"D{i}", (10 + i * pitch, 15)) for i in range(8)])
        self.assertIn("vias.slot", self.failed(board(0.7).review()))
        self.assertNotIn("vias.slot", self.failed(board(1.4).review()))

    def test_supply_via_at_the_pin_with_the_capacitor_beyond_it(self):
        def board(via_at):
            return self.open(*GROUND, chip("U1", (10, 10), {"8": "+3V3", "1": "GND"}), part("C1", (14.5, 9.25), [("1", -0.5, 0, 0.5, 0.6, "+3V3"), ("2", 0.5, 0, 0.5, 0.6, "GND")], value="100n"),
                             track("+3V3", [(11.5, 9.25), (14, 9.25)], width=0.3), via("+3V3", via_at), via("GND", (15.8, 9.25)))
        self.assertIn("bypass.order", self.failed(board((12.4, 8.5)).review()))
        self.assertNotIn("bypass.order", self.failed(board((14, 8.3)).review()))

    def test_leaving_a_fine_pitch_pad_sideways(self):
        def board(pin, pts):
            return self.open(*GROUND, chip("U1", (10, 10), {pin: "SIG"}), part("R1", (20, 6), [("1", 0, 0, 0.6, 0.6, "SIG")]), track("SIG", pts, width=0.2))
        self.assertIn("U1: pin 7", self.finding(board("7", [(11.5, 9.75), (11.75, 9.5), (14, 9.5), (17.5, 6), (20, 6)]).review(), "pads.entry"))   # across pin 8
        self.assertNotIn("pads.entry", self.failed(board("7", [(11.5, 9.75), (13, 9.75), (16.75, 6), (20, 6)]).review()))                       # out through the end
        self.assertNotIn("pads.entry", self.failed(board("8", [(11.5, 9.25), (11.5, 8), (13.5, 6), (20, 6)]).review()))                         # the row's last pin turns away

    def test_supply_via_wants_a_ground_via_beside_it(self):
        b = self.open(*GROUND, part("J1", (5, 5), [("1", 0, 0, 0.6, 0.6, "+3V3")]), track("+3V3", [(5, 5), (20, 5)], width=0.5), via("+3V3", (20, 5)), via("GND", (35, 25)))
        self.assertIn("+3V3", self.finding(b.review(level=None), "power.return"))
        b = self.open(*GROUND, part("J1", (5, 5), [("1", 0, 0, 0.6, 0.6, "+3V3")]), track("+3V3", [(5, 5), (20, 5)], width=0.5), via("+3V3", (20, 5)), via("GND", (21, 5)))
        self.assertEqual("", self.finding(b.review(level=None), "power.return"))

    def test_signal_on_a_ground_plane_layer(self):
        import test_physics as tp
        old = tp.HEAD2
        tp.HEAD2 = old.replace('(2 "B.Cu" signal)', '(4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)')
        self.addCleanup(setattr, tp, "HEAD2", old)
        b = self.open(*GROUND, zone("GND", "In1.Cu", BOX), part("J1", (5, 5), [("1", 0, 0, 0.6, 0.6, "SIG")]), track("SIG", [(5, 5), (25, 5)], layer="In1.Cu"), track("SIG", [(5, 5), (5, 20)], layer="In2.Cu"))
        got = self.finding(b.review(), "planes.signals")
        self.assertIn("In1.Cu: 20 mm", got)
        self.assertNotIn("In2.Cu", got)

    def test_bus_lines_with_unequal_vias(self):
        def board(extra):
            items = [part("U1", (5, 10), [(str(i + 1), 0, i * 2, 0.6, 0.6, f"QSPI_SD{i}") for i in range(4)]), part("U2", (30, 10), [(str(i + 1), 0, i * 2, 0.6, 0.6, f"QSPI_SD{i}") for i in range(4)])]
            for i in range(4):
                y = 10 + i * 2
                if i == 2 and extra:
                    items += [track(f"QSPI_SD{i}", [(5, y), (12, y)]), via(f"QSPI_SD{i}", (12, y)), track(f"QSPI_SD{i}", [(12, y), (22, y)], layer="B.Cu"), via(f"QSPI_SD{i}", (22, y)), track(f"QSPI_SD{i}", [(22, y), (30, y)])]
                else:
                    items.append(track(f"QSPI_SD{i}", [(5, y), (30, y)]))
            return self.open(*GROUND, *items)
        self.assertIn("QSPI_SD2 2", self.finding(board(True).review(), "bus.transitions"))
        self.assertNotIn("bus.transitions", self.failed(board(False).review()))

    def test_via_too_deep_for_its_drill(self):
        thin = '(via (at 20 15) (size 0.3) (drill 0.1) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "v-thin"))'
        b = self.open(*GROUND, part("J1", (5, 15), [("1", 0, 0, 0.6, 0.6, "SIG")]), track("SIG", [(5, 15), (20, 15)]), thin, via("SIG", (10, 15)))
        got = self.finding(b.review(), "vias.aspect")
        self.assertIn("1 via with a 0.1 mm drill", got)
        self.assertNotIn("0.3 mm drill", got)

    def test_short_finding(self):
        row = "warning vias.slot: These vias stand close. Leave 0.55 mm between them. [8 vias from (1, 2) to (3, 4): a 5 mm slot; b; c]"
        self.assertEqual(craft._short(row, items=2), "warning vias.slot: These vias stand close. [8 vias from (1, 2) to (3, 4): a 5 mm slot; b; and 1 more]")
        self.assertEqual(craft._short("note drc: Nothing here."), "note drc: Nothing here.")

    def test_brief_is_one_line_each(self):
        b = self.open(*GROUND, *[via(f"D{i}", (10 + i * 0.7, 15)) for i in range(8)])
        got = b.brief()
        self.assertTrue(any(f.startswith("warning vias.slot: ") and f.count(". ") <= 1 for f in got["findings"]), got)
        self.assertNotIn("passed", got)


if __name__ == "__main__":
    unittest.main()
