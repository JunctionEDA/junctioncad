// The Slot sketch tool: the centres of the two ends, then the width; two lines and two arcs, tangent where they join.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { slot } from "../sketch/shapes";

export default defineTool({
  id: "sketch-slot", title: "Slot", hint: "Click the centre of each end, then set the width.", group: "sketch", order: 50,
  icon: '<path d="M8 8h8a4 4 0 0 1 0 8H8a4 4 0 0 1 0-8z"/><path d="M8 12h8" stroke-dasharray="2 2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-slot",
  run: (studio) => startDrawTool(studio, slot),
});
