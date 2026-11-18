// Show or hide the planes: the default three with the origin, and the reference planes (P).
import { defineTool } from "../core/tool";

export default defineTool({
  id: "toggle-planes", title: "Planes", hint: "Show or hide every plane at once. Each can be hidden on its own with the eye in the feature list.", group: "view", order: 10, key: "p",
  icon: '<path d="M4 9l8-4 8 4-8 4z"/><path d="M4 15l8 4 8-4"/>',
  active: (studio) => studio.getState().planesVisible,
  run: (studio) => studio.setPlanesVisible(!studio.getState().planesVisible),
});
