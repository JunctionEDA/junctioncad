// Close the open sketch and go back to the part.  The toolbar draws its own ✓ and ✗ while a sketch is open
// (ui/Toolbar.tsx); this is the same act for the tool search.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "sketch-finish", title: "Finish sketch", group: "sketch", order: 90, button: false,
  icon: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  run: (studio) => studio.finishSketch(),
});
