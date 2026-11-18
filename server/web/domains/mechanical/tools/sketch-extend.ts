// The Extend tool: lengthen the end of a line or an arc to the next curve it would meet.
import { defineTool } from "../core/tool";
import { runExtend } from "../sketch/modify";

export default defineTool({
  id: "sketch-extend", title: "Extend", hint: "Click near the end of a line or an arc to lengthen it to the next curve.", group: "sketch", order: 120, key: "x",
  icon: '<path d="M19 4v16"/><path d="M4 12h8"/><path d="M12 12h7" stroke-dasharray="2 2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-extend",
  run: (studio) => runExtend(studio, "sketch-extend"),
});
