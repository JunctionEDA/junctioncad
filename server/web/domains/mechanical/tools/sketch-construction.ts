// Construction: turn the selected curves into construction geometry (dashed, no profile) and back; with nothing
// selected, switch whether what is drawn next is construction geometry.
import { defineTool } from "../core/tool";
import { sketchEditor } from "../sketch/editor";

export default defineTool({
  id: "sketch-construction", title: "Construction", hint: "Make the selected curves construction geometry, or draw the next ones as such.", group: "sketch", order: 60, key: "q",
  icon: '<path d="M4 20L20 4" stroke-dasharray="3 3"/><circle cx="4" cy="20" r="1.4"/><circle cx="20" cy="4" r="1.4"/>',
  active: (studio) => sketchEditor(studio).getState().construction,
  run: (studio) => sketchEditor(studio).toggleConstruction(),
});
