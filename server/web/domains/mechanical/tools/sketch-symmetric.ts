// The Symmetric constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-symmetric", title: "Symmetric", hint: "Two points mirrored about a line or a point.", group: "sketch", order: 295,
  icon: '<path d="M12 4v16" stroke-dasharray="2 2"/><path d="M4 12h5M20 12h-5M6.5 9.5L9 12l-2.5 2.5M17.5 9.5L15 12l2.5 2.5"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-symmetric",
  run: (studio) => runConstraintTool(studio, "symmetric", "sketch-symmetric"),
});
