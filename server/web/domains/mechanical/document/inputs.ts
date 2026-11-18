// inputs.ts — a part studio document as the modelling worker's input.  THE one place that is worked out:
// the part studio's own page, an assembly drawing an instance, Compare, the history view, the assistant's host,
// the board editor's enclosure and anything else that rebuilds a studio all call `studioInputs`, so they all
// build the same model.
//
//   features of the document, in order            (document/format.ts featuresOf, featureInputs)
//   numbers typed as expressions follow variables  (document/variables.ts resolveInputs)
//   input filters, in order                        what a feature needs that is not in this document: the Board
//                                                  feature's board (`$board`), read live from another document.
//                                                  The page's is board/link.ts; everything else uses
//                                                  board/feed.ts BoardFeed.
import type { ItemDoc } from "../../../shared/itemdoc/itemdoc";
import type { FeatureInput } from "../kernel/protocol";
import { featureInputs, featuresOf, rollbackIndex, type FeatureItem } from "./format";
import { resolveInputs, variableValues, variablesOf } from "./variables";

/** Called on the worker's input just before a regeneration; may return a changed copy.  What it adds is never stored. */
export type InputFilter = (inputs: FeatureInput[]) => FeatureInput[];

export interface StudioInput { features: FeatureInput[]; /** how many of them are built: the rollback bar's place */ rollback: number }

export interface StudioInputOptions {
  /** the feature list to build in place of the document's own (a page lays the open dialog's draft over it) */
  features?: FeatureItem[];
  /** the rollback to use with `features` */
  rollback?: number;
  filters?: readonly InputFilter[];
}

/** What a worker is given to build this part studio. */
export function studioInputs(doc: ItemDoc, o: StudioInputOptions = {}): StudioInput {
  const features = o.features || featuresOf(doc);
  const rollback = o.features && o.rollback !== undefined ? o.rollback : rollbackIndex(doc, features);
  const vv = variableValues(variablesOf(doc));
  let inputs = resolveInputs(featureInputs(features), vv.values, vv.dims);
  for (const filter of o.filters || []) inputs = filter(inputs);
  return { features: inputs, rollback };
}
