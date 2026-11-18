// mech/panel.ts — what the board editor shows of the board link: a badge over the canvas when the board is
// driven by a part studio ("Driven by Enclosure"), and behind it a panel with every drive (what it made on the
// board, whether its model reference is stale, Show, Open in the part studio, Break link), the enclosure check
// with its clashes, and the selected component's room under the enclosure.
//
// Plain DOM in the editor's stage, coloured by the theme tokens.
import { store, state } from "../editor/appstore";
import { openDocId } from "../editor/doc";
import { E } from "../editor/state";
import { toast } from "../editor/util";
import { show3DViewer } from "../editor/viewer3d-loader";
import { DRIVE_TITLES, boardToModel, drivesOf, leaveHint, mmToNm, placementOf, takeHint } from "../../mechanical/api";
import type { LinkSource } from "./boarditems";
import { clashText, type Clash } from "./check";
import { mech } from "./sync";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, css?: string, text?: string): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };
const button = (text: string, title: string, run: () => void, cls = "btn sm"): HTMLButtonElement => { const b = h("button", undefined, text); b.type = "button"; b.className = cls; b.title = title; b.addEventListener("click", (ev) => { ev.stopPropagation(); run(); }); return b; };
const round2 = (v: number): number => Math.round(v * 100) / 100;

let root: HTMLElement | null = null, badge: HTMLButtonElement | null = null, body: HTMLElement | null = null;
let open = false, lastKey = "", roomText = "", roomFor = "";

function ensure(): boolean {
  if (root && root.isConnected) return true;
  const stage = document.getElementById("stage"); if (!stage) return false;
  root = h("div", "position:absolute;left:8px;bottom:8px;z-index:6;display:none;flex-direction:column-reverse;align-items:flex-start;gap:4px;max-width:340px;font-size:var(--fs-sm);color:var(--ink)");
  root.id = "mechLink";
  // the canvas under it must not take these as its own
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) root.addEventListener(type, (ev) => ev.stopPropagation());
  badge = h("button", "display:flex;align-items:center;gap:6px;height:var(--h-sm);padding:0 8px;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);color:var(--ink);font:inherit;cursor:pointer;box-shadow:var(--shadow)");
  badge.type = "button"; badge.id = "mechBadge";
  badge.addEventListener("click", () => { open = !open; lastKey = ""; render(); });
  body = h("div", "display:none;flex-direction:column;width:340px;max-height:60vh;overflow-y:auto;border:1px solid var(--line);border-radius:var(--r-3);background:var(--bench);box-shadow:var(--shadow)");
  body.id = "mechPanel";
  root.append(badge, body);
  stage.appendChild(root);
  return true;
}

function lockGlyph(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "14"); svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
  svg.innerHTML = '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
  return svg;
}

function openStudio(src: LinkSource, drive?: string, clash?: Clash): void {
  leaveHint({ doc: src.studioDoc, link: src.link.id, drive, ...(clash ? clashInModel(src, clash) : {}) });
  openDocId(src.studioDoc);
}

/** A clashing component as a wire box in the part studio's model space, and what to say about it there. */
function clashInModel(src: LinkSource, c: Clash): { box?: number[]; note?: string } {
  const pl = placementOf(src.link); if (!pl) return {};
  const t = mech.thickness(), w0 = c.back ? 0 : t, w1 = c.back ? -c.height : t + c.height;
  const at = (p: [number, number], w: number) => boardToModel(pl, mmToNm(p[0]), mmToNm(p[1]), w);
  const box: number[] = [];
  c.pts.forEach((p, i) => {
    const q = c.pts[(i + 1) % c.pts.length];
    box.push(...at(p, w0), ...at(q, w0), ...at(p, w1), ...at(q, w1), ...at(p, w0), ...at(p, w1));
  });
  return { box, note: clashText(c) };
}

function section(title: string): HTMLElement {
  const s = h("div", "display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-top:1px solid var(--line)");
  s.appendChild(h("div", "font-weight:600", title));
  return s;
}

function driveRow(src: LinkSource, drive: ReturnType<typeof drivesOf>[number]): HTMLElement {
  const s = mech.getState();
  const row = h("div", "display:flex;flex-direction:column;gap:2px;padding:4px 0");
  row.dataset.drive = drive.id; row.dataset.driveKind = drive.kind;
  const ids = s.driven[`${src.link.id}/${drive.id}`] || [];
  const error = src.link.solved.errors[drive.id] || src.link.solved.errors.plane;
  const head = h("div", "display:flex;align-items:center;gap:6px");
  const name = h("span", "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", drive.name || DRIVE_TITLES[drive.kind]);
  name.prepend(lockGlyph(), " ");
  head.append(name,
    button("Show", "Select what this drives on the board", () => mech.select(ids)),
    button("Model", "Open the part studio at what this is taken from", () => openStudio(src, drive.id)));
  if (s.canEdit && mech.links.canEdit(src.studioDoc)) {
    head.appendChild(button("Break link", "Stop the model driving this. What it made stays on the board, unlocked, and is yours to edit.", () => {
      if (!mech.breakLink(src, drive.id)) { toast("The link could not be broken: the part studio is not editable from here"); return; }
      toast(`${drive.name} no longer follows ${src.studio}`, 6000, { text: "Undo", run: () => { mech.links.undoBreak(src.studioDoc); } });
    }));
  }
  row.appendChild(head);
  const count = drive.kind === "outline" ? `${ids.length} locked edge${ids.length === 1 ? "" : "s"} on Edge.Cuts` : drive.kind === "holes" ? `${ids.length} locked mounting hole${ids.length === 1 ? "" : "s"}` : `${ids.length} locked rule area${ids.length === 1 ? "" : "s"}`;
  const note = h("div", "color:var(--ink-3)", error ? "" : count);
  if (error) { note.style.color = "var(--warn)"; note.textContent = `Not following: ${error} The board keeps what it had.`; row.dataset.stale = "1"; }
  row.appendChild(note);
  return row;
}

function clashRow(c: Clash): HTMLElement {
  const row = h("div", "display:flex;align-items:center;gap:6px;padding:2px 0");
  row.dataset.clash = c.ref;
  const text = h("span", "flex:1;min-width:0;color:var(--err)", clashText(c));
  const src = mech.getState().sources.find((s) => s.link.id === c.area.link);
  row.append(text, button("Part", "Select the component on the board", () => mech.select([c.part])), button("Area", "Select the keep-out on the board", () => mech.select([c.area.zone])));
  if (src) row.appendChild(button("Model", "Open the part studio at what makes this keep-out, with the component drawn where it stands", () => openStudio(src, c.area.drive, c)));
  return row;
}

/** The selected component's room, worked out when the selection changes. */
function refreshRoom(): void {
  const ids = store.get().selection.ids;
  const doc = E.kdoc as KDoc | null;
  const fp = doc && doc.type === "pcb" ? ids.map((id) => doc.items.get(id)).find((it) => it && it.kind === "footprint") : null;
  const st = store.get();
  // a footprint drag commits without bumping document.version: the undo and edit counts move with it
  const key = fp ? [fp.id, st.document.version, st.connection.edits, st.undo.undo, st.undo.redo, mech.getState().areas.map((a) => a.limit).join(",")].join("|") : "";
  if (key === roomFor) return;
  roomFor = key;
  if (!fp || !mech.getState().areas.length) { if (roomText) { roomText = ""; lastKey = ""; render(); } return; }
  void mech.roomOver(fp.id).then((r) => {
    if (roomFor !== key) return;
    let text = "";
    if (r) {
      const tall = `${r.part.ref} stands ${round2(r.part.height)} mm ${r.part.back ? "below the back" : "above the front"} of the board${r.part.source === "estimate" ? " (estimated; give it a Height field to say exactly)" : ""}.`;
      text = r.rooms.length ? tall + " " + r.rooms.map((x) => x.area.limit <= 0 ? `“${x.area.name}” allows no components.` : x.room < 0 ? `“${x.area.name}” allows ${round2(x.area.limit)} mm: ${round2(-x.room)} mm too tall.` : `Under “${x.area.name}”: ${round2(x.room)} mm to spare.`).join(" ") : tall + " It is in no keep-out of the enclosure.";
    }
    if (text !== roomText) { roomText = text; lastKey = ""; render(); }
  });
}

function render(): void {
  const s = mech.getState();
  const show = s.active && (s.sources.length > 0 || s.orphans.length > 0);
  if (!show) { if (root) root.style.display = "none"; return; }
  if (!ensure()) return;
  const key = JSON.stringify([open, s.boardId, s.sources.map((x) => [x.link.id, x.studio, x.link.solved.errors, Object.keys(x.link.drives), drivesOf(x.link).map((d) => d.name)]), s.driven, s.orphans, s.clashes.map((c) => [c.ref, c.area.drive, c.height, c.limit]), s.checked, s.canEdit, roomText, Date.now() - s.wroteAt < 2500]);
  if (key === lastKey) return;
  lastKey = key;
  root!.style.display = "flex";
  const stale = s.sources.some((x) => Object.keys(x.link.solved.errors).length > 0);
  const names = Array.from(new Set(s.sources.map((x) => x.studio)));
  badge!.replaceChildren(lockGlyph(), h("span", undefined, names.length ? `Driven by ${names.join(", ")}` : "Was driven by a part studio"));
  badge!.dataset.clashes = String(s.clashes.length); badge!.dataset.stale = stale ? "1" : "";
  if (s.clashes.length) badge!.appendChild(h("span", "color:var(--err);font-weight:600", `${s.clashes.length} too tall`));
  else if (stale) badge!.appendChild(h("span", "color:var(--warn)", "not following"));
  else if (Date.now() - s.wroteAt < 2500) badge!.appendChild(h("span", "color:var(--ink-3)", "updated"));
  badge!.title = "What the part studio drives on this board";
  badge!.setAttribute("aria-expanded", String(open));
  body!.style.display = open ? "flex" : "none";
  if (!open) return;
  body!.replaceChildren();
  const top = h("div", "display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--paper);border-radius:var(--r-3) var(--r-3) 0 0");
  top.append(h("span", "flex:1;font-weight:600", "Enclosure"), button("3D", "Show the board in its enclosure", () => show3DViewer()));
  body!.appendChild(top);
  for (const src of s.sources) {
    const sec = section(src.studio);
    sec.dataset.link = src.link.id;
    const drives = drivesOf(src.link);
    if (!drives.length) sec.appendChild(h("div", "color:var(--ink-3)", "Linked, and driving nothing yet. Pick what drives the board in the part studio's Board panel."));
    for (const d of drives) sec.appendChild(driveRow(src, d));
    sec.appendChild(button("Open the part studio", "Open the part studio that drives this board", () => openStudio(src), "btn sm ghost"));
    body!.appendChild(sec);
  }
  if (s.orphans.length) {
    const sec = section("No longer linked");
    sec.appendChild(h("div", "color:var(--ink-3)", s.canEdit ? "Items a part studio used to drive are being released." : "Items a part studio used to drive are still locked: an editor of the board can release them."));
    body!.appendChild(sec);
  }
  if (s.areas.length) {
    const sec = section("Height check");
    sec.dataset.section = "check";
    if (!s.checked) sec.appendChild(h("div", "color:var(--ink-3)", "Checking…"));
    else if (!s.clashes.length) sec.appendChild(h("div", "color:var(--ink-3)", `No component is too tall for the ${s.areas.length} keep-out${s.areas.length === 1 ? "" : "s"} of the enclosure.`));
    for (const c of s.clashes) sec.appendChild(clashRow(c));
    if (roomText) { const r = h("div", "color:var(--ink-2);padding-top:2px", roomText); r.dataset.room = "1"; sec.appendChild(r); }
    body!.appendChild(sec);
  }
}

/** A jump from the part studio: open the panel and show what the named drive made. */
function takeJump(): void {
  const s = mech.getState(); if (!s.boardId || !s.sources.length) return;
  const hint = takeHint(s.boardId); if (!hint) return;
  open = true; lastKey = "";
  const ids = hint.drive && hint.link ? s.driven[`${hint.link}/${hint.drive}`] || [] : [];
  if (ids.length) mech.select(ids);
  render();
}

export function installMechPanel(): void {
  mech.subscribe(() => { render(); takeJump(); refreshRoom(); });
  store.subscribe(() => refreshRoom());
  void state;
}
