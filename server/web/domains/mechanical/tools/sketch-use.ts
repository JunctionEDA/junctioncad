// The Use tool: draw an edge or a corner of the model in the sketch, projected onto the sketch plane.
import { defineTool } from "../core/tool";
import { runUse } from "../sketch/modify";

export default defineTool({
  id: "sketch-use", title: "Use edge", hint: "Click an edge or a corner of the model to draw it in the sketch.", group: "sketch", order: 150, key: "u",
  icon: '<path d="M5 8l7-4 7 4-7 4z"/><path d="M5 16l7 4 7-4" stroke-dasharray="2 2"/><path d="M12 12v8"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-use",
  run: (studio) => runUse(studio, "sketch-use"),
});
