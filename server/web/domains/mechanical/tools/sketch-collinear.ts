// The Collinear constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-collinear", title: "Collinear", hint: "Two lines along the same line.", group: "sketch", order: 290,
  icon: '<path d="M3 12h7M14 12h7"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="20.5" cy="12" r="1.2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-collinear",
  run: (studio) => runConstraintTool(studio, "collinear", "sketch-collinear"),
});
