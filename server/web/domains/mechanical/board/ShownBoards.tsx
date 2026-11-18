// ShownBoards.tsx — the first part of the Board panel (boardlink/Panel.tsx): the boards this part studio brings
// in (Board features), whether each is being followed live, and the way to its own editor.  Importing
// board/link.ts is also what starts the link for every studio.
import { useEffect, useReducer } from "react";
import { boardLinkOf } from "./link";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

const title = (path: string): string => (path.split("/").pop() || path).replace(/\.[^.]+$/, "");

export function ShownBoards({ studio }: { studio: PartStudio }) {
  const link = boardLinkOf(studio);
  const [, again] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (link ? link.subscribe(again) : undefined), [link]);
  useStudio(studio, (s) => s.features);
  const boards = link ? link.boards() : [];
  if (!boards.length) return <p className="note px-2 py-1 m-0" data-section="shown">No board is shown here yet. Choose Board in the toolbar to bring one of the project’s boards into the model.</p>;
  return (
    <div className="flex flex-col py-1 text-sm" role="list" aria-label="Boards shown in this part studio" data-section="shown">
      {boards.map((b) => (
        <div key={b.featureId} role="listitem" data-board={b.docId} data-state={b.status.state} className="flex items-center gap-1.5 min-h-7 px-2">
          <span className={"flex-none w-2 h-2 rounded-full " + (b.status.state === "live" ? "bg-ok" : b.status.state === "error" ? "bg-err" : "bg-ink-3")} title={b.status.text} />
          <span className="flex-1 min-w-0 truncate" title={`${b.name}: ${b.path || "a board that is no longer in the project"} (${b.status.text})`}>
            {b.name} <span className="text-ink-3">{b.path ? title(b.path) : "missing"}</span>
          </span>
          {b.path ? <button type="button" className="btn sm ghost flex-none" data-open-board={b.docId} title="Open this board in the board editor" onClick={() => studio.host.openDoc(b.docId)}>Open</button> : null}
        </div>
      ))}
    </div>
  );
}

