// slider.ts — the Slider mate: the second part slides along the connectors' common axis and does not turn.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { DISTANCE, ROTATION, limitDefaults, limitFields, onAxis, placeWith, sameX, sameZ } from "./_residuals";

const solve: MateSolve = {
  values: [DISTANCE],
  residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); sameX(a, b, reach, out); onAxis(a, b, out); },
};

export default defineMate({
  type: "slider",
  title: "Slider",
  order: 30,
  icon: '<path d="M3 12h18"/><rect x="8" y="8" width="8" height="8"/><path d="M19 9l3 3-3 3"/>',
  defaults: () => ({ rotation: 0, ...limitDefaults([DISTANCE]) }),
  schema: [ROTATION, ...limitFields([DISTANCE])],
  freedom: { translation: 1, rotation: 0 },
  place: placeWith(solve),
  solve,
});
