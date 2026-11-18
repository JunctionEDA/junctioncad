// The Fix constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-fix", title: "Fix", hint: "Pin a point or a curve where it is.", group: "sketch", order: 298,
  icon: '<circle cx="12" cy="7" r="2.5"/><path d="M12 9.5V19M7 19h10M8 14h8"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-fix",
  run: (studio) => runConstraintTool(studio, "fix", "sketch-fix"),
});
