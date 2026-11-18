// Comment: start a review thread pinned to the selected face, edge, vertex or feature; with nothing selected,
// on the next thing clicked.  The threads are the platform's comments (collab/comments.ts).
import { startComment } from "../collab/CommentsList";
import { studioCollab } from "../collab/studio-collab";
import { defineTool } from "../core/tool";
import { showPanel } from "../ui/panels";

export default defineTool({
  id: "comment", title: "Comment", hint: "Pin a comment to a face, an edge, a vertex or a feature", group: "inspect", order: 90,
  icon: '<path d="M5 5h14v10H10l-5 4z"/>',
  disabled: (studio) => {
    const s = studio.getState();
    if (!studio.host.signedIn) return "Sign in to comment";
    if (s.status.role !== "editor" && s.status.role !== "commenter") return "You have view-only access";
    if (s.sketch) return "Finish the sketch first";
    if (s.editing) return "Finish the open dialog first";
    return null;
  },
  active: (studio) => !!studioCollab(studio)?.comments.getState().picking,
  run: (studio) => { const c = studioCollab(studio); if (c) { showPanel("comments"); startComment(studio, c); } },
});
