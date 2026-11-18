// Insert parts of the project's part studios, and its other assemblies, as instances.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "insert", title: "Insert", hint: "Place parts and sub-assemblies of this project", order: 10, key: "i",
  icon: '<path d="M12 3l7 4v8l-7 4-7-4V7z"/><path d="M12 9v6"/><path d="M9 12h6"/>',
  disabled: (a) => (a.getState().canEdit ? null : "you have view-only access"),
  active: (a) => !!a.getState().inserting && !a.getState().inserting!.replace,
  run: (a) => { if (a.getState().inserting) a.closeInsert(); else a.openInsert(); },
});
