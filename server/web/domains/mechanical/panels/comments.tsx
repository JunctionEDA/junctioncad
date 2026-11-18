// The Comments panel: the document's review threads, each pinned to a feature, a face, an edge or a vertex
// (collab/comments.ts).  The pins themselves are drawn over the viewport by the Collaborators panel's overlay.
import { CommentsList } from "../collab/CommentsList";
import { useCollab, useHoldCollab } from "../collab/hooks";
import { RowComments } from "../collab/RowBadges";
import { definePanel } from "../core/tool";
import { addFeatureRowSlot } from "../ui/slots";
import type { PartStudio } from "../ui/studio";

addFeatureRowSlot(RowComments);

function Comments({ studio }: { studio: PartStudio }) {
  useHoldCollab(studio);
  const c = useCollab(studio);
  return c ? <CommentsList c={c} /> : null;
}

export default definePanel({ id: "comments", title: "Comments", side: "right", order: 90, open: false, render: (studio) => <Comments studio={studio} /> });
