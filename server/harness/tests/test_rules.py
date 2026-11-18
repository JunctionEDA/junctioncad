"""The house checklist (Greenberg's schematic and layout checklists) as checks and as drawing behaviour.

Needs the same as test_project: Node, the built engine and KiCad's libraries; skipped when one is missing.
"""
import os
import shutil
import tempfile
import unittest

import kicad_harness as kh

R = "Resistor_SMD:R_0402_1005Metric"
C = "Capacitor_SMD:C_0402_1005Metric"


class Rules(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="kh-rules-")
        try:
            self.project = kh.new(self.dir, "rules")
            self.project.schematic().lib("Device:R")
        except (kh.HarnessError, OSError) as e:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.skipTest(f"the design engine or KiCad's libraries are not available: {e}")

    def tearDown(self):
        self.project.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def failed(self, rv):
        return {f.split(":", 1)[0].split(" ", 1)[1] for f in rv["findings"] if not f.startswith("note")}

    def test_a_stub_label_is_global_with_the_pins_direction_and_power_symbols_are_never_turned(self):
        sch = self.project.schematic()
        sch.place("Sensor_Temperature:TMP102xxDRL", ref="U1", at=(101.6, 76.2), footprint="Package_TO_SOT_SMD:SOT-563")
        sch.place("Connector:TestPoint", ref="TP1", at=(152.4, 76.2))
        sch.net("SDA", "U1.SDA")
        sch.net("ALERT", "U1.ALERT")
        sch.net("+3V3", "U1.V+", "TP1.1")          # TP1's pin points down: the wire bends, the symbol still points up
        sch.net("GND", "U1.GND", "U1.ADD0")
        sch.flush()
        g = sch.geometry()
        kinds = {l[0]: l[3] for l in g["labels"]}
        self.assertEqual(kinds, {"SDA": "global_label", "ALERT": "global_label"})
        self.assertTrue(all(p["rotation"] == 0 for p in g["parts"] if p.get("power")), [p for p in g["parts"] if p.get("power")])
        self.project.save()
        with open(os.path.join(self.dir, "rules.kicad_sch"), encoding="utf-8") as f:
            text = f.read()
        self.assertRegex(text, r'\(global_label "SDA"\s*\(shape bidirectional\)')
        self.assertRegex(text, r'\(global_label "ALERT"\s*\(shape (output|bidirectional)\)')
        rv = sch.review()
        self.assertNotIn("power.direction", self.failed(rv))
        self.assertNotIn("labels.stubs", self.failed(rv))
        # a symbol turned by hand is an error, by name
        sch.place("power:GND", at=(177.8, 101.6), rotation=180)
        sch.flush()
        self.assertTrue(any(f.startswith("error power.direction") and "GND" in f for f in sch.review()["findings"]))

    def test_plain_labels_on_wire_ends_are_converted_and_stay_connected(self):
        sch = self.project.schematic()
        sch.place("Device:R", ref="R1", value="1k", at=(101.6, 76.2), rotation=90, footprint=R)
        sch.place("Device:R", ref="R2", value="1k", at=(152.4, 101.6), rotation=90, footprint=R)
        sch.label("R1.1", "LINK", kind="label")
        sch.label("R2.2", "LINK", kind="label")
        sch.flush()
        self.assertEqual(sch.net_of("R1.1"), sch.net_of("R2.2"))
        self.assertTrue(any(f.startswith("warning labels.stubs") for f in sch.review()["findings"]))
        self.assertEqual(sch.globalize(), 2)
        self.assertEqual({l[3] for l in sch.geometry()["labels"]}, {"global_label"})
        self.assertEqual(sch.net_of("R1.1"), sch.net_of("R2.2"))
        self.assertEqual(sch.net_of("R1.1"), "LINK")
        self.assertNotIn("labels.stubs", self.failed(sch.review()))
        self.assertEqual(sch.globalize(), 0)       # nothing left to convert is a result, not an error

    def test_the_circuit_checklist_finds_the_usual_mistakes_and_passes_once_they_are_fixed(self):
        sch = self.project.schematic()
        parts = {
            "U1": {"lib": "Sensor_Temperature:TMP102xxDRL", "value": "TMP102", "footprint": "Package_TO_SOT_SMD:SOT-563"},
            "R1": {"lib": "Device:R", "value": "10", "footprint": R},
            "C1": {"lib": "Device:C", "value": "10uF 6.3V", "footprint": C},
        }
        nets = {"VCC": ["U1.V+", "R1.1", "C1.1"], "GND": ["U1.GND", "U1.ADD0", "R1.2", "C1.2"]}
        sch.place("Connector_Generic:Conn_01x02", ref="J1", at=(50.8, 50.8), footprint="Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical")
        built = sch.build(parts, nets, {"Sensor": ["U1", "R1", "C1"]}, no_connect=["U1.ALERT"], supplies={"VCC": {"volts": (4.5, 5.0, 5.5), "amps": 0.01}})
        self.assertEqual(built["problems"], [])
        self.assertIn("review", built)
        sch.net("I2C_SDA", "U1.SDA", "J1.1")
        sch.net("I2C_SCL", "U1.SCL", "J1.2")
        rv = sch.review()
        text = "\n".join(rv["findings"])
        bad = self.failed(rv)
        self.assertIn("power.names", bad)                       # VCC says nothing about the rail
        self.assertNotIn("power.ratings", bad)                  # but its range is written on the sheet
        self.assertRegex(text, r"error caps\.voltage: .*C1 10uF 6\.3V is rated 6\.3 V on VCC \(5\.5 V\)")
        self.assertRegex(text, r"error resistors\.power: .*R1 10 across")       # 5.5 V across 10 ohm in an 0402
        self.assertRegex(text, r"error pullups: .*I2C_SDA")
        self.assertRegex(text, r"bypass: .*U1 TMP102")          # 10 uF only: no small ceramic
        self.assertIn("title", bad)
        self.assertIn("bom", bad)
        # fix them the way the findings say
        sch.clear()
        parts["J1"] = {"lib": "Connector_Generic:Conn_01x02", "value": "I2C", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"}
        parts["R1"]["value"] = "4k7"
        parts["R2"] = dict(parts["R1"])
        parts["C1"] = {"lib": "Device:C", "value": "100nF", "footprint": C, "fields": {"Voltage": "16V"}}
        for p in parts.values():
            p.setdefault("fields", {}).update({"MFR": "Example", "MPN": "X-1"})
        nets = {"+5V": ["U1.V+", "R1.1", "R2.1", "C1.1"], "GND": ["U1.GND", "U1.ADD0", "C1.2"], "I2C_SDA": ["U1.SDA", "R1.2", "J1.1"], "I2C_SCL": ["U1.SCL", "R2.2", "J1.2"]}
        built = sch.build(parts, nets, {"Sensor": ["U1", "R1", "R2", "C1", "J1"]}, no_connect=["U1.ALERT"], notes={"Sensor": "TMP102 temperature sensor on I2C at address 0x48 (ADD0 to ground). J1 goes to the host's I2C bus (3.3 V levels)."},
                          supplies={"+5V": {"volts": (4.5, 5.0, 5.5), "amps": 0.01}})
        sch.title("Rules (V1)", rev="V1")
        rv = sch.review()
        bad = self.failed(rv)
        for rule in ("power.symbols", "power.direction", "power.names", "power.ratings", "caps.voltage", "resistors.power", "pullups", "bypass", "title", "bom", "values", "blocks.labelled", "blocks.described", "uart", "mosfets"):
            self.assertNotIn(rule, bad, rv["findings"])
        self.assertEqual(rv["errors"], 0, rv["findings"])
        self.assertTrue(rv["manual"])                           # what only a person can judge is listed, not skipped

    def test_the_layout_checklist_and_the_calls_that_satisfy_it(self):
        sch = self.project.schematic()
        parts = {
            "U1": {"lib": "Sensor_Temperature:TMP102xxDRL", "value": "TMP102", "footprint": "Package_TO_SOT_SMD:SOT-563"},
            "C1": {"lib": "Device:C", "value": "100nF", "footprint": C},
            "R1": {"lib": "Device:R", "value": "4k7", "footprint": R}, "R2": {"lib": "Device:R", "value": "4k7", "footprint": R},
        }
        nets = {"+3V3": ["U1.V+", "R1.1", "R2.1", "C1.1"], "GND": ["U1.GND", "U1.ADD0", "C1.2"], "SDA": ["U1.SDA", "R1.2"], "SCL": ["U1.SCL", "R2.2"]}
        sch.build(parts, nets, {"Sensor": list(parts)}, no_connect=["U1.ALERT"], review=False)
        self.assertEqual(sch.fiducials(), ["FID1", "FID2", "FID3"])
        self.assertEqual(sch.overlaps(), [])
        board = self.project.board()
        board.sync()
        board.outline(100, 100, 130, 125)
        board.rules(clearance=0.15, track_width=0.2, min_clearance=0.15, min_track_width=0.15)
        board.autoplace(outline=(100, 100, 130, 125), fixed={"U1": (110, 110, 0), "C1": (124, 120, 0), "R1": (116, 108, 0), "R2": (116, 112, 0)})
        bad = self.failed(board.review())
        self.assertTrue({"bypass.near", "ground.planes", "silk.title"} <= bad, bad)
        board.place("C1", (112.4, 110))
        fids = board.fiducials()
        self.assertEqual(len(fids), 3)
        self.assertGreater(abs(fids["FID1"][0] - fids["FID2"][0]) + abs(fids["FID1"][1] - fids["FID2"][1]), 20)
        board.zone("GND", layer="F.Cu")
        board.zone("GND", layer="B.Cu")
        board.route(time_s=20)
        mark = board.mark("Rules", rev="V1", org="Example")
        self.assertIn("V1", mark["text"])
        stitched = board.stitch(spacing=8)
        self.assertGreater(stitched["vias"], 0)
        o = board.geometry()["outline"]
        before = len(board._call("get_items", kinds=["via"])["items"])
        fence = board.fence([(o[0] + 1.2, o[1] + 1.2), (o[2] - 1.2, o[1] + 1.2), (o[2] - 1.2, o[3] - 1.2)], spacing=1.5)   # along two edges
        self.assertGreater(fence["vias"], 5, fence)
        self.assertEqual(fence["vias"], fence["tried"] - fence["removed"])
        self.assertEqual(len(board._call("get_items", kinds=["via"])["items"]) - before, fence["vias"])
        self.assertEqual(board.check()["errors"], 0, board.check())
        rv = board.review()
        bad = self.failed(rv)
        for rule in ("bypass.near", "ground.planes", "ground.stitching", "silk.title", "fiducials", "drc", "assembly.space"):
            self.assertNotIn(rule, bad, rv["findings"])
        self.assertEqual(set(self.project.review()), set(self.project.documents()) - {d for d in self.project.documents() if d.endswith(".kicad_pro")})

    def test_interchangeable_pins_are_reassigned_so_nets_do_not_cross(self):
        sch = self.project.schematic()
        H = "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"
        sch.place("Connector_Generic:Conn_01x04", ref="J1", at=(101.6, 76.2), footprint=H)
        sch.place("Connector_Generic:Conn_01x04", ref="J2", at=(152.4, 76.2), footprint=H)
        for i, n in enumerate(("A", "B", "C", "D")):       # wired crossed: J1.1 to J2.4, J1.2 to J2.3, ...
            sch.net(n, f"J1.{i + 1}", f"J2.{4 - i}")
        sch.flush()
        board = self.project.board()
        board.sync()
        board.outline(100, 100, 130, 120)
        board.autoplace(outline=(100, 100, 130, 120), fixed={"J1": (105, 105, 0), "J2": (120, 105, 0)})
        plan = board.swap_pins("J1", ["A", "B", "C", "D"])
        self.assertEqual(plan["pins"], {"1": "D", "2": "C", "3": "B", "4": "A"})
        self.assertLess(plan["after_mm"], plan["before_mm"])
        self.assertEqual([sch.net_of(f"J1.{i}") for i in (1, 2, 3, 4)], ["D", "C", "B", "A"])
        self.assertEqual({p["number"]: p["net"].lstrip("/") for p in board.pads("J1")}, {"1": "D", "2": "C", "3": "B", "4": "A"})
        self.assertEqual(board.swap_pins("J1", ["A", "B", "C", "D"])["pins"], {})      # already the best: nothing to do
        with self.assertRaises(kh.HarnessError):
            sch.assign_pins("J1", {"1": "A", "9": "B"})

    def test_bypass_capacitors_sit_by_their_supply_pin_and_off_the_way_of_the_signal_pins(self):
        sch = self.project.schematic()
        H = "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"
        sch.place("Timer:NE555D", ref="U1", at=(127, 76.2), footprint="Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")
        sch.place("Device:C", ref="C1", value="100nF", at=(101.6, 101.6), footprint=C)
        sch.place("Connector_Generic:Conn_01x04", ref="J1", at=(165.1, 76.2), footprint=H)
        sch.net("+5V", "U1.8", "C1.1", "J1.4"); sch.net("GND", "U1.1", "C1.2")
        for n, pin, to in (("DIS", "7", "J1.1"), ("THR", "6", "J1.2"), ("CV", "5", "J1.3")):
            sch.net(n, f"U1.{pin}", to)
        sch.flush()
        board = self.project.board()
        board.sync()
        board.outline(100, 100, 130, 125)
        got = board.autoplace(outline=(100, 100, 130, 125), fixed={"U1": (110, 112, 0), "J1": (122, 108, 0)})
        spot = got["bypass"]["U1"]["C1"]
        self.assertEqual((spot["pin"], spot["blocks"]), ("8", 0))          # beside pin 8, in front of no signal pin
        self.assertLess(spot["mm"], 2.5)
        self.assertEqual(board.clashes(), [])
        hot = next(p for p in board.pads("C1") if p["net"].lstrip("/") == "+5V"); pin = board.pad("U1.8")
        self.assertLess(abs(hot["x"] - pin["x"]) + abs(hot["y"] - pin["y"]), 3.5)
        box = board.courtyards("C1")["C1"]
        for n in ("5", "6", "7"):          # the three signal pins leave to the right: the capacitor is not in their rows
            q = board.pad(f"U1.{n}")
            self.assertFalse(box[0] - 0.15 < q["x"] + 2 and box[2] + 0.15 > q["x"] and box[1] - 0.15 < q["y"] < box[3] + 0.15, n)
        self.assertEqual(board.place_bypass("U1")["U1"]["C1"]["at"], spot["at"])       # settled: a second call keeps it

    def test_a_usb_connector_on_an_edge_hangs_over_it_as_its_footprint_asks(self):
        sch = self.project.schematic()
        sch.place("Connector:USB_C_Receptacle_USB2.0_16P", ref="J1", at=(101.6, 101.6), footprint="Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal")
        sch.place("Device:R", ref="R1", at=(152.4, 76.2), footprint=R)
        sch.net("CC1", "J1.A5", "R1.1"); sch.net("GND", "J1.A1", "R1.2")
        sch.flush()
        board = self.project.board()
        board.sync()
        board.outline(100, 100, 130, 125)
        board.autoplace(outline=(100, 100, 130, 125), edges={"J1": "left"})
        box = board.courtyards("J1")["J1"]
        self.assertAlmostEqual(box[0], 100 - 0.505, delta=0.03)          # the footprint's "PCB Edge" line lies on the outline
        self.assertTrue(all(p["x"] > 100.3 for p in board.pads("J1")))    # every pad still on the board
        self.assertEqual(board.check()["by_kind"].get("copper_edge_clearance", 0), 0)

    def test_finish_pours_ground_on_both_sides_of_a_two_layer_board_and_stitches_it(self):
        sch = self.project.schematic()
        H = "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"
        sch.place("Connector_Generic:Conn_01x04", ref="J1", at=(101.6, 76.2), footprint=H)
        sch.place("Connector_Generic:Conn_01x04", ref="J2", at=(152.4, 76.2), footprint=H)
        for i, n in enumerate(("A", "B", "C", "GND")):
            sch.net(n, f"J1.{i + 1}", f"J2.{i + 1}")
        sch.flush()
        board = self.project.board()
        board.sync()
        board.outline(100, 100, 140, 125)
        board.autoplace(outline=(100, 100, 140, 125), fixed={"J1": (105, 105, 0), "J2": (135, 105, 0)})
        board.route(time_s=10)
        done = board.finish()
        self.assertEqual(done.get("ground_poured"), ["F.Cu", "B.Cu"])
        self.assertGreater(done.get("stitching", 0), 0)
        self.assertEqual(board.check()["errors"], 0)
        self.assertNotIn("ground_poured", board.finish())          # nothing to pour the second time


if __name__ == "__main__":
    unittest.main()
