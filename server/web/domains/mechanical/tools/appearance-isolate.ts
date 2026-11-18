// Isolate the parts the selection is on: every other part is hidden (I).  Again, or with nothing selected, ends it.
import { defineTool } from "../core/tool";
import { displayOf, selectedBodies } from "../inspect/appearance-display";

export default defineTool({
  id: "appearance-isolate", title: "Isolate", group: "view", order: 50, key: "i", button: false,
  hint: "Show only the selected parts; again to show all (I)",
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  active: (studio) => !!displayOf(studio).getState().isolated,
  run: (studio) => {
    const d = displayOf(studio), ids = selectedBodies(studio);
    if (d.getState().isolated || !ids.length) d.isolate(null); else d.isolate(ids);
  },
});
