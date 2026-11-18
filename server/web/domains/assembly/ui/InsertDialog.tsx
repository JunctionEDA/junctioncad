// InsertDialog.tsx — Insert: the project's part studios (one part, several, or the whole studio), its other
// assemblies as rigid sub-assemblies, and its boards.  A document's parts are read when its row is opened: the
// source is loaded the same way an instance of it would be, so what is listed is what will be placed.
// The same dialog replaces an instance's source ("Replace…").
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import type { InstanceSource } from "../document/format";
import type { SourceOffer, SourceProvider } from "../sources/types";
import type { AssemblyEditor } from "./assembly";
import { Glyph, ICONS, useAssembly } from "./parts";

const offerKey = (s: InstanceSource): string => `${s.kind}:${s.docId}:${s.kind === "part" ? s.body : ""}`;
const baseName = (path: string): string => path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");

function DocRows({ assembly, provider, doc, open, toggleOpen, chosen, toggle, addAll }: {
  assembly: AssemblyEditor; provider: SourceProvider; doc: { docId: string; path: string }; open: boolean; toggleOpen(): void;
  chosen: Map<string, SourceOffer>; toggle(o: SourceOffer): void; addAll(list: SourceOffer[]): void;
}) {
  // re-read the source's snapshot whenever the editor refreshes (sources call it when they change)
  useAssembly(assembly, (s) => s.building);
  useAssembly(assembly, (s) => s.instanceInfo);
  const why = provider.unavailable();
  const name = baseName(doc.path);
  const snap = open ? assembly.sources.snapshot(provider.kind, doc.docId) : null;
  const offers = snap && snap.status !== "loading" ? provider.offers(doc.docId, name, snap) : [];
  const single = !provider.offersAll;
  const rowOffer: SourceOffer = { source: { kind: provider.kind, docId: doc.docId } as InstanceSource, name };
  return (
    <div data-source-doc={name} data-open={open || undefined}>
      <div className={cx("flex items-center gap-1.5 h-7 px-2", why ? "text-ink-3" : "cursor-default hover:bg-sel-soft", single && chosen.has(offerKey(rowOffer.source)) && "bg-sel")} title={why || undefined}
        onClick={() => { if (why) return; if (single) toggle(rowOffer); else toggleOpen(); }}>
        {!single ? <span className={cx("flex-none transition-transform", open && "rotate-90")}><Glyph svg={ICONS.chevron} size={14} /></span> : <span className="w-3.5" />}
        <span className="flex-1 truncate font-medium">{name}</span>
        <span className="text-xs text-ink-3">{provider.title}</span>
      </div>
      {why ? <p className="note m-0 pl-8 pr-2 pb-1">{why}</p> : null}
      {open && !single ? (
        <div className="pb-1">
          {snap && snap.status === "loading" ? <p className="note m-0 pl-8 pr-2">{snap.message || "Loading…"}</p> : null}
          {snap && snap.status === "error" ? <p className="callout err m-0 ml-8 mr-2">{snap.message}</p> : null}
          {offers.map((o) => (
            <label key={offerKey(o.source)} className={cx("flex items-center gap-2 h-6.5 pl-8 pr-2 cursor-default hover:bg-sel-soft", chosen.has(offerKey(o.source)) && "bg-sel")} data-offer={o.name}>
              <input type="checkbox" checked={chosen.has(offerKey(o.source))} onChange={() => toggle(o)} />
              <Glyph svg={ICONS.part} size={14} /><span className="flex-1 truncate">{o.name}</span>
            </label>
          ))}
          {snap && snap.status === "ready" && !offers.length ? <p className="note m-0 pl-8 pr-2">This part studio has no parts yet.</p> : null}
          {offers.length > 1 ? <button type="button" className="btn sm ghost ml-7 mt-0.5" data-all onClick={() => addAll(offers)}>Choose the whole studio</button> : null}
        </div>
      ) : null}
    </div>
  );
}

export function InsertDialog({ assembly }: { assembly: AssemblyEditor }) {
  const inserting = useAssembly(assembly, (s) => s.inserting);
  const replaceName = useAssembly(assembly, (s) => (s.inserting?.replace ? s.instances.find((i) => i.id === s.inserting!.replace)?.name : undefined));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Map<string, SourceOffer>>(new Map());
  const self = assembly.host.doc.docId;
  const docs = useMemo(() => assembly.sources.providers.map((p) => ({ provider: p, docs: assembly.host.docs.filter((d) => p.docTypes.includes(d.docType) && d.docId !== self) })).filter((g) => g.docs.length), [assembly, self, inserting]);   // eslint-disable-line react-hooks/exhaustive-deps
  const active = !!inserting;
  // a document whose row is open is held open; everything is let go when the dialog closes
  const held = useRef(new Map<string, [InstanceSource["kind"], string]>());
  useEffect(() => {
    // take the newly opened ones before letting any go, so a document that stays open is never closed and reopened
    const want = new Map<string, [InstanceSource["kind"], string]>();
    // (a kind with one offer per document, a board, is read while the dialog is open: Insert then knows where it belongs)
    if (active) for (const g of docs) for (const d of g.docs) if ((open.has(d.docId) || !g.provider.offersAll) && !g.provider.unavailable()) want.set(g.provider.kind + ":" + d.docId, [g.provider.kind, d.docId]);
    for (const [k, [kind, id]] of want) if (!held.current.has(k)) assembly.sources.hold(kind, id, "insert");
    for (const [k, [kind, id]] of held.current) if (!want.has(k)) assembly.sources.release(kind, id, "insert");
    held.current = want;
  }, [active, open, docs, assembly]);
  useEffect(() => () => { for (const [kind, id] of held.current.values()) assembly.sources.release(kind, id, "insert"); held.current = new Map(); }, [assembly]);
  useEffect(() => {
    if (!active) { setChosen(new Map()); return; }
    // open the first part studio straight away: that is what is wanted nine times out of ten
    const first = docs.find((g) => g.provider.offersAll && !g.provider.unavailable())?.docs[0];
    setOpen(first ? new Set([first.docId]) : new Set());
  }, [active]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!inserting) return null;
  const replacing = inserting.replace;
  const toggle = (o: SourceOffer) => {
    if (replacing) { assembly.replace(replacing, o.source); return; }
    setChosen((cur) => { const next = new Map(cur), k = offerKey(o.source); if (next.has(k)) next.delete(k); else next.set(k, o); return next; });
  };
  const addAll = (list: SourceOffer[]) => { if (replacing) return; setChosen((cur) => { const next = new Map(cur); for (const o of list) next.set(offerKey(o.source), o); return next; }); };
  return (
    <form className="cad-dialog absolute left-2 top-2 z-[4] w-[320px] max-h-[calc(100%-16px)] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm" data-insert-dialog
      onSubmit={(ev) => { ev.preventDefault(); assembly.insert(Array.from(chosen.values())); }} onKeyDown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); assembly.closeInsert(); } }}>
      <header className="flex items-center h-8 px-2 border-b border-line bg-paper rounded-t-md font-semibold text-base">{replacing ? `Replace ${replaceName || "instance"}` : "Insert"}</header>
      <div className="flex flex-col py-1 overflow-y-auto bg-paper min-h-[120px]">
        {docs.map((g) => g.docs.map((d) => (
          <DocRows key={g.provider.kind + d.docId} assembly={assembly} provider={g.provider} doc={d} open={open.has(d.docId)} chosen={chosen} toggle={toggle} addAll={addAll}
            toggleOpen={() => setOpen((cur) => { const next = new Set(cur); if (next.has(d.docId)) next.delete(d.docId); else next.add(d.docId); return next; })} />
        )))}
        {!docs.length ? <p className="note px-2 m-0">This project has no part studio yet. Add one with “+” in the tabs below, draw a part, and come back.</p> : null}
      </div>
      <footer className="flex items-center justify-end gap-1.5 p-2 border-t border-line">
        {replacing ? <span className="flex-1 text-ink-3">Click the part to use instead.</span> : <span className="flex-1 text-ink-3">{chosen.size ? `${chosen.size} chosen` : "Tick the parts to place."}</span>}
        <button type="button" className="btn sm" data-cancel onClick={() => assembly.closeInsert()}>Cancel</button>
        {!replacing ? <button type="submit" className="btn sm primary" data-accept disabled={!chosen.size}>Insert</button> : null}
      </footer>
    </form>
  );
}
