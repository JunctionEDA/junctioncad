// The Board panel: the boards this part studio shows (Board features) and the board it drives
// (boardlink/Panel.tsx).  It is unfolded by itself once the part studio has to do with a board.
import { definePanel } from "../core/tool";
import { BoardLinkPanel } from "../boardlink/Panel";
import { linksOf } from "../boardlink/format";

export default definePanel({
  id: "boardlink", title: "Board", side: "right", order: 40,
  open: (studio) => studio.getState().features.some((f) => f.featureType === "board-reference") || (!!studio.doc && linksOf(studio.doc).length > 0),
  render: (studio) => <BoardLinkPanel studio={studio} />,
});
