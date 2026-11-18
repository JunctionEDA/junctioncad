// The Mirror tool: copies across a line that stay its mirror image.
import { defineTool } from "../core/tool";
import { runMirror } from "../sketch/modify";

export default defineTool({
  id: "sketch-mirror", title: "Mirror", hint: "Select what to mirror, then click the line to mirror about.", group: "sketch", order: 140, key: "m",
  icon: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 17h5z"/><path d="M15 7l5 10h-5z" opacity=".6"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-mirror",
  run: (studio) => runMirror(studio, "sketch-mirror"),
});
