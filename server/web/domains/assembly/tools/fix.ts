// Fix or unfix the selected instances: a fixed instance stays where it is, and the mates move the others to it.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "fix", title: "Fix", hint: "Hold the selected instances where they are", order: 20, key: "f",
  icon: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
  disabled: (a) => (!a.getState().canEdit ? "you have view-only access" : a.selectedInstances().length ? null : "select an instance first"),
  active: (a) => { const s = a.selectedInstances(); return s.length > 0 && s.every((i) => !!i.fixed); },
  run: (a) => { const s = a.selectedInstances(); a.setFixed(s.map((i) => i.id), !s.every((i) => !!i.fixed)); },
});
