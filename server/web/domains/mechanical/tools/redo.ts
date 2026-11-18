// Redo what Undo took back.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "redo", title: "Redo", hint: "Ctrl+Y", group: "edit", order: 20,
  icon: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a5 5 0 0 0 0 10h2"/>',
  disabled: (studio) => (studio.getState().canRedo ? null : "Nothing to redo"),
  run: (studio) => studio.redo(),
});
