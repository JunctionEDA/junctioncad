// Undo the last edit made here.  An undo is an ordinary edit, so everyone sees it.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "undo", title: "Undo", hint: "Ctrl+Z", group: "edit", order: 10,
  icon: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a5 5 0 0 1 0 10h-2"/>',
  disabled: (studio) => (studio.getState().canUndo ? null : "Nothing to undo"),
  run: (studio) => studio.undo(),
});
