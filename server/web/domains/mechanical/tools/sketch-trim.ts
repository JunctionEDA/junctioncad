// The Trim tool: cut a curve back to where other curves cross it.
import { defineTool } from "../core/tool";
import { runTrim } from "../sketch/modify";

export default defineTool({
  id: "sketch-trim", title: "Trim", hint: "Click the part of a curve to cut away.", group: "sketch", order: 110, key: "t",
  icon: '<path d="M4 6l16 12" stroke-dasharray="3 3"/><path d="M4 18L12 12"/><path d="M12 12l8-6" opacity=".35"/><circle cx="12" cy="12" r="1.4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-trim",
  run: (studio) => runTrim(studio, "sketch-trim"),
});
