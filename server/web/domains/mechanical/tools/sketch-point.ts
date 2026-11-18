// The Point sketch tool: a point on its own, for dimensions and constraints to refer to.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { point } from "../sketch/shapes";

export default defineTool({
  id: "sketch-point", title: "Point", hint: "Click to place a point.", group: "sketch", order: 55,
  icon: '<circle cx="12" cy="12" r="2"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-point",
  run: (studio) => startDrawTool(studio, point),
});
