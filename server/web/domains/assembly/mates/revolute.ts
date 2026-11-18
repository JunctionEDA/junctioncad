// revolute.ts — the Revolute mate: a hinge.  The connectors' origins coincide and their primary axes line up;
// the second part turns about that axis.  The angle can be limited, dragged and animated.
//
// The shape of a mate file: `solve.residuals` says when the mate holds, `solve.values` names what it leaves
// free, and the schema lists the dialog's fields.  The solver does the rest (solver/solver.ts).
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { ANGLE, OFFSET, coincident, limitDefaults, limitFields, placeWith, sameZ } from "./_residuals";

const solve: MateSolve = {
  values: [ANGLE],
  residuals(a, b, _params, reach, out) { coincident(a, b, out); sameZ(a, b, reach, out); },
};

export default defineMate({
  type: "revolute",
  title: "Revolute",
  order: 20,
  icon: '<circle cx="12" cy="12" r="2.5"/><path d="M12 4a8 8 0 1 1-7.4 5"/><path d="M4 5v4h4"/>',
  defaults: () => ({ offset: 0, ...limitDefaults([ANGLE]) }),
  schema: [OFFSET, ...limitFields([ANGLE])],
  freedom: { translation: 0, rotation: 1 },
  place: placeWith(solve),
  solve,
});
