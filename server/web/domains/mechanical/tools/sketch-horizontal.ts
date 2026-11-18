// The Horizontal constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-horizontal", title: "Horizontal", hint: "A line, or two points, level.", group: "sketch", order: 210, key: "h",
  icon: '<path d="M4 12h16"/><circle cx="4" cy="12" r="1.4"/><circle cx="20" cy="12" r="1.4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-horizontal",
  run: (studio) => runConstraintTool(studio, "horizontal", "sketch-horizontal"),
});
