// parallel.ts — the Parallel mate: the connectors' primary axes point the same way; nothing else is held.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { placeWith, sameZ } from "./_residuals";

const solve: MateSolve = { residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); } };

export default defineMate({
  type: "parallel",
  title: "Parallel",
  order: 80,
  icon: '<path d="M5 19L13 5"/><path d="M11 19l8-14"/>',
  defaults: () => ({}),
  schema: [],
  freedom: { translation: 3, rotation: 1 },
  place: placeWith(solve),
  solve,
});
