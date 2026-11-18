// mate.ts — the mate contract: what one file under mates/ exports.
//
// A mate type is a MateDefinition: an id, a name, default parameters, the fields of its dialog, the freedoms it
// leaves, and `place`, which says where the second instance must be for this one mate to hold.  That is enough
// for assemblies built one mate at a time against a fixed part.  Solving several mates at once (loops, mates
// that only together fix a part) needs a constraint solver over the placements; when one is added it reads the
// same definitions, so `place` stays as the single-mate case and the solver's own hook is added beside it.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Frame, ParamField } from "../../mechanical/api";
import type { Transform } from "../document/format";
import type { MateSolve } from "../solver/types";

export interface MateDefinition {
  /** Stable id, stored in documents as `mateType`.  Never rename one that has shipped. */
  type: string;
  title: string;
  /** inline SVG markup for a 24×24 stroke glyph (currentColor) */
  icon?: string;
  defaults(): JsonObject;
  /** The fields of the mate's dialog; the two connectors are always asked for and are not listed here. */
  schema: ParamField[];
  /** The freedoms the mate leaves between its two instances: how many translations and rotations (0 to 3 each). */
  freedom: { translation: number; rotation: number };
  /**
   * Where instance b must be so that its connector meets a's.  `a` and `b` are the connectors' coordinate systems
   * in assembly space as the instances stand now (b's through b's current transform, `bNow`).  Return b's new
   * transform.  The freedoms the mate leaves keep b as close to where it is as they allow.
   */
  place(a: Frame, b: Frame, bNow: Transform, params: JsonObject): Transform;
  /**
   * The solver's hook, beside `place`: this mate's residuals (zero when it holds), the values it leaves free
   * (an angle, a distance: what limits, dragging and animation act on) and whether it welds its two instances.
   * A mate without it is kept in the document and shown, but the solver does not enforce it.  See
   * solver/types.ts (MateSolve) and the helpers in mates/_residuals.ts.
   */
  solve?: MateSolve;
  /** lower first in the toolbar; ties in title order */
  order?: number;
}

export function defineMate(def: MateDefinition): MateDefinition { return def; }
