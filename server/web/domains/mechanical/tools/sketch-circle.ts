// The Circle sketch tool: the centre, then a point on the circle (or its diameter, typed).
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { circle } from "../sketch/shapes";

export default defineTool({
  id: "sketch-circle", title: "Circle", hint: "Click the centre, then a point on the circle. Type a diameter while drawing.", group: "sketch", order: 30, key: "c",
  icon: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="1"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-circle",
  run: (studio) => startDrawTool(studio, circle),
});
