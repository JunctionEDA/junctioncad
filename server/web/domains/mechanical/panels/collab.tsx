// The Collaborators panel: who is in this part studio and in the rest of the project, with Follow.  Mounting it
// is also what starts live collaboration for the studio (collab/studio-collab.ts): the people drawn in the
// viewport, their marks in the feature list, and the notices when two people are in one feature.
import { createPortal } from "react-dom";
import { CommentPins } from "../collab/CommentPins";
import { useCollab, useHoldCollab } from "../collab/hooks";
import { People } from "../collab/People";
import { RowPeople } from "../collab/RowBadges";
import { StageOverlay } from "../collab/StageOverlay";
import { definePanel } from "../core/tool";
import { addFeatureRowSlot } from "../ui/slots";
import type { PartStudio } from "../ui/studio";

addFeatureRowSlot(RowPeople);

function Collaborators({ studio }: { studio: PartStudio }) {
  useHoldCollab(studio);
  const c = useCollab(studio);
  if (!c) return null;
  return (
    <>
      <People c={c} />
      {createPortal(<><StageOverlay c={c} /><CommentPins c={c} /></>, studio.viewport.host)}
    </>
  );
}

export default definePanel({ id: "collaborators", title: "Collaborators", side: "right", order: 80, render: (studio) => <Collaborators studio={studio} /> });
