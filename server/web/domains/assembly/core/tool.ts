// tool.ts — the assembly toolbar contract: one file under tools/ default-exports an AssemblyToolDefinition and
// its button appears (Insert, Mate, Explode, Interference, BOM …).  Same idea as the part studio's tools.
import type { AssemblyEditor } from "../ui/assembly";

export interface AssemblyToolDefinition {
  id: string;
  title: string;
  hint?: string;
  /** inline SVG markup for a 24×24 stroke glyph (currentColor) */
  icon?: string;
  /** lower first; ties in title order */
  order?: number;
  key?: string;
  disabled?(assembly: AssemblyEditor): string | null;
  active?(assembly: AssemblyEditor): boolean;
  run(assembly: AssemblyEditor): void;
}

export function defineAssemblyTool(def: AssemblyToolDefinition): AssemblyToolDefinition { return def; }
