// Redo what was just undone.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "redo", title: "Redo", hint: "Ctrl+Shift+Z", order: 2,
  icon: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a5 5 0 0 0 0 10h2"/>',
  disabled: (a) => (a.getState().mating ? "finish the mate first" : a.getState().canRedo ? null : "nothing to redo"),
  run: (a) => a.redo(),
});
