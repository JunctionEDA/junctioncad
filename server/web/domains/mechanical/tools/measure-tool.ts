// Measure: while on, what is selected is drawn on the model as dimension lines (the readout in the corner shows
// the selection's measurements whether it is on or not).  Pin keeps a measurement on the model.
import { defineTool } from "../core/tool";
import { measureOf } from "../inspect/measure-session";

export default defineTool({
  id: "measure", title: "Measure", hint: "Pick faces, edges, vertices or planes: distances, angles, lengths, radii and areas (M)", group: "inspect", order: 10, key: "m",
  icon: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  active: (studio) => measureOf(studio).getState().active,
  run: (studio) => { const m = measureOf(studio); m.setActive(!m.getState().active); },
});
