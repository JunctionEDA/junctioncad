// The corner Rectangle sketch tool: two opposite corners, by two clicks or one drag; four lines held horizontal and vertical.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { rectangle } from "../sketch/shapes";

export default defineTool({
  id: "sketch-rectangle", title: "Rectangle", hint: "Click two opposite corners, or drag. Type width, Tab, height.", group: "sketch", order: 20, key: "r", menu: "Rectangle",
  icon: '<rect x="4" y="7" width="16" height="10"/><circle cx="4" cy="17" r="1.4"/><circle cx="20" cy="7" r="1.4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-rectangle",
  run: (studio) => startDrawTool(studio, rectangle),
});
