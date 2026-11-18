// The Perpendicular constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-perpendicular", title: "Perpendicular", hint: "Two lines square to each other.", group: "sketch", order: 240,
  icon: '<path d="M4 19h16M12 19V5"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-perpendicular",
  run: (studio) => runConstraintTool(studio, "perpendicular", "sketch-perpendicular"),
});
