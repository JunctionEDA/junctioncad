// View mode: shaded with edges → shaded → wireframe → hidden line, round again (W).
import { defineTool } from "../core/tool";
import { VIEW_MODES, displayOf } from "../inspect/appearance-display";

export default defineTool({
  id: "appearance-view-mode", title: "Display", group: "view", order: 20, key: "w",
  hint: "Shaded with edges, shaded, wireframe or hidden line (W)",
  icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  active: (studio) => displayOf(studio).getState().mode !== "shaded-edges",
  run: (studio) => {
    const d = displayOf(studio);
    d.cycleMode();
    studio.host.toast(VIEW_MODES.find((m) => m.id === d.getState().mode)?.title || "", 1200);
  },
});
