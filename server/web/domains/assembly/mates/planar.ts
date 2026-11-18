// planar.ts — the Planar mate: the second part's connector stays in the first one's plane (at an offset),
// facing the same way; it slides in the plane and turns about the plane's normal.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { OFFSET, inPlane, placeWith, sameZ } from "./_residuals";

const solve: MateSolve = {
  residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); inPlane(a, b, out); },
};

export default defineMate({
  type: "planar",
  title: "Planar",
  order: 40,
  icon: '<path d="M3 15l6-6h12l-6 6z"/><path d="M12 12V4"/><path d="M9.5 6.5L12 4l2.5 2.5"/>',
  defaults: () => ({ offset: 0 }),
  schema: [OFFSET],
  freedom: { translation: 2, rotation: 1 },
  place: placeWith(solve),
  solve,
});
