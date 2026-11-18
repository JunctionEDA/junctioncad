// Zoom to fit the whole assembly.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "fit", title: "Fit", hint: "Zoom to the whole assembly", order: 60,
  icon: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
  run: (a) => a.fit(),
});
