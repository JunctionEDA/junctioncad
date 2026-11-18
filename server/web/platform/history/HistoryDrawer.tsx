// HistoryDrawer.tsx — version history and branches of a project, for the editor of any document that is not
// KiCad's (a part studio, an assembly).  The electronics editor has its own History pane; this is the same
// server feature (server/src/versions.rs, through history/api.ts) drawn for a domain's own editor.
//
// It lists the project's kept versions and the open document's runs of edits, newest first.  Picking a row asks
// the host to show the document as it was there (the host rebuilds its own view from it, read-only); the row
// then offers Restore, Compare with current and Branch from here.  Above the list: the line being worked on
// (main or a branch), switching, starting a branch, and merging, with every conflict put to a choice.
//
// The host is the domain's editor; this file knows nothing about what a document holds.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import type { Branch, Branches, DocRef, Entry, MergeConflict, MergePlan, Side, Timeline } from "./api";

export interface Viewing { seq: number; label: string; versionId?: string }

export interface HistoryHost {
  projectId: string;
  doc: DocRef;
  canEdit: boolean;
  signedIn: boolean;
  /** the point of the document on screen; null is the document as it is now */
  viewing: Viewing | null;
  /** Show the document as it was at a point (null: as it is now). */
  view(at: Viewing | null): void;
  /** Said under a picked row when the editor cannot show an earlier state of its document (it only selects the row). */
  note?: string;
  /** Open the compare window between a point and now; absent when the document's kind has no comparison. */
  compare?(at: Viewing): void;
  toast(text: string, ms?: number): void;
  /** Go to another project (a branch, or back to main), on the document of the same path when it has one. */
  navigate(url: string): void;
  close(): void;
}

const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(" ");
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function useHistory(projectId: string, signedIn: boolean) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const n = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++n.current;
    try {
      const [t, b] = await Promise.all([api.timeline(projectId), signedIn ? api.branches(projectId).catch(() => null) : Promise.resolve(null)]);
      if (mine !== n.current) return;
      setTimeline(t); setBranches(b); setError(null);
    } catch (e) { if (mine === n.current) setError(why(e)); }
  }, [projectId, signedIn]);
  useEffect(() => {
    void reload();
    // somebody else may have saved, restored or merged: look again now and then, and when the window comes back
    const t = window.setInterval(() => { if (!document.hidden) void reload(); }, 20000);
    const focus = () => { void reload(); };
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(t); window.removeEventListener("focus", focus); n.current++; };
  }, [reload]);
  return { timeline, branches, error, reload };
}

function branchUrl(projectId: string, docs: readonly DocRef[] | undefined, path: string): string {
  const twin = docs && docs.find((d) => d.path === path);
  return `/p/${projectId}/edit` + (twin ? `?doc=${twin.docId}` : "");
}

export function HistoryDrawer({ host }: { host: HistoryHost }) {
  const { timeline, branches, error, reload } = useHistory(host.projectId, host.signedIn);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<null | { kind: "save" } | { kind: "branch"; from?: Viewing } | { kind: "rename"; versionId: string; name: string }>(null);
  const [text, setText] = useState("");
  const [merging, setMerging] = useState<null | { branch: Branch; direction: MergePlan["direction"] }>(null);
  const entries = useMemo(() => (timeline ? api.entriesFor(timeline, host.doc.docId) : []), [timeline, host.doc.docId]);
  const head = timeline ? timeline.docs.find((d) => d.docId === host.doc.docId) : undefined;
  const onBranch = !!(timeline && timeline.parentId);
  const mainId = timeline ? timeline.parentId || timeline.projectId : host.projectId;
  const here = branches ? branches.branches.find((b) => b.projectId === host.projectId) : undefined;

  const act = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); setForm(null); } catch (e) { host.toast(`${what}: ${why(e)}`, 6000); }
    setBusy(false);
    void reload();
  };
  const openForm = (f: NonNullable<typeof form>, value = "") => { setText(value); setForm(f); };
  const submit = () => {
    const name = text.trim(); if (!form || !name) return;
    if (form.kind === "save") void act("The version was not saved", async () => { const r = await api.saveVersion(host.projectId, name); host.toast(r.githubPush ? "Version saved, pushing to GitHub" : "Version saved", 2500); });
    if (form.kind === "rename") void act("The version was not renamed", async () => { await api.renameVersion(host.projectId, form.versionId, name); });
    if (form.kind === "branch") {
      const from = form.from;
      void act("The branch was not created", async () => {
        const made = await api.createBranch(mainId, name, from ? (from.versionId ? { versionId: from.versionId } : { at: { docId: host.doc.docId, seq: from.seq } }) : {});
        host.toast(`Branch "${made.name}" created`, 2500);
        const all = await api.branches(host.projectId).catch(() => null);
        host.navigate(branchUrl(made.projectId, all ? (all.branches.find((b) => b.projectId === made.projectId) || { docs: undefined }).docs : undefined, host.doc.path));
      });
    }
  };
  const restore = (e: Entry | null) => {
    const v = host.viewing; if (!v) return;
    const label = v.label;
    void act("Nothing was restored", async () => {
      const r = e && e.kind === "version" ? await api.restore(host.projectId, { versionId: e.version.id }) : await api.restore(host.projectId, { at: { docId: host.doc.docId, seq: v.seq }, scope: "document", label });
      host.view(null);
      host.toast(r.docs.length ? `Restored ${label}. The state before is kept in History.` : "It already reads like that.", 4500);
    });
  };
  const switchTo = (projectId: string) => {
    if (projectId === host.projectId || !branches) return;
    const docs = projectId === branches.main.projectId ? branches.main.docs : (branches.branches.find((b) => b.projectId === projectId) || { docs: undefined }).docs;
    host.navigate(branchUrl(projectId, docs, host.doc.path));
  };

  const viewingKey = (e: Entry): boolean => {
    const v = host.viewing; if (!v) return false;
    return e.kind === "version" ? v.versionId === e.version.id : !v.versionId && v.seq === e.run.to;
  };
  const pick = (e: Entry) => {
    if (viewingKey(e)) { host.view(null); return; }
    if (e.kind === "version") {
      if (!e.here) { host.toast("This document did not exist in that version."); return; }
      host.view({ seq: e.here.seq, label: e.version.name || `the version of ${api.when(e.version.createdAt)}`, versionId: e.version.id });
    } else host.view({ seq: e.run.to, label: `${api.when(e.run.endedAt)}, after ${api.personName(e.run.author)}'s ${e.run.kind === "edit" ? "edits" : e.run.kind}` });
  };

  return (
    <aside className="flex flex-col h-full min-h-0 w-80 bg-paper border-l border-line text-sm text-ink pointer-events-auto" data-history aria-label="Version history" aria-busy={busy || undefined}>
      <header className="flex flex-none items-center h-7 px-2 gap-2 font-semibold bg-[linear-gradient(var(--color-paper),var(--color-bench))] border-b border-line select-none">
        <span className="flex-1">History</span>
        <button type="button" className="btn sm ghost" aria-label="Close history" title="Close" data-history-close onClick={() => host.close()}>✕</button>
      </header>

      {/* ---- the line being worked on */}
      {branches ? (
        <div className="flex flex-none flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-line bg-bench" data-history-branches>
          <label className="flex items-center gap-1.5 min-w-0 flex-1"><span className="text-ink-2 flex-none">Branch</span>
            <select className="input h-6 min-w-0 flex-1" aria-label="Branch" value={host.projectId} onChange={(ev) => switchTo(ev.target.value)}>
              <option value={branches.main.projectId}>main</option>
              {branches.branches.map((b) => <option key={b.projectId} value={b.projectId}>{b.name}{b.ahead ? ` · ${b.ahead} ahead` : ""}{b.behind ? ` · ${b.behind} behind` : ""}</option>)}
            </select>
          </label>
          {host.canEdit && !onBranch ? <button type="button" className="btn sm" data-history-new-branch disabled={busy} onClick={() => openForm({ kind: "branch" })}>New branch…</button> : null}
          {onBranch && here ? (
            <div className="flex gap-1.5 w-full">
              <button type="button" className="btn sm flex-1" data-history-merge="into_main" disabled={busy || !host.canEdit} title="Bring this branch's work to the main line" onClick={() => setMerging({ branch: here, direction: "into_main" })}>Merge into main…{here.ahead ? ` (${here.ahead})` : ""}</button>
              <button type="button" className="btn sm flex-1" data-history-merge="from_main" disabled={busy || !host.canEdit} title="Bring the main line's newer work into this branch" onClick={() => setMerging({ branch: here, direction: "from_main" })}>Update from main…{here.behind ? ` (${here.behind})` : ""}</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {host.canEdit ? (
        <div className="flex flex-none items-center gap-1.5 px-2 py-1.5 border-b border-line">
          <button type="button" className="btn sm primary" data-history-save disabled={busy} onClick={() => openForm({ kind: "save" })}>Save version…</button>
          <span className="note m-0 truncate">Names the whole project as it is now.</span>
        </div>
      ) : null}

      {form ? (
        <form className="flex flex-none items-center gap-1.5 px-2 py-1.5 border-b border-line bg-sel-soft" data-history-form={form.kind} onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
          <input autoFocus className="input h-6 min-w-0 flex-1" value={text} maxLength={form.kind === "branch" ? 60 : 120} onChange={(ev) => setText(ev.target.value)}
            placeholder={form.kind === "branch" ? (form.from ? `Branch from ${form.from.label}` : "Branch name") : "Version name"} aria-label={form.kind === "branch" ? "Branch name" : "Version name"}
            onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Escape") setForm(null); }} />
          <button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>{form.kind === "save" ? "Save" : form.kind === "rename" ? "Rename" : "Create"}</button>
          <button type="button" className="btn sm" onClick={() => setForm(null)}>Cancel</button>
        </form>
      ) : null}

      {/* ---- the list */}
      <div className="flex-1 min-h-0 overflow-y-auto" role="list" aria-label="Versions and edits">
        {error ? <p className="callout err m-2">{error}</p> : null}
        {!timeline && !error ? <p className="note px-2 py-2 m-0"><span className="spinner" /> Reading the history…</p> : null}
        {timeline ? (
          <div role="listitem" data-history-row="now" aria-current={!host.viewing || undefined}
            className={cx("flex items-center gap-2 px-2 h-8 border-b border-line cursor-default", !host.viewing ? "bg-sel font-semibold" : "hover:bg-sel-soft")} onClick={() => host.view(null)}>
            <span className="w-2 h-2 rounded-full bg-wire flex-none" />Current{head ? <span className="text-ink-3 font-normal ml-auto">edit {head.head}</span> : null}
          </div>
        ) : null}
        {entries.map((e) => {
          const on = viewingKey(e);
          const named = e.kind === "version" && e.version.kind === "named";
          const missing = e.kind === "version" && !e.here;
          return (
            <div key={e.key} role="listitem" data-history-row={e.kind} data-history-name={e.kind === "version" ? e.version.name || "" : undefined} aria-current={on || undefined}
              className={cx("px-2 py-1 border-b border-line cursor-default", on ? "bg-sel" : "hover:bg-sel-soft", missing && "opacity-60")} onClick={() => pick(e)}>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className={cx("w-2 h-2 flex-none self-center", e.kind === "version" ? (named ? "rounded-full bg-blue" : "rounded-full border border-ink-3") : "rounded-sm bg-line")} />
                <span className={cx("truncate flex-1", named && "font-semibold")} title={e.kind === "version" ? e.version.description || e.version.name || "" : ""}>
                  {e.kind === "version" ? (e.version.name || "Kept automatically")
                    : e.run.kind === "edit" ? `${e.run.count} edit${e.run.count === 1 ? "" : "s"}` : e.run.kind === "restore" ? "Restored" : "Merged"}
                </span>
                <span className="text-ink-3 text-xs flex-none">{api.when(e.at)}</span>
              </div>
              <div className="text-ink-2 text-xs pl-4 truncate">
                {e.kind === "version" ? (e.version.author ? `by ${api.personName(e.version.author)}` : "by Junction") + (missing ? " · not in this version" : "") : `by ${api.personName(e.run.author)}`}
              </div>
              {on && host.note ? <p className="note pl-4 m-0 pt-1">{host.note}</p> : null}
              {on ? (
                <div className="flex flex-wrap gap-1.5 pl-4 pt-1.5 pb-0.5" onClick={(ev) => ev.stopPropagation()}>
                  {host.canEdit ? <button type="button" className="btn sm" data-history-restore disabled={busy} title={e.kind === "version" ? "Make the whole project read as this version again" : "Make this document read as it did here"} onClick={() => restore(e)}>Restore</button> : null}
                  {host.compare ? <button type="button" className="btn sm" data-history-compare onClick={() => host.viewing && host.compare!(host.viewing)}>Compare with current</button> : null}
                  {host.canEdit && !onBranch ? <button type="button" className="btn sm" data-history-branch-here disabled={busy} onClick={() => host.viewing && openForm({ kind: "branch", from: host.viewing })}>Branch from here…</button> : null}
                  {host.canEdit && named ? <button type="button" className="btn sm" data-history-rename onClick={() => e.kind === "version" && openForm({ kind: "rename", versionId: e.version.id, name: e.version.name || "" }, e.version.name || "")}>Rename</button> : null}
                  {host.canEdit && e.kind === "version" ? <button type="button" className="btn sm danger" data-history-delete disabled={busy} onClick={() => { if (e.kind === "version") { const id = e.version.id; host.view(null); void act("The version was not deleted", async () => { await api.deleteVersion(host.projectId, id); }); } }}>Delete</button> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {timeline && !entries.length ? <p className="note px-2 py-2 m-0">Nothing has been edited or saved yet.</p> : null}
        {timeline ? <p className="note px-2 py-2 m-0">Named versions are kept for good; other edits for {timeline.keptDays} days.</p> : null}
      </div>

      {merging ? <MergeDialog host={host} branch={merging.branch} direction={merging.direction} onClose={(done) => { setMerging(null); if (done) void reload(); }} /> : null}
    </aside>
  );
}

// ---------------------------------------------------------------- merging

const ACTION: Record<string, string> = { none: "no changes to bring", merge: "changes are merged in", take: "the file is taken whole", add: "new here: it is copied" };

function MergeDialog({ host, branch, direction, onClose }: { host: HistoryHost; branch: Branch; direction: MergePlan["direction"]; onClose(done: boolean): void }) {
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ [id: string]: Side }>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    api.mergePlan(branch.projectId, direction).then((p) => { if (!gone) setPlan(p); }).catch((e) => { if (!gone) setError(why(e)); });
    return () => { gone = true; };
  }, [branch.projectId, direction]);
  const into = direction === "into_main";
  const incoming = into ? `the branch “${branch.name}”` : "main", current = into ? "main" : `the branch “${branch.name}”`;
  const conflicts: { doc: string; c: MergeConflict }[] = plan ? plan.docs.flatMap((d) => d.conflicts.map((c) => ({ doc: d.path, c }))) : [];
  const run = (replace: boolean) => {
    if (busy) return;
    setBusy(true);
    api.merge(branch.projectId, direction, { replace, choices, prefer: "incoming" }).then((r) => {
      host.toast(!r.merged ? "There was nothing to merge." : into ? "Merged into main. Main as it was before is kept in its History." : "Updated from main. The branch as it was before is kept in its History.", 5000);
      onClose(true);
    }).catch((e) => { setBusy(false); setError(why(e)); });
  };
  const setAll = (side: Side) => setChoices(Object.fromEntries(conflicts.map(({ c }) => [c.id, side])));
  return (
    <div className="kd-overlay" style={{ zIndex: 80 }} data-merge-dialog onMouseDown={(ev) => { if (ev.target === ev.currentTarget && !busy) onClose(false); }}>
      <div className="kd-dialog" role="dialog" aria-label={into ? "Merge into main" : "Update from main"} style={{ width: "min(720px, 94vw)", maxHeight: "86vh" }}>
        <div className="kd-title"><span>{into ? `Merge “${branch.name}” into main` : `Update “${branch.name}” from main`}</span></div>
        <div className="flex flex-col gap-2 p-3 overflow-y-auto min-h-0 text-sm">
          {!plan && !error ? <p className="note m-0"><span className="spinner" /> Working out what would change…</p> : null}
          {error ? <p className="callout err m-0" role="alert">{error}</p> : null}
          {plan ? (
            <>
              <p className="m-0">Brings what changed in {incoming} into {current}. {current[0].toUpperCase() + current.slice(1)} as it is now is kept as a version first, so this can be taken back.</p>
              <table className="w-full text-sm" data-merge-docs>
                <tbody>
                  {plan.docs.filter((d) => d.action !== "none" || d.conflicts.length).map((d) => (
                    <tr key={d.path} className="border-b border-line">
                      <td className="py-1 pr-2 font-semibold whitespace-nowrap">{d.path}</td>
                      <td className="py-1 text-ink-2">{ACTION[d.action] || d.action}{d.action === "merge" ? ` (${d.changes} change${d.changes === 1 ? "" : "s"})` : ""}{d.conflicts.length ? ` · ${d.conflicts.length} conflict${d.conflicts.length === 1 ? "" : "s"}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.nothing ? <p className="callout m-0">There is nothing to merge: {current} already has everything {incoming} has.</p> : null}
              {!plan.canMerge && plan.reason ? <p className="callout m-0">{plan.reason}</p> : null}
              {conflicts.length ? (
                <div data-merge-conflicts>
                  <div className="flex items-center gap-2 pb-1">
                    <b className="flex-1">Both sides changed {conflicts.length === 1 ? "this" : `these ${conflicts.length}`}. Choose which to keep.</b>
                    <button type="button" className="btn sm" onClick={() => setAll("incoming")}>All from {into ? "the branch" : "main"}</button>
                    <button type="button" className="btn sm" onClick={() => setAll("current")}>Keep all of {into ? "main" : "the branch"}</button>
                  </div>
                  {conflicts.map(({ doc, c }) => {
                    const side = choices[c.id] || "incoming";
                    const pickSide = (s: Side) => setChoices((m) => ({ ...m, [c.id]: s }));
                    return (
                      <div key={doc + c.id} className="border border-line rounded-sm mb-1.5" data-conflict={c.id}>
                        <div className="px-2 py-1 bg-bench border-b border-line"><b>{c.label}</b> <span className="text-ink-3">in {doc}</span></div>
                        <div className="grid grid-cols-2">
                          {(["incoming", "current"] as Side[]).map((s) => (
                            <label key={s} className={cx("flex items-start gap-1.5 px-2 py-1.5 cursor-pointer", s === "incoming" && "border-r border-line", side === s && "bg-sel-soft")} data-side={s}>
                              <input type="radio" name={`c-${doc}-${c.id}`} checked={side === s} onChange={() => pickSide(s)} />
                              <span className="min-w-0"><span className="text-ink-2">{s === "incoming" ? (into ? "Branch" : "Main") : (into ? "Main" : "Branch")}: </span><span className="font-mono break-words">{api.didText(s === "incoming" ? c.incoming : c.current)}</span></span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="kd-foot">
          {plan && !plan.canMerge ? <button type="button" className="btn" disabled={busy} data-merge-replace onClick={() => run(true)}>Replace {current} with {incoming}</button> : null}
          <span className="spacer" />
          <button type="button" className="btn" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
          <button type="button" className="btn primary" data-merge-go disabled={busy || !plan || plan.nothing || !plan.canMerge} onClick={() => run(false)}>{busy ? "Merging…" : into ? "Merge into main" : "Update from main"}</button>
        </div>
      </div>
    </div>
  );
}
