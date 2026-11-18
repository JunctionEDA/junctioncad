// The Dimension tool: click what to measure, click where the text goes, type the value (sketch/dimension.ts).
import { defineTool } from "../core/tool";
import { runDimensionTool } from "../sketch/dimension";

export default defineTool({
  id: "sketch-dimension", title: "Dimension", hint: "Click a line, a circle, or two things; click where the text goes; type the value.", group: "sketch", order: 300, key: "d",
  icon: '<path d="M4 7v10M20 7v10M4 12h16"/><path d="M7 9.5L4.5 12 7 14.5M17 9.5l2.5 2.5-2.5 2.5"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-dimension",
  run: (studio) => runDimensionTool(studio, "sketch-dimension"),
});
