// The Tangent arc sketch tool: leaves the end of a line or an arc smoothly and ends where clicked.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { arcTangent } from "../sketch/shapes";

export default defineTool({
  id: "sketch-arc-tangent", title: "Tangent arc", hint: "Click the end of a line or an arc, then where the arc ends.", group: "sketch", order: 44, menu: "Arc",
  icon: '<path d="M4 18h7a7 7 0 0 0 7-7V5"/><circle cx="11" cy="18" r="1.4"/><circle cx="18" cy="5" r="1.4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-arc-tangent",
  run: (studio) => startDrawTool(studio, arcTangent),
});
