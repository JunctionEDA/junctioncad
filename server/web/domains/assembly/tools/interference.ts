// Interference: which parts of the assembly overlap and by how much (exact, in the modelling worker), and the
// clearance between two of them.
import { defineAssemblyTool } from "../core/tool";
import { openInterference } from "../services/interference-view";

export default defineAssemblyTool({
  id: "interference", title: "Interference", hint: "Find the parts that overlap, and measure clearances", order: 70,
  icon: '<rect x="3" y="7" width="11" height="11" rx="1"/><rect x="10" y="3" width="11" height="11" rx="1"/><path d="M10 7h4v7h-4z" fill="currentColor" stroke="none" opacity=".35"/>',
  disabled: (assembly) => (assembly.getState().instances.filter((i) => !i.suppressed && (i.source.kind === "part" || i.source.kind === "board")).length < 2 ? "Place two or more parts first" : null),
  run: (assembly) => openInterference(assembly),
});
