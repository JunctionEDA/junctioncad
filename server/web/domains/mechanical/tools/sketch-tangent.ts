// The Tangent constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-tangent", title: "Tangent", hint: "A line and a circle or arc, or two circles or arcs, touching smoothly.", group: "sketch", order: 250,
  icon: '<circle cx="12" cy="14" r="5.5"/><path d="M3 8.5h18"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-tangent",
  run: (studio) => runConstraintTool(studio, "tangent", "sketch-tangent"),
});
