// hooks.ts — React bindings for the collaboration layer of a part studio.
import { useEffect, useSyncExternalStore } from "react";
import type { PartStudio } from "../ui/studio";
import { acquireStudioCollab, studioCollab, subscribeOpen, type StudioCollab } from "./studio-collab";

/** Keep the studio's collaboration layer alive for as long as the calling component is mounted. */
export function useHoldCollab(studio: PartStudio): void {
  useEffect(() => acquireStudioCollab(studio).release, [studio]);
}

/** The studio's collaboration layer, or null until a panel holds it. */
export function useCollab(studio: PartStudio): StudioCollab | null {
  return useSyncExternalStore(subscribeOpen, () => studioCollab(studio));
}

export { useStore } from "./store";
