// Section view: cut the model by a plane (a default plane, or the selected flat face) to see inside it.
import { defineTool } from "../core/tool";
import { toggleSection } from "../inspect/section-pick";
import { sectionOf } from "../inspect/section-view";

export default defineTool({
  id: "section-view", title: "Section", hint: "Cut the view by a plane: the selected flat face, or Front (X)", group: "inspect", order: 20, key: "x",
  icon: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 12h16" stroke-dasharray="2 2"/><path d="M12 12v8"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : !studio.getState().bodies.length ? "Nothing to cut" : null),
  active: (studio) => sectionOf(studio).getState().on,
  run: (studio) => { void toggleSection(studio); },
});
