// The sketch Fillet tool: round a corner where two lines meet with a tangent arc and a radius dimension.
import { defineTool } from "../core/tool";
import { runFillet } from "../sketch/modify";

export default defineTool({
  id: "sketch-fillet", title: "Sketch fillet", hint: "Click a corner to round it. Type a radius and press Enter to change it.", group: "sketch", order: 100, key: "f",
  icon: '<path d="M5 19V11a6 6 0 0 1 6-6h8"/><circle cx="11" cy="11" r="1.2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-fillet",
  run: (studio) => runFillet(studio, "sketch-fillet"),
});
