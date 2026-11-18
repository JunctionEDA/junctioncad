// Hide the parts the selection is on (H); with nothing selected, show every part again.
import { defineTool } from "../core/tool";
import { displayOf, selectedBodies } from "../inspect/appearance-display";

export default defineTool({
  id: "appearance-hide", title: "Hide", group: "view", order: 40, key: "h", button: false,
  hint: "Hide the selected parts; with nothing selected, show all (H)",
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  run: (studio) => {
    const d = displayOf(studio), ids = selectedBodies(studio);
    if (ids.length) { d.hide(ids); studio.select([]); } else d.showAll();
  },
});
