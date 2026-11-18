// guard.ts — two people in one feature: nothing either of them typed is lost without a word.
//
// The document merges edits per path, last writer wins (CONTRACT.md "Changes").  That is right for the stored
// document and wrong for a person in a dialog, in three cases this file handles:
//
//   the feature changed under an open dialog      A dialog edits a draft and commits "what differs from the
//       document" when it is accepted.  A draft made before somebody's commit would put their old values back.
//       So the draft is rebased on every change of its feature (merge.ts): what they changed and I did not
//       appears in my dialog and my preview; what we both changed stays mine and is listed as a conflict, with
//       their value on offer, so accepting replaces their value knowingly.
//   the feature was deleted under an open dialog or sketch      The dialog closes, as it must.  What was in it
//       is kept here and offered back ("Put it back"): the feature returns for everybody with my values.
//   the feature was deleted while an edit of mine was on its way (or was made offline)      A change to a
//       deleted item does nothing, by the rule that lets the two orders agree.  The same offer is made.
//
// It watches the studio from outside (state, the session's taps) and changes nothing in the document on its
// own: it only edits the draft (studio.setDraft) and commits when the person asks.
import { addedChange, clone, getPath, stableJson, type Item, type ItemChange, type Json, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import { isFeature, type FeatureItem } from "../document/format";
import { featureDef, type PartStudio } from "../ui/studio";
import { isDirty, rebase, showValue, type Conflict } from "./merge";

export interface DraftConflict extends Conflict {
  /** who changed it ("Someone" when the server did not say) */
  by: string;
  /** the field as the dialog names it */
  label: string;
}

export interface Rescue {
  item: FeatureItem;
  by: string;
  /** what this person was doing with it */
  was: "dialog" | "sketch" | "edited";
}

export interface GuardState { conflicts: DraftConflict[]; rescue: Rescue | null }

interface Tracked { id: string; kind: "dialog" | "sketch"; base: FeatureItem; seen: FeatureItem; draft: FeatureItem | null }
interface DraftShape extends JsonObject { name: string; params: JsonObject }

const shape = (f: FeatureItem): DraftShape => ({ name: f.name, params: f.params });
/** How long after an edit of mine a deletion by somebody else still counts as "while my edit was on its way". */
const RECENT_MS = 4000;

export class EditGuard {
  private state: GuardState = { conflicts: [], rescue: null };
  private listeners = new Set<() => void>();
  private tracked: Tracked | null = null;
  private authors = new Map<string, string>();
  private localRemoved = new Set<string>();
  private localEdits = new Map<string, number>();
  private busy = false;
  private offs: (() => void)[] = [];
  /** how a login is shown (the collaborator list knows names) */
  nameOf: (login: string) => string = (login) => login;

  constructor(private readonly studio: PartStudio) {
    const tap = (msg: Record<string, unknown>) => this.onMessage(msg);
    studio.session.taps.add(tap);
    this.offs.push(() => studio.session.taps.delete(tap), studio.subscribe(() => this.onState()));
    this.onState();
  }

  getState = (): GuardState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<GuardState>): void { this.state = { ...this.state, ...patch }; for (const fn of Array.from(this.listeners)) fn(); }
  dispose(): void { for (const off of this.offs) off(); this.listeners.clear(); }

  // ---------------------------------------------------------------- what the socket says
  private onMessage(msg: Record<string, unknown>): void {
    if (msg.type === "local_op") {
      for (const c of (msg.changes as ItemChange[]) || []) {
        if (c.kind === "REMOVED") this.localRemoved.add(c.id);
        else { this.localRemoved.delete(c.id); this.localEdits.set(c.id, Date.now()); }
      }
      return;
    }
    const ops = msg.type === "op" ? [msg] : msg.type === "ops" ? ((msg.ops as Record<string, unknown>[]) || []) : [];
    for (const op of ops) {
      const author = op.author as { clientId?: string; login?: string } | undefined;
      const mine = this.studio.session.clientId;
      if (author && author.clientId && (author.clientId === mine || author.clientId.endsWith(":" + mine))) continue;
      const by = author && author.login ? this.nameOf(author.login) : "Someone";
      for (const c of (op.changes as ItemChange[]) || []) {
        if (!c || typeof c.id !== "string") continue;
        this.authors.set(c.id, by);
        if (c.kind === "REMOVED") this.removedByOther(c.id, by);
      }
    }
  }

  /** Somebody else's delete is about to be applied: the item is still in the document, with my edits on it. */
  private removedByOther(id: string, by: string): void {
    const item = this.studio.doc?.items.get(id);
    if (!isFeature(item)) return;
    const s = this.studio.getState();
    const open = this.tracked && this.tracked.id === id ? this.tracked : null;
    const recent = Date.now() - (this.localEdits.get(id) || 0) < RECENT_MS || (this.studio.session.unsaved > 0 && this.localEdits.has(id));
    if (open) {
      const draft = open.kind === "dialog" && s.editing && s.editing.draft.id === id ? s.editing.draft : null;
      // a dialog nothing was typed in loses nothing; say who closed it and leave it at that
      if (open.kind === "dialog" && draft && !isDirty(shape(open.base), shape(draft)) && !recent) { this.studio.host.toast(`${by} deleted ${item.name}`, 3500); this.tracked = null; return; }
      this.set({ rescue: { item: draft ? { ...clone(item), name: draft.name, params: clone(draft.params) } : clone(item), by, was: open.kind } });
      this.tracked = null;
    } else if (recent) this.set({ rescue: { item: clone(item), by, was: "edited" } });
    else if (s.selectedFeature === id) this.studio.host.toast(`${by} deleted ${item.name}`, 3500);
  }

  // ---------------------------------------------------------------- what the studio shows
  private onState(): void {
    if (this.busy) return;
    const s = this.studio.getState();
    const cur = s.editing && !s.editing.isNew ? { id: s.editing.draft.id, kind: "dialog" as const } : s.sketch ? { id: s.sketch.featureId, kind: "sketch" as const } : null;
    let t = this.tracked;
    if (t && (!cur || cur.id !== t.id || cur.kind !== t.kind)) {
      // it closed.  If its feature is gone and nobody here deleted it (a reload after being offline shows no
      // delete to learn the author from), what was open is still offered back.
      const gone = !s.features.some((f) => f.id === t!.id);
      if (gone && !this.localRemoved.has(t.id) && !this.state.rescue) {
        const dirty = t.kind === "sketch" || (!!t.draft && isDirty(shape(t.base), shape(t.draft)));
        if (dirty) this.set({ rescue: { item: t.draft ? { ...clone(t.seen), name: t.draft.name, params: clone(t.draft.params) } : clone(t.seen), by: this.authors.get(t.id) || "Someone", was: t.kind } });
      }
      t = this.tracked = null;
      if (this.state.conflicts.length) this.set({ conflicts: [] });
    }
    if (cur && !t) {
      const f = s.features.find((x) => x.id === cur.id);
      if (f) t = this.tracked = { id: cur.id, kind: cur.kind, base: clone(f), seen: f, draft: s.editing ? s.editing.draft : null };
    }
    if (!t) return;
    const f = s.features.find((x) => x.id === t!.id);
    if (t.kind === "dialog" && s.editing) t.draft = s.editing.draft;
    if (f && f !== t.seen) {
      t.seen = f;
      if (t.kind === "dialog" && s.editing) this.rebaseDraft(t, f, s.editing.draft);
      t.base = clone(f);
    }
    if (t.kind === "dialog" && s.editing && this.state.conflicts.length) {
      // a conflict is over when the draft holds their value (the person took it, or typed it)
      const mine = shape(s.editing.draft);
      const left = this.state.conflicts.filter((c) => stableJson(getPath(mine, c.path) ?? null) !== stableJson(c.theirs ?? null));
      if (left.length !== this.state.conflicts.length) this.set({ conflicts: left });
    }
  }

  private label(featureType: string, path: string[]): string {
    if (path[0] === "name") return "the name";
    const field = featureDef(featureType)?.schema.find((x) => x.key === path[1]);
    return field ? field.label + (path.length > 2 ? ` (${path.slice(2).join(" › ")})` : "") : path.slice(1).join(" › ");
  }

  private rebaseDraft(t: Tracked, theirs: FeatureItem, draft: FeatureItem): void {
    const base = shape(t.base), now = shape(theirs);
    if (stableJson(base) === stableJson(now)) return;   // only its place or its suppression changed
    const r = rebase(base, shape(draft), now);
    const by = this.authors.get(t.id) || "Someone";
    if (r.taken.length) {
      const params: JsonObject = { ...r.merged.params };
      for (const k of Object.keys(draft.params)) if (!(k in params)) params[k] = undefined;
      this.busy = true;
      try { this.studio.setDraft({ name: r.merged.name, params }); } finally { this.busy = false; }
      const first = r.taken[0];
      this.studio.host.toast(`${by} changed ${this.label(draft.featureType, first.path)} to ${showValue(first.value)}${r.taken.length > 1 ? ` and ${r.taken.length - 1} more` : ""}`, 3500);
    }
    if (r.conflicts.length) {
      const fresh = r.conflicts.map((c): DraftConflict => ({ ...c, by, label: this.label(draft.featureType, c.path) }));
      const keys = new Set(fresh.map((c) => c.path.join("\u0000")));
      this.set({ conflicts: [...this.state.conflicts.filter((c) => !keys.has(c.path.join("\u0000"))), ...fresh] });
    }
  }

  // ---------------------------------------------------------------- what the person decides
  /** Take the other person's value for a conflict: the draft gets it and the conflict is over. */
  takeTheirs(c: DraftConflict): void {
    const e = this.studio.getState().editing; if (!e) return;
    if (c.path[0] === "name") { if (typeof c.theirs === "string") this.studio.setDraft({ name: c.theirs }); return; }
    const key = c.path[1];
    const top = clone((e.draft.params[key] ?? null) as Json);
    if (c.path.length === 2) { this.studio.setDraft({ params: { [key]: c.theirs === undefined ? undefined : clone(c.theirs) } }); return; }
    // deeper: set inside a copy of the parameter
    const holder: JsonObject = { v: top && typeof top === "object" && !Array.isArray(top) ? top : {} };
    let at = holder.v as JsonObject;
    for (const k of c.path.slice(2, -1)) { const next = at[k]; if (next && typeof next === "object" && !Array.isArray(next)) at = next; else { const made: JsonObject = {}; at[k] = made; at = made; } }
    const last = c.path[c.path.length - 1];
    if (c.theirs === undefined) delete at[last]; else at[last] = clone(c.theirs);
    this.studio.setDraft({ params: { [key]: holder.v } });
  }
  /** Keep mine: the conflict is not shown again unless they change the value once more. */
  keepMine(c: DraftConflict): void { this.set({ conflicts: this.state.conflicts.filter((x) => x !== c) }); }

  /** Put a deleted feature back, as this person last had it. */
  restore(): void {
    const r = this.state.rescue; if (!r) return;
    this.set({ rescue: null });
    if (this.studio.doc?.items.has(r.item.id)) { this.studio.host.toast(`${r.item.name} is already back`, 2500); return; }
    if (this.studio.commit([addedChange(r.item as unknown as Item)])) { this.studio.selectFeature(r.item.id); this.studio.host.toast(`${r.item.name} is back`, 2500); }
  }
  dismissRescue(): void { this.set({ rescue: null }); }
}
