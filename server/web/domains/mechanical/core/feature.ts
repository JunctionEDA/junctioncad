// feature.ts — the feature contract: what one file under features/ exports.
//
// A feature type is a FeatureDefinition: an id, a name, default parameters, a schema the property dialog is
// generated from, and `evaluate`, which runs in the modelling worker and turns the parameters into geometry.
// The same file is bundled into the page (for the id, defaults and schema) and into the worker (for evaluate),
// so a feature file must not touch the DOM, three.js or React at module level, and `evaluate` must use only
// what its context hands it.  See CONTRACT.md for a worked example.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { EvalContext } from "../kernel/types";
import type { GeomKind } from "./geometry";

/** One field of the generated property dialog.  `key` is the parameter's key in `params`. */
export type ParamField = { key: string; label: string; hint?: string; visible?: (params: JsonObject) => boolean } & (
  | { kind: "number"; unit?: "mm" | "deg" | "none"; min?: number; max?: number; step?: number }
  | { kind: "boolean" }
  | { kind: "text" }
  | { kind: "enum"; options: { value: string; label: string }[] }
  /** a sketch made earlier in the tree: stores `{ sketch: <feature id>, regions: null | string[] }` */
  | { kind: "profile" }
  /** a sketch plane: stores a PlaneRef (a default plane, or a planar face picked in the viewport) */
  | { kind: "plane" }
  /**
   * faces, edges or vertices picked in the viewport: stores GeomRef[] (or one GeomRef when `single`).  With
   * `datums`, `planes` or `sketch` it also takes reference geometry, the default planes or sketch curves, and
   * stores a RefTarget (features/_refs.ts) for those picks.
   */
  | { kind: "refs"; of: GeomKind[]; single?: boolean; datums?: ("plane" | "axis" | "point" | "curve")[]; planes?: boolean; sketch?: boolean }
  /** earlier features of the tree, in the order picked: stores string[] of feature ids */
  | { kind: "features"; types?: string[]; exclude?: string[] }
  /** bodies picked in the viewport or from the list: stores string[] of body ids; empty means every body */
  | { kind: "bodies" }
  /** another document of the project, chosen from a list: stores its document id (a string), or null */
  | { kind: "document"; docTypes: string[] }
);

export interface FeatureDefinition<P extends JsonObject = JsonObject> {
  /** Stable id, stored in documents as `featureType`.  Never rename one that has shipped. */
  type: string;
  /** The name people see, and the stem of a new feature's name ("Extrude 1"). */
  title: string;
  /** inline SVG markup for a 24×24 stroke glyph (currentColor), for the toolbar and the feature list */
  icon?: string;
  /** Parameters of a new feature.  Called once per new feature; return a fresh object. */
  defaults(): P;
  /** The fields of the property dialog, in order.  A feature with its own editor (a sketch) may leave it empty. */
  schema: ParamField[];
  /**
   * Build the feature.  Runs in the worker, after every earlier feature.  Read and change the model through
   * `ctx`; throw `ctx.fail("…")` with a message a person can act on.  May be async.
   */
  evaluate(ctx: EvalContext, params: P): void | Promise<void>;
  /** false keeps the feature off the generated toolbar (it is created some other way) */
  toolbar?: boolean;
  /** where the toolbar button goes; lower first.  Features without one follow in title order. */
  toolbarOrder?: number;
  /** which part of the toolbar the button is in ("solid" when not given) */
  toolbarSection?: FeatureSection;
  /**
   * Features of one section that name the same menu share one drop-down button with that title (Fillet,
   * Chamfer and Draft under "Fillet").  A feature without one has a button of its own.
   */
  toolbarMenu?: string;
}

/** The feature parts of the toolbar, in the order they are drawn. */
export type FeatureSection = "sketch" | "solid" | "pattern" | "reference" | "board";
export const FEATURE_SECTIONS: readonly FeatureSection[] = ["sketch", "solid", "pattern", "reference", "board"];

/** Typed helper: `export default defineFeature<MyParams>({ ... })`. */
export function defineFeature<P extends JsonObject>(def: FeatureDefinition<P>): FeatureDefinition<JsonObject> {
  return def as unknown as FeatureDefinition<JsonObject>;
}
