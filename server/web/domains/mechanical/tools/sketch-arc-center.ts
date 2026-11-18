// The centre-point Arc sketch tool: the centre, where the arc starts, and round to where it ends.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { centerArc } from "../sketch/shapes";

export default defineTool({
  id: "sketch-arc-center", title: "Centre arc", hint: "Click the centre, the start, then move round and click the end.", group: "sketch", order: 42, menu: "Arc",
  icon: '<path d="M19 16A8 8 0 0 0 9.5 6.4"/><circle cx="11" cy="16" r="1.4"/><path d="M11 16h8M11 16L9.5 6.4" stroke-dasharray="2 2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-arc-center",
  run: (studio) => startDrawTool(studio, centerArc()),
});
