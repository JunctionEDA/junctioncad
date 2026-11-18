// ball.ts — the Ball mate: a ball joint.  The connectors' origins coincide; the second part turns freely.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { coincident, placeWith } from "./_residuals";

const solve: MateSolve = { residuals(a, b, _params, _reach, out) { coincident(a, b, out); } };

export default defineMate({
  type: "ball",
  title: "Ball",
  order: 70,
  icon: '<circle cx="12" cy="10" r="5"/><path d="M5 12a7 7 0 0 0 14 0"/><path d="M12 19v2"/>',
  defaults: () => ({}),
  schema: [],
  freedom: { translation: 0, rotation: 3 },
  place: placeWith(solve),
  solve,
});
