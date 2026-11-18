// Perspective or orthographic projection.  (P is the planes, as an Onshape user's hands expect.)
import { defineTool } from "../core/tool";
import { displayOf } from "../inspect/appearance-display";

export default defineTool({
  id: "appearance-projection", title: "Perspective", group: "view", order: 30,
  hint: "Switch between perspective and orthographic projection.",
  icon: '<path d="M4 6h16l-4 12H8z"/><path d="M9 6l1 12M15 6l-1 12"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  active: (studio) => displayOf(studio).getState().perspective,
  run: (studio) => { const d = displayOf(studio); d.setPerspective(!d.getState().perspective); },
});
