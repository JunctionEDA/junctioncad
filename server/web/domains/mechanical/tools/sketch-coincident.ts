// The Coincident constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-coincident", title: "Coincident", hint: "Two points onto each other, or a point onto a curve.", group: "sketch", order: 200, key: "i",
  icon: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="7"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-coincident",
  run: (studio) => runConstraintTool(studio, "coincident", "sketch-coincident"),
});
