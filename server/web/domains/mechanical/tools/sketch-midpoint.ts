// The Midpoint constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-midpoint", title: "Midpoint", hint: "A point onto the middle of a line.", group: "sketch", order: 270,
  icon: '<path d="M4 17h16"/><circle cx="12" cy="17" r="2"/><path d="M12 6v7"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-midpoint",
  run: (studio) => runConstraintTool(studio, "midpoint", "sketch-midpoint"),
});
