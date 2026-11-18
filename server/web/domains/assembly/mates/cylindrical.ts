// cylindrical.ts — the Cylindrical mate: a shaft in a hole.  The axes line up; the second part slides along
// the axis and turns about it.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { ANGLE, DISTANCE, limitDefaults, limitFields, onAxis, placeWith, sameZ } from "./_residuals";

const solve: MateSolve = {
  values: [DISTANCE, ANGLE],
  residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); onAxis(a, b, out); },
};

export default defineMate({
  type: "cylindrical",
  title: "Cylindrical",
  order: 50,
  icon: '<ellipse cx="12" cy="6" rx="5" ry="2"/><path d="M7 6v12a5 2 0 0 0 10 0V6"/><path d="M12 10v6"/>',
  defaults: () => limitDefaults([DISTANCE, ANGLE]),
  schema: limitFields([DISTANCE, ANGLE]),
  freedom: { translation: 1, rotation: 1 },
  place: placeWith(solve),
  solve,
});
