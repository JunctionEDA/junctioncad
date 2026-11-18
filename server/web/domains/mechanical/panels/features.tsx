// The Features panel: the history tree (ui/FeatureList.tsx).  A panel is one file here; see core/tool.ts.
import { definePanel } from "../core/tool";
import { FeatureList } from "../ui/FeatureList";

export default definePanel({ id: "features", title: "Features", side: "left", order: 10, count: (studio) => studio.getState().features.length || null, render: (studio) => <FeatureList studio={studio} /> });
