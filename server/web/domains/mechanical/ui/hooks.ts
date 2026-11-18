// hooks.ts — React bindings for a part studio.
import { useSyncExternalStore } from "react";
import type { PartStudio, StudioState } from "./studio";

/** Select a slice of the studio's state; the component re-renders when the selected value changes (Object.is). */
export function useStudio<T>(studio: PartStudio, selector: (s: StudioState) => T): T {
  return useSyncExternalStore(studio.subscribe, () => selector(studio.getState()));
}
