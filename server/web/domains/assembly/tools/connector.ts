// Add an explicit mate connector: a connector that stays on a part where it was put (with an offset, a turn or
// a flip of its own), for a mate to use later.  Implicit connectors need none of this: a mate tool finds them
// under the pointer.  An explicit one is for a place that has no geometry of its own, or that several mates share.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "connector", title: "Connector", hint: "Click a face, an edge or a point to keep a connector there", order: 30,
  icon: '<circle cx="12" cy="14" r="5"/><path d="M12 14V3"/><path d="M9 6l3-3 3 3"/><path d="M12 14h6"/>',
  disabled: (a) => (!a.getState().canEdit ? "you have view-only access" : a.getState().instances.length ? null : "place an instance first"),
  active: (a) => a.getState().connecting,
  run: (a) => a.setConnecting(!a.getState().connecting),
});
