// The Parallel constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-parallel", title: "Parallel", hint: "Two lines parallel.", group: "sketch", order: 230, key: "b",
  icon: '<path d="M6 19L12 5M12 19l6-14"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-parallel",
  run: (studio) => runConstraintTool(studio, "parallel", "sketch-parallel"),
});
