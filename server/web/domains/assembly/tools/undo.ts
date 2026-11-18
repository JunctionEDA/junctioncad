// Undo the last edit made here.  An undo is an ordinary edit, so everyone sees it.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "undo", title: "Undo", hint: "Ctrl+Z", order: 1,
  icon: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a5 5 0 0 1 0 10h-2"/>',
  disabled: (a) => (a.getState().mating ? "finish the mate first" : a.getState().canUndo ? null : "nothing to undo"),
  run: (a) => a.undo(),
});
