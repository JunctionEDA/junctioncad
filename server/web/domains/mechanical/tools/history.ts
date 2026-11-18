// History: open the version history beside the viewport (history/index.tsx): kept versions, the runs of edits
// between them, branches and merging.
import { defineTool } from "../core/tool";
import { historyUi, toggleHistory } from "../history/index";

export default defineTool({
  id: "history", title: "History", hint: "Versions, earlier states and branches", group: "file", order: 10,
  icon: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 5v4h4"/><path d="M12 8v4l3 2"/>',
  active: (studio) => historyUi(studio.getState()).open,
  run: (studio) => toggleHistory(studio),
});
