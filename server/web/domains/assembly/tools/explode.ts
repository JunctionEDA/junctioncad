// Exploded view: pull the instances apart from the middle of the assembly to see how it goes together.
// A way of looking, not an edit: nothing is stored and nobody else sees it.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "explode", title: "Explode", hint: "Pull the parts apart to look inside", order: 40, key: "e",
  icon: '<rect x="9" y="9" width="6" height="6"/><path d="M4 4l3 3"/><path d="M20 4l-3 3"/><path d="M4 20l3-3"/><path d="M20 20l-3-3"/>',
  disabled: (a) => (a.getState().instances.length > 1 ? null : "place two instances first"),
  active: (a) => a.getState().exploding,
  run: (a) => a.setExploding(!a.getState().exploding),
});
