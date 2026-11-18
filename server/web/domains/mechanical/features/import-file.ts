// import-file.ts — the Import feature: a STEP or BREP file stored with the project, read into real B-rep
// bodies that later features can cut, fillet and sketch on.
//
// params: { file: { docId, path, name, bytes, format } | null, split: "solids" | "one" }
//
// The file itself is a document of the project (kernel/ops/exchange-files.ts); the feature only names it, so
// every collaborator and every reload reads the same bytes.  The Import tool (tools/import-file.ts) uploads the
// file and adds this feature; it has no toolbar button of its own.
//
// Names.  An imported face is `<feature>:s<solid>:f<face>`: the solid's place in the file and the face's place
// in that solid, in OpenCascade's explorer order.  Edges and vertices follow from the faces as everywhere else.
// The order is fixed for a given file, so references survive any rebuild and any change after the import.  They
// do NOT survive replacing the file with another version: a re-exported file may list solids and faces in a
// different order, and a reference may then land on another face or fail.
//
// Body names come from the file's products (kernel/ops/exchange-stepinfo.ts).  A file of several top-level
// products names each body after its product; an assembly names its solids after its leaf parts, in the order
// the assembly lists them, when the solids add up (one per occurrence, or as many as each part's shape holds),
// and "<assembly> n" otherwise.  Checked against an XCAF reader on six assemblies from the demos.
import { defineFeature } from "../core/feature";
import { importCache, importKey } from "../kernel/ops/exchange-cache";
import { projectFileBytes, type ProjectFileRef } from "../kernel/ops/exchange-files";
import { bodiesOf, readBrep, readStep, sniffFormat, type ReadResult } from "../kernel/ops/exchange-step";
import { leafParts, rootName, stepStructure } from "../kernel/ops/exchange-stepinfo";
import type { EvalContext, Shape } from "../kernel/types";

export interface ImportParams {
  [key: string]: any;   // eslint-disable-line @typescript-eslint/no-explicit-any
  file: (ProjectFileRef & { format?: "step" | "brep" }) | null;
  split: "solids" | "one";
}

const stem = (p: string): string => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");

/** One name per body, in the order of `perRoot` (bodies of root 0, then of root 1, …). */
export function importNames(bytes: Uint8Array | null, read: ReadResult, perRoot: number[], fallback: string): string[] {
  const names: string[] = [];
  let s: ReturnType<typeof stepStructure> | null = null;
  if (bytes && read.roots.length) { try { s = stepStructure(bytes); } catch (e) { s = null; } }
  const roots = read.roots.length ? read.roots : [{ entity: 0, shape: read.shape }];
  roots.forEach((r, i) => {
    const n = perRoot[i] || 0;
    const own = (s && rootName(s, r.entity)) || (roots.length > 1 ? `${fallback} ${i + 1}` : fallback);
    const pd = s ? s.definitionOf.get(r.entity) : undefined;
    const leaves = s && pd && s.children.get(pd)?.length ? leafParts(s, pd) : null;
    if (leaves && leaves.length === n) { for (const l of leaves) names.push(l.name); return; }
    // parts made of several solids: as many names per part as its shape has solids
    if (leaves && s && leaves.reduce((t, l) => t + (s!.solids.get(l.definition) || 0), 0) === n) {
      for (const l of leaves) { const c = s.solids.get(l.definition) || 0; for (let j = 0; j < c; j++) names.push(c === 1 ? l.name : `${l.name} ${j + 1}`); }
      return;
    }
    for (let j = 0; j < n; j++) names.push(n === 1 ? own : `${own} ${j + 1}`);
  });
  return names;
}

export default defineFeature<ImportParams>({
  type: "import",
  title: "Import",
  icon: '<path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  toolbar: false,
  defaults: () => ({ file: null, split: "solids" }),
  schema: [
    { key: "split", label: "Bodies", kind: "enum", options: [{ value: "solids", label: "One per solid" }, { value: "one", label: "One body" }], hint: "Each solid of the file becomes a part, or the whole file is one part" },
  ],
  async evaluate(ctx: EvalContext, p: ImportParams) {
    const file = p.file;
    if (!file || !file.docId) throw ctx.fail("Choose a file to import.");
    const fileName = file.name || stem(file.path);
    const fid = ctx.feature.id;
    const namer = (tag: string) => (_face: unknown, index: number) => `${fid}:${tag}:f${index + 1}`;
    // Read before in this browser: the bodies come back from their B-rep, and the file is not downloaded
    // (kernel/ops/exchange-cache.ts).  Faces keep their order through BREP, so the names are the same.
    const cache = importCache(), key = importKey(file, p.split);
    if (cache) {
      const hit = await cache.get(key).catch(() => null);
      if (hit && hit.bodies.length) {
        const shapes: Shape[] = [];
        try {
          for (const b of hit.bodies) { const s = (ctx.oc as never as { BRepToolsWrapper: { Read(text: string): Shape } }).BRepToolsWrapper.Read(b.brep); if (!s || s.IsNull()) throw new Error("empty"); shapes.push(s); }
        } catch (e) { for (const s of shapes) { try { (s as never as { delete(): void }).delete(); } catch (x) { /* gone */ } } shapes.length = 0; }
        if (shapes.length) {
          shapes.forEach((shape, i) => ctx.addBody(shape, namer(`s${i + 1}`), { suffix: shapes.length > 1 ? `s${i + 1}` : undefined, name: hit.bodies[i].name }));
          if (hit.sheets) ctx.warn(`${hit.sheets} of the imported bodies ${hit.sheets === 1 ? "is a surface" : "are surfaces"}, not ${hit.sheets === 1 ? "a solid" : "solids"}.`);
          return;
        }
      }
    }
    const bytes = await projectFileBytes(file);
    const format = file.format || sniffFormat(file.path, bytes.subarray(0, 64));
    if (format !== "step" && format !== "brep") throw ctx.fail(`“${fileName}” is not a STEP or BREP file.`);
    let read: ReadResult;
    try { read = format === "step" ? readStep(ctx.k, bytes) : readBrep(ctx.k, bytes); }
    catch (e) { throw ctx.fail(e instanceof Error ? e.message : ctx.k.describe(e)); }
    // what is not handed to a body is deleted when this evaluation ends
    const loose: { delete(): void }[] = [read.shape as never, ...read.roots.map((r) => r.shape as never)];
    const keep = new Set<unknown>();
    try {
      let bodies: Shape[], perRoot: number[];
      if (p.split === "one") { bodies = [read.shape]; perRoot = read.roots.length ? read.roots.map((_r, i) => (i ? 0 : 1)) : [1]; }
      else if (read.roots.length > 1) {
        bodies = []; perRoot = [];
        for (const r of read.roots) { const b = bodiesOf(ctx.k, r.shape); bodies.push(...b); perRoot.push(b.length); }
        for (const b of read.bodies) loose.push(b as never);
      } else { bodies = read.bodies; perRoot = [bodies.length]; }
      if (!bodies.length) throw ctx.fail(`“${fileName}” has no solid or surface in it.`);
      const names = p.split === "one" ? [read.roots.length ? importNames(format === "step" ? bytes : null, read, read.roots.map(() => 1), stem(fileName))[0] : stem(fileName)] : importNames(format === "step" ? bytes : null, read, perRoot, stem(fileName));
      const sheets = bodies.filter((b) => b.ShapeType() !== (ctx.oc as never as { TopAbs_ShapeEnum: { TopAbs_SOLID: unknown } }).TopAbs_ShapeEnum.TopAbs_SOLID && p.split !== "one").length;
      bodies.forEach((shape, i) => {
        const tag = `s${i + 1}`;
        keep.add(shape);
        ctx.addBody(shape, namer(tag), { suffix: bodies.length > 1 ? tag : undefined, name: names[i] || `${stem(fileName)} ${i + 1}` });
      });
      if (cache) {
        // kept for the next time; a store that is full or refused is not an error
        try {
          const write = (ctx.oc as never as { BRepToolsWrapper: { Write(shape: Shape): string } }).BRepToolsWrapper;
          await cache.set(key, { v: 1, bodies: bodies.map((shape, i) => ({ brep: write.Write(shape), name: names[i] || `${stem(fileName)} ${i + 1}` })), sheets }).catch(() => undefined);
        } catch (e) { /* too large to write out: read the file again next time */ }
      }
      if (sheets) ctx.warn(`${sheets} of the imported bodies ${sheets === 1 ? "is a surface" : "are surfaces"}, not ${sheets === 1 ? "a solid" : "solids"}.`);
    } finally {
      for (const o of loose) if (!keep.has(o)) { try { o.delete(); } catch (e) { /* shared */ } }
    }
  },
});
