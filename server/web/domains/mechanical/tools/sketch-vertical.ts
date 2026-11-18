// The Vertical constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-vertical", title: "Vertical", hint: "A line, or two points, upright.", group: "sketch", order: 220, key: "v",
  icon: '<path d="M12 4v16"/><circle cx="12" cy="4" r="1.4"/><circle cx="12" cy="20" r="1.4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-vertical",
  run: (studio) => runConstraintTool(studio, "vertical", "sketch-vertical"),
});
