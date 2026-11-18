// Delete: what is selected in the open sketch (curves, points, constraints, dimensions), or else the feature
// selected in the list.
import { defineTool } from "../core/tool";
import { deleteFeature } from "../document/edits";
import { sketchEditor } from "../sketch/editor";

export default defineTool({
  id: "delete", title: "Delete", group: "edit", order: 30, key: "Delete",
  icon: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/>',
  disabled: (studio) => {
    const s = studio.getState();
    if (!s.canEdit) return "View-only access";
    if (s.sketch) return null;   // the sketch editor keeps its own selection; an empty one is answered when pressed
    return s.selectedFeature && !s.editing ? null : "Nothing selected";
  },
  run: (studio) => {
    const s = studio.getState();
    if (s.sketch) { if (!sketchEditor(studio).deleteSelection()) studio.host.toast("Select something in the sketch to delete.", 2500); return; }
    // every row selected in the feature list goes, as one step
    const ids = s.selectedFeatures.length ? s.selectedFeatures : s.selectedFeature ? [s.selectedFeature] : [];
    if (ids.length && !s.editing && studio.doc) studio.commit(ids.flatMap((id) => deleteFeature(studio.doc!, id)));
  },
});
