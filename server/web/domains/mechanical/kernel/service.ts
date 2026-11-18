// service.ts — worker services: questions the page asks the kernel that are not features (measure, mass
// properties, section, export).  One file under services/ default-exports a ServiceDefinition; the page calls
// it with `kernel.call("<name>", args)` (kernel/client.ts) and gets the JSON it returns.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import type { Kernel } from "./occ";
import type { ModelState, OC } from "./types";

export interface ServiceContext {
  readonly oc: OC;
  readonly k: Kernel;
  /** the model as the last regeneration left it (the bodies the page is showing) */
  readonly state: ModelState;
  /** the model just before a feature was built (null: that feature is not built); absent outside the page's worker */
  before?(featureId: string): ModelState | null;
  /** `throw ctx.fail("…")` with a message a person can act on */
  fail(message: string): Error;
}

export interface ServiceDefinition {
  /** stable name, the first argument of `kernel.call` */
  name: string;
  /** Runs in the worker.  Wrappers handed out by the kernel helpers during the call are deleted after it. */
  run(ctx: ServiceContext, args: Json): Json | Promise<Json>;
}

export function defineService(def: ServiceDefinition): ServiceDefinition { return def; }
