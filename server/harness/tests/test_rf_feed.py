import math
import unittest

from kicad_harness.physics import _chain, _rounded


class RfFeedGeometry(unittest.TestCase):
    def test_chain_orders_pieces_end_to_end(self):
        runs = _chain([((5, 0), (10, 0)), ((0, 0), (5, 0)), ((10, 0), (14, 4))])
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0][0] in [(0, 0), (14, 4)], True)
        self.assertEqual(len(runs[0]), 3)          # the straight joint at (5, 0) is dropped

    def test_bend_becomes_an_arc_tangent_to_both_legs(self):
        parts = _rounded([(0, 0), (10, 0), (14, 4)], 0.4)
        kinds = [p[0] for p in parts]
        self.assertEqual(kinds, ["seg", "arc", "seg"])
        _, a, m, b = parts[1]
        self.assertAlmostEqual(a[1], 0.0, places=6)                     # starts on the first leg
        self.assertAlmostEqual(b[0] - b[1], 10.0, places=6)             # ends on the second (y = x - 10)
        r1, r2 = math.hypot(m[0] - a[0], m[1] - a[1]), math.hypot(m[0] - b[0], m[1] - b[1])
        self.assertAlmostEqual(r1, r2, places=6)                        # mid point halfway round

    def test_short_legs_shrink_the_radius(self):
        parts = _rounded([(0, 0), (0.3, 0), (0.3, 0.3)], 0.2)
        _, a, _, b = parts[1] if parts[0][0] == "seg" else parts[0]
        self.assertLessEqual(math.hypot(a[0] - 0.3, a[1]), 0.3)

    def test_pad_stubs_are_folded_not_rounded(self):
        parts = _rounded([(131.056, 74.2846), (131.0, 74.225), (124.0, 74.225), (121.875, 76.35), (121.9, 76.4106)], 0.465)
        self.assertEqual([p[0] for p in parts], ["seg", "arc", "seg"])
        self.assertEqual(parts[0][1], (131.0, 74.225))           # the straight leg stays straight
        self.assertEqual(parts[-1][2], (121.875, 76.35))


if __name__ == "__main__":
    unittest.main()
