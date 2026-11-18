// HostedCompare.tsx — the Compare window for a document a domain's own editor draws (a part studio, an assembly).
//
// The same window as Compare.tsx as far as a person is concerned: Reference and Comparison on top, each chosen
// from the document as it is now, the project's versions and the commits of the linked repository; the changes
// and the picture below.  What is below is drawn by the renderer the document's domain registered
// (renderers.ts); this file reads the two versions as text and hands them over.
import { useEffect, useMemo, useRef, useState } from "react";
import { CloseMark, KIcon } from "../../shared/components/Icon";
import { Select } from "../../shared/components/Select";
import { applyChanges, parseItemDoc, serializeItemDoc, type ItemChange } from "../../shared/itemdoc/itemdoc";
import { useApp } from "../../shared/store";
import { ago } from "../../shared/util";
import { documentKind } from "../../domains/registry";
import { loadCompareRenderer, type CompareSide, type CompareView } from "./renderers";
import { SourceError, listVersions, refLabel, sameRef, type Choice, type DocEntry, type Listing, type VersionRef } from "./sources";
import { closeCompare, type CompareRequest } from "./store";

async function failure(r: Response): Promise<string> {
  let message = "";
  try { const j = (await r.json()) as { message?: string }; message = j.message || ""; } catch { /* no body */ }
  if (r.status === 401) return "Sign in to read this version.";
  if (r.status === 404) return "That version no longer exists.";
  return message || `The server answered ${r.status}.`;
}
async function text(url: string): Promise<string> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new SourceError(await failure(r));
  return r.text();
}

/** The file of a JSON item document at a version: the stored file with the edits up to that point applied. */
export async function loadItemVersion(ref: VersionRef, projectId: string, entry: DocEntry): Promise<CompareSide> {
  const label = refLabel(ref);
  if (ref === "live" || ref.kind === "head" || ref.kind === "at") {
    const docId = ref === "live" ? entry.docId : ref.docId, seq = ref === "live" || ref.kind === "head" ? "head" : ref.seq;
    const r = await fetch(`/api/docs/${docId}/at/${seq}`, { credentials: "same-origin" });
    if (!r.ok) throw new SourceError(await failure(r));
    const j = (await r.json()) as { file: string; seq: number; ops?: { seq: number; changes: ItemChange[] }[] };
    let doc;
    try { doc = parseItemDoc(j.file); } catch (e) { throw new SourceError(`${label}: ${(e as Error).message}`); }
    for (const op of j.ops || []) if (op.seq <= j.seq) applyChanges(doc, op.changes);
    return { label, text: serializeItemDoc(doc) };
  }
  if (ref.kind === "snapshot") return { label, text: await text(`/api/docs/${ref.docId}/snapshots/${ref.seq}`) };
  if (ref.kind === "git") return { label, text: await text(`/api/projects/${projectId}/github/file?path=${encodeURIComponent(ref.path)}&sha=${encodeURIComponent(ref.sha)}`) };
  return { label, text: ref.text };
}

export function HostedCompare({ request, entry }: { request: CompareRequest; entry: DocEntry }) {
  const project = useApp((s) => s.project);
  const projectId = project ? project.projectId : "";
  const kind = documentKind(entry.docType);
  const [listing, setListing] = useState<Listing | null>(null);
  const [extra, setExtra] = useState<Choice[]>([]);
  const [refA, setRefA] = useState<VersionRef | null>(null);
  const [refB, setRefB] = useState<VersionRef | null>(null);
  const [sides, setSides] = useState<{ a: CompareSide; b: CompareSide } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null), fileFor = useRef<"a" | "b">("a");

  // ---- the versions on offer
  useEffect(() => {
    if (!projectId) return;
    let gone = false;
    listVersions(projectId, entry, false).then((l) => {
      if (gone) return;
      const now = l.choices[0].ref;
      const saved = l.choices.filter((c) => c.group !== "Now").sort((x, y) => (y.when || "").localeCompare(x.when || ""));
      const custom: Choice[] = [];
      for (const r of [request.a, request.b]) if (r && r !== "live" && !l.choices.some((c) => sameRef(c.ref, r)) && !(r.kind === "at" && r.seq === "head")) custom.push({ ref: r, label: refLabel(r), group: "Versions" });
      setExtra(custom); setListing(l);
      setRefA(request.a || (saved[0] ? saved[0].ref : now));
      setRefB(request.b && !(request.b !== "live" && request.b.kind === "at" && request.b.seq === "head") ? request.b : now);
    }).catch((e) => { if (!gone) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { gone = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.docId, projectId]);
  const choices = useMemo(() => (listing ? [...listing.choices, ...extra] : []), [listing, extra]);

  // ---- read both sides
  useEffect(() => {
    if (!refA || !refB) return;
    let gone = false;
    setLoading(true); setError(null);
    Promise.all([loadItemVersion(refA, projectId, entry), loadItemVersion(refB, projectId, entry)])
      .then(([a, b]) => { if (!gone) { setSides({ a, b }); setLoading(false); } })
      .catch((e) => { if (!gone) { setSides(null); setLoading(false); setError(e instanceof SourceError ? e.message : "That version could not be read."); } });
    return () => { gone = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refA, refB, entry.docId, projectId]);

  // ---- hand them to the domain's renderer
  useEffect(() => {
    const el = body.current; if (!el || !sides) return;
    let view: CompareView | null = null, gone = false;
    setSummary("");
    loadCompareRenderer(entry.docType).then((r) => {
      if (gone) return;
      el.replaceChildren();
      view = r.mount({ el, a: sides.a, b: sides.b, doc: entry, setSummary: (t) => { if (!gone) setSummary(t); } });
    }).catch((e) => { if (!gone) setError(e instanceof Error ? e.message : String(e)); });
    return () => { gone = true; if (view) { try { view.close(); } catch (e) { console.warn(e); } } el.replaceChildren(); };
  }, [sides, entry]);

  const key = (r: VersionRef | null): string => { const i = r ? choices.findIndex((c) => sameRef(c.ref, r)) : -1; return i >= 0 ? String(i) : ""; };
  const picker = (side: "a" | "b", ref: VersionRef | null) => (
    <Select className="input rv-pick" data={{ side }} value={key(ref)} disabled={!listing} label={side === "a" ? "Reference version" : "Comparison version"}
      onChange={(v) => {
        if (v === "file") { fileFor.current = side; fileInput.current?.click(); return; }
        const c = choices[Number(v)]; if (c) (side === "a" ? setRefA : setRefB)(c.ref);
      }}
      options={[...(key(ref) ? [] : [{ value: "", label: "…" }]),
        ...choices.map((c, i) => (c.group === "Now" ? { value: String(i), label: c.label } : { value: String(i), label: c.label + (c.when ? ` · ${ago(c.when)}` : ""), group: c.group })),
        { value: "file", label: "Choose a file…" }]} />
  );
  const onFile = async (files: FileList | null) => {
    const f = files && files[0]; if (!f) return;
    const ref: VersionRef = { kind: "file", name: f.name, text: await f.text(), label: f.name };
    setExtra((x) => [...x, { ref, label: f.name, group: "File" }]);
    (fileFor.current === "a" ? setRefA : setRefB)(ref);
  };
  const title = `Compare ${kind ? kind.title : "Document"} Versions`;
  const same = !!refA && !!refB && sameRef(refA, refB);

  return (
    <div className="kd-overlay rv-overlay" data-compare data-compare-kind={entry.docType} onMouseDown={(ev) => { if (ev.target === ev.currentTarget) closeCompare(); }}>
      <div className="kd-dialog rv-dialog" role="dialog" aria-label={title}>
        <div className="kd-title"><span>{title}</span><span className="text-ink-2 font-normal">{entry.path}</span><span className="kd-x" role="button" aria-label="Close" onClick={() => closeCompare()}><CloseMark /></span></div>
        <div className="rv-head">
          <label className="rv-field grow"><span>Reference:</span>{picker("a", refA)}</label>
          <button type="button" className="btn sm ghost rv-swap" id="rvSwap" title="Swap the two sides" disabled={!refA || !refB} aria-label="Swap the two sides" onClick={() => { const a = refA; setRefA(refB); setRefB(a); }}><KIcon name="swap" size={16} /></button>
          <label className="rv-field grow"><span>Comparison:</span>{picker("b", refB)}</label>
          <input ref={fileInput} type="file" hidden accept={kind ? kind.ext : undefined} onChange={(ev) => { void onFile(ev.target.files); ev.target.value = ""; }} />
        </div>
        <div className="rv-main relative">
          <div ref={body} className="flex flex-1 min-w-0 min-h-0" data-compare-body />
          {loading ? <div className="rv-cover"><span className="spinner" /> Reading the versions…</div> : null}
          {!loading && error ? <div className="rv-cover"><div className="callout err">{error}</div></div> : null}
          {!loading && !error && same ? <div className="rv-hint">Both sides are the same version. Pick another one as the reference.</div> : null}
        </div>
        <div className="kd-foot rv-foot">
          <span className="rv-summary" id="rvSummary">{summary}</span>
          <span className="spacer" />
          <button type="button" className="btn primary" id="rvClose" onClick={() => closeCompare()}>Close</button>
        </div>
      </div>
    </div>
  );
}
