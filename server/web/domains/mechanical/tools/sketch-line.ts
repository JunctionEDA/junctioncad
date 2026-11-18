// The Line sketch tool: click, click; each line starts where the last ended, until Esc, Enter or a click that closes the outline.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { line } from "../sketch/shapes";

export default defineTool({
  id: "sketch-line", title: "Line", hint: "Click points; each line starts where the last ended. Type a length while drawing. Esc ends the chain.", group: "sketch", order: 10, key: "l",
  icon: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-line",
  run: (studio) => startDrawTool(studio, line),
});
