// slots.ts — places in the part studio's frame that other files may add to without editing the frame.
//
// A feature row slot is a React component drawn at the right end of every row of the feature list: who is
// editing the feature, how many comments it has, a lock.  A file (usually a panel) adds one as it loads:
//
//   addFeatureRowSlot(function Mine({ studio, featureId }) { … return <span>…</span> or null; });
//
// Keep a slot small (a dot, a count): the row is 26 px high and the name must stay readable.
import type { ComponentType } from "react";
import type { PartStudio } from "./studio";

export type FeatureRowSlot = ComponentType<{ studio: PartStudio; featureId: string }>;

export const FEATURE_ROW_SLOTS: FeatureRowSlot[] = [];

export function addFeatureRowSlot(slot: FeatureRowSlot): void { if (!FEATURE_ROW_SLOTS.includes(slot)) FEATURE_ROW_SLOTS.push(slot); }
