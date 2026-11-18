// tangent.ts — the Tangent mate: two surfaces touch.  It works on what the connectors were inferred from:
//
//   a flat face and a cylinder    the cylinder's axis is parallel to the face, one radius above it
//   two cylinders                 their axes are r1 + r2 apart (or |r1 − r2| with "Inside": a roller in a bore)
//
// Other pairs (two flat faces, a sphere, a cone) are refused with a message.  A circular edge counts as a
// cylinder of its radius.
import { defineMate } from "../core/mate";
import { cross, dot, len, sub } from "../solver/math";
import type { MateFrame, MateSolve } from "../solver/types";
import { placeWith } from "./_residuals";

const round = (f: MateFrame): boolean => (f.surface === "cylinder" || f.surface === "circle") && typeof f.radius === "number" && f.radius > 0;
const flat = (f: MateFrame): boolean => f.surface === "plane";

const solve: MateSolve = {
  check(a, b) {
    if ((flat(a) && round(b)) || (round(a) && flat(b)) || (round(a) && round(b))) return null;
    if (flat(a) && flat(b)) return "Two flat faces cannot be tangent. Use Planar, or pick a round face for one of them.";
    return "Tangent needs a flat face and a cylinder, or two cylinders. Pick a round face or a circular edge.";
  },
  residuals(a, b, params, reach, out) {
    if (flat(a) || flat(b)) {
      const plane = flat(a) ? a : b, cyl = flat(a) ? b : a;
      out.push(reach * dot(plane.z, cyl.z), dot(sub(cyl.o, plane.o), plane.z) - (cyl.radius || 0));
      return;
    }
    // two axes: the distance between the two lines
    const n = cross(a.z, b.z), d = sub(b.o, a.o), s = len(n);
    const along = dot(d, a.z);
    const apart = s > 1e-6 ? Math.abs(dot(d, n)) / s : len(sub(d, [a.z[0] * along, a.z[1] * along, a.z[2] * along]));
    const ra = a.radius || 0, rb = b.radius || 0;
    out.push(apart - (params.inside ? Math.abs(ra - rb) : ra + rb));
  },
};

export default defineMate({
  type: "tangent",
  title: "Tangent",
  order: 90,
  icon: '<circle cx="12" cy="10" r="5"/><path d="M3 15h18"/>',
  defaults: () => ({ inside: false }),
  schema: [{ key: "inside", label: "Inside", kind: "boolean", hint: "For two cylinders: one rolls inside the other." }],
  freedom: { translation: 2, rotation: 2 },
  place: placeWith(solve),
  solve,
});
