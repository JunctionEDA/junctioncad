// Save where the instances are now as a named position, to come back to (open, closed, folded).
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "position", title: "Position", hint: "Save where the moving parts are now as a named position", order: 50,
  icon: '<path d="M6 4h12v16l-6-4-6 4z"/>',
  disabled: (a) => (!a.getState().canEdit ? "you have view-only access" : a.getState().mating ? "finish the mate first" : a.getState().instances.length ? null : "place an instance first"),
  run: (a) => a.ask({ title: "Save position", acceptLabel: "Save", fields: [{ key: "name", label: "Name", kind: "text", value: `Position ${a.getState().positions.length + 1}` }], accept: (v) => a.saveCurrentPosition(String(v.name).trim() || undefined) }),
});
