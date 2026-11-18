// The centre Rectangle sketch tool: the centre, then a corner; the centre stays the middle of a diagonal.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { centerRectangle } from "../sketch/shapes";

export default defineTool({
  id: "sketch-center-rectangle", title: "Centre rectangle", hint: "Click the centre, then a corner.", group: "sketch", order: 22, menu: "Rectangle",
  icon: '<rect x="4" y="7" width="16" height="10"/><circle cx="12" cy="12" r="1.4"/><path d="M12 12l8-5" stroke-dasharray="2 2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-center-rectangle",
  run: (studio) => startDrawTool(studio, centerRectangle),
});
