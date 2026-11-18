// exchange-stepinfo.ts — the product structure of a STEP file, read from its text: which parts it holds, what
// they are called and how they are put together.  Pure (no kernel), so it runs in the worker and in tests.
//
// The kernel build reads geometry but not names (it has no STEPCAFControl_Reader), so the names an imported
// body gets come from here.  Only the entities that carry the structure are parsed:
//
//   PRODUCT('id','name',…)                               a part or an assembly
//   PRODUCT_DEFINITION_FORMATION(…,#product,…)           a version of it
//   PRODUCT_DEFINITION('id','desc',#formation,#context)  the definition shapes and assemblies refer to
//   NEXT_ASSEMBLY_USAGE_OCCURRENCE('id','name','desc',#parent definition,#child definition,…)
//   PRODUCT_DEFINITION_SHAPE('','',#definition)  and  SHAPE_DEFINITION_REPRESENTATION(#pds,#representation)
//   …SHAPE_REPRESENTATION('',(#items),#context), SHAPE_REPRESENTATION_RELATIONSHIP('','',#a,#b) and the solids
//   (MANIFOLD_SOLID_BREP, BREP_WITH_VOIDS, FACETED_BREP): how many solids each part's own shape has
//
// What it cannot do, honestly: it does not know which solid of the geometry belongs to which product; the
// import matches them by count and order (features/import-file.ts).

export interface StepProduct { id: string; name: string }
export interface StepOccurrence { name: string; child: number }
export interface StepStructure {
  /** product definition entity → its product */
  products: Map<number, StepProduct>;
  /** product definition entity → the occurrences of other definitions in it, in file order */
  children: Map<number, StepOccurrence[]>;
  /** entity number → the product definition it stands for (definitions, their shapes and representations) */
  definitionOf: Map<number, number>;
  /** the definitions nothing else uses: the top of the tree */
  roots: number[];
  /** product definition → how many solids its own shape holds (not counting its components') */
  solids: Map<number, number>;
  /** the file's header FILE_NAME: originating system, when it says */
  system: string;
}

/** Decode a STEP string literal's body (between the quotes): '' and the \X\, \X2\ … \X0\ escapes. */
export function stepString(s: string): string {
  return s.replace(/''/g, "'")
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_m, hex: string) => { let out = ""; for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)); return out; })
    .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_m, hex: string) => { let out = ""; for (let i = 0; i + 8 <= hex.length; i += 8) out += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16)); return out; })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_m, c: string) => String.fromCharCode(c.charCodeAt(0) + 128))
    .replace(/\\\\/g, "\\");
}

/** Split the top level of an argument list: strings, references, nested lists and $ / * stay whole. */
export function stepArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else inStr = false; } continue; }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

const str = (a: string | undefined): string => (a && a.startsWith("'") && a.endsWith("'") ? stepString(a.slice(1, -1)) : "");
const ref = (a: string | undefined): number => (a && a.startsWith("#") ? parseInt(a.slice(1), 10) : 0);

const WANTED = /#(\d+)\s*=\s*(PRODUCT|PRODUCT_DEFINITION_FORMATION|PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE|PRODUCT_DEFINITION|PRODUCT_DEFINITION_SHAPE|NEXT_ASSEMBLY_USAGE_OCCURRENCE|SHAPE_DEFINITION_REPRESENTATION|SHAPE_REPRESENTATION_RELATIONSHIP|MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|[A-Z_]*SHAPE_REPRESENTATION)\s*\(/g;

/** The product structure of a STEP file's text (or its bytes). */
export function stepStructure(input: string | Uint8Array): StepStructure {
  const text = typeof input === "string" ? input : new TextDecoder("latin1").decode(input);
  const product = new Map<number, StepProduct>(), formation = new Map<number, number>(), definition = new Map<number, number>();
  const pds = new Map<number, number>(), sdr: [number, number, number][] = [], nauo: { parent: number; child: number; name: string }[] = [];
  const reps = new Map<number, number[]>(), links: [number, number][] = [], solidIds = new Set<number>();
  WANTED.lastIndex = 0;
  for (let m = WANTED.exec(text); m; m = WANTED.exec(text)) {
    const id = parseInt(m[1], 10), type = m[2];
    // the arguments run to the ");" that ends the entity (strings may hold ";" and ")")
    let i = WANTED.lastIndex, depth = 1, inStr = false;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (inStr) { if (c === "'") { if (text[i + 1] === "'") i++; else inStr = false; } continue; }
      if (c === "'") inStr = true; else if (c === "(") depth++; else if (c === ")") depth--;
    }
    const args = stepArgs(text.slice(WANTED.lastIndex, i - 1));
    WANTED.lastIndex = i;
    switch (type) {
      case "PRODUCT": product.set(id, { id: str(args[0]), name: str(args[1]) || str(args[0]) }); break;
      case "PRODUCT_DEFINITION_FORMATION": case "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE": formation.set(id, ref(args[2])); break;
      case "PRODUCT_DEFINITION": definition.set(id, ref(args[2])); break;
      case "PRODUCT_DEFINITION_SHAPE": pds.set(id, ref(args[2])); break;
      case "SHAPE_DEFINITION_REPRESENTATION": sdr.push([id, ref(args[0]), ref(args[1])]); break;
      case "NEXT_ASSEMBLY_USAGE_OCCURRENCE": nauo.push({ parent: ref(args[3]), child: ref(args[4]), name: str(args[1]) || str(args[0]) }); break;
      case "SHAPE_REPRESENTATION_RELATIONSHIP": links.push([ref(args[2]), ref(args[3])]); break;
      case "MANIFOLD_SOLID_BREP": case "BREP_WITH_VOIDS": case "FACETED_BREP": solidIds.add(id); break;
      default:   // a …SHAPE_REPRESENTATION: its items
        if (type.endsWith("SHAPE_REPRESENTATION")) reps.set(id, (args[1] || "").replace(/[()\s]/g, "").split(",").map(ref).filter((n) => n > 0));
    }
  }
  const products = new Map<number, StepProduct>();
  for (const [pd, f] of definition) { const p = product.get(formation.get(f) || 0); if (p) products.set(pd, p); }
  const children = new Map<number, StepOccurrence[]>();
  const used = new Set<number>();
  for (const n of nauo) { if (!children.has(n.parent)) children.set(n.parent, []); children.get(n.parent)!.push({ name: n.name, child: n.child }); used.add(n.child); }
  const definitionOf = new Map<number, number>();
  for (const pd of definition.keys()) definitionOf.set(pd, pd);
  for (const [s, pd] of pds) if (definition.has(pd)) definitionOf.set(s, pd);
  for (const [id, s, rep] of sdr) { const pd = pds.get(s); if (pd && definition.has(pd)) { definitionOf.set(id, pd); if (!definitionOf.has(rep)) definitionOf.set(rep, pd); } }
  const roots = Array.from(definition.keys()).filter((pd) => !used.has(pd)).sort((a, b) => a - b);
  // a part's own solids: the items of its representation and of the representations related to it (the plain
  // relationships a CAD tool writes between a part's shape representation and its B-rep one; the placements of
  // components are complex entities, which are not read here)
  const near = new Map<number, number[]>();
  for (const [a, b] of links) { if (!near.has(a)) near.set(a, []); if (!near.has(b)) near.set(b, []); near.get(a)!.push(b); near.get(b)!.push(a); }
  const solids = new Map<number, number>();
  for (const [, s, rep] of sdr) {
    const pd = pds.get(s); if (!pd || !definition.has(pd)) continue;
    const seen = new Set<number>([rep]), todo = [rep];
    let n = 0;
    while (todo.length) { const r = todo.pop()!; for (const it of reps.get(r) || []) if (solidIds.has(it)) n++; for (const o of near.get(r) || []) if (!seen.has(o) && reps.has(o)) { seen.add(o); todo.push(o); } }
    solids.set(pd, (solids.get(pd) || 0) + n);
  }
  const header = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(text.slice(0, 4096));
  const system = header ? str(stepArgs(header[1])[5]) : "";
  return { products, children, definitionOf, roots, solids, system };
}

/**
 * The leaf parts under a definition, depth first, in the order the assembly lists them: one entry per use of
 * a part (a screw used four times appears four times).
 */
export function leafParts(s: StepStructure, definition: number, path: string[] = [], seen = new Set<number>()): { name: string; path: string[]; definition: number }[] {
  const kids = s.children.get(definition);
  const own = s.products.get(definition)?.name || "Part";
  if (!kids || !kids.length || seen.has(definition)) return [{ name: own, path: [...path, own], definition }];
  seen.add(definition);
  const out: { name: string; path: string[]; definition: number }[] = [];
  for (const k of kids) out.push(...leafParts(s, k.child, [...path, own], seen));
  seen.delete(definition);
  return out;
}

/** The product a root entity of the reader stands for, by name, or "". */
export function rootName(s: StepStructure, entity: number): string {
  const pd = s.definitionOf.get(entity);
  return (pd && s.products.get(pd)?.name) || "";
}
