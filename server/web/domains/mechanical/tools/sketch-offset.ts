// The Offset tool: a copy of curves a set distance to one side, kept parallel and driven by one dimension.
import { defineTool } from "../core/tool";
import { runOffset } from "../sketch/modify";

export default defineTool({
  id: "sketch-offset", title: "Offset", hint: "Select curves (or click one), then click the side. Type a distance to set it.", group: "sketch", order: 130, key: "o",
  icon: '<path d="M5 19V9a4 4 0 0 1 4-4h10"/><path d="M10 19v-8a1 1 0 0 1 1-1h8" opacity=".6"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-offset",
  run: (studio) => runOffset(studio, "sketch-offset"),
});
