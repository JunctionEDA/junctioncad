// The three-point Arc sketch tool: start, end, then a point the arc passes through.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { arc3 } from "../sketch/shapes";

export default defineTool({
  id: "sketch-arc-3point", title: "Arc", hint: "Click the start, the end, then a point on the arc.", group: "sketch", order: 40, key: "a", menu: "Arc",
  icon: '<path d="M4 17a9 9 0 0 1 16 0"/><circle cx="4" cy="17" r="1.4"/><circle cx="20" cy="17" r="1.4"/><circle cx="12" cy="8.2" r="1.4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-arc-3point",
  run: (studio) => startDrawTool(studio, arc3),
});
