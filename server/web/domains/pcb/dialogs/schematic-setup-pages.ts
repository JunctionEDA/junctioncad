// dialogs/schematic-setup-pages.ts — the Schematic Setup pages beyond Formatting / Rules / Net Classes:
//   General > Annotation                 PANEL_EESCHEMA_ANNOTATION_OPTIONS (schematic.annotation.*, annotate_start_num,
//                                        subpart_id_separator / subpart_first_id, reuse_designators)
//   Electrical Rules > Compare Symbol    PANEL_SETUP_SYMBOL_PARITY (schematic.compare_symbols.*)
//     with Library
//   Project > Net Chains                 PANEL_SETUP_NET_CHAINS (the root sheet's (net_chain …) items and
//                                        net_settings.net_chain_classes)
//   Schematic Data > Embedded Files      PANEL_EMBEDDED_FILES (the root sheet's (embedded_files …))
// and DIALOG_SCH_IMPORT_SETTINGS (Import Settings from Another Project...), whose sections are copied by
// importSections.  The logic half (annotationOf, separatorChoice, chainsOf, importSections) is plain data.
import { KD, checkbox, h, select, textInput, promptText, confirmBox } from "./dom";
import { messageBox } from "./sch-items";
import { kicadIcon, bitmapButton } from "../../../shared/components/kicon-dom";
import { zstdDecompress } from "./zstd";
import { PARITY, UNIT_NOTATIONS, embeddedFilesText, embeddedOf, type AnnotationSettings, type ChainRow, type ChainState } from "./schematic-setup-logic";
export * from "./schematic-setup-logic";

// ---------------------------------------------------------------- Annotation
export function annotationPage(pg: HTMLElement, s: AnnotationSettings, ro: boolean): void {
  const radio = (name: string, on: boolean, label: Node | string, set: () => void, id?: string): HTMLElement => {
    const r = h("input", { type: "radio", name, checked: on, disabled: ro, id }) as HTMLInputElement; r.addEventListener("change", () => { if (r.checked) set(); });
    return h("label", { class: "kd-chk" }, r, label);
  };
  const units = KD().staticBox(pg, "Units");
  units.append(h("div", { class: "kd-row" }, h("label", null, "Symbol unit notation:"), select(UNIT_NOTATIONS.map((n, i) => [String(i), n[0]] as [string, string]), String(s.notation), (v) => { s.notation = +v; }, { id: "kd-ss-unitnotation", disabled: ro, style: "width:90px" })));
  const order = KD().staticBox(pg, "Order");
  order.append(h("div", { class: "kd-row" }, kicadIcon("annotate_down_right", 24), radio("kd-ss-sort", !s.sortY, "Sort symbols by X position", () => { s.sortY = false; }, "kd-ss-sortx")),
    h("div", { class: "kd-row" }, kicadIcon("annotate_right_down", 24), radio("kd-ss-sort", s.sortY, "Sort symbols by Y position", () => { s.sortY = true; }, "kd-ss-sorty")));
  const num = KD().staticBox(pg, "Numbering");
  const after = textInput(String(s.startNum), (v) => { const n = parseInt(v, 10); s.startNum = isFinite(n) && n >= 0 ? n : 0; }, { id: "kd-ss-startnum", disabled: ro, style: "width:70px" });
  num.append(h("div", { class: "kd-row" }, radio("kd-ss-method", s.method === 0, "Use first free number after:", () => { s.method = 0; }, "kd-ss-firstfree"), after),
    radio("kd-ss-method", s.method === 1, "First free after sheet number X 100", () => { s.method = 1; }, "kd-ss-x100"),
    radio("kd-ss-method", s.method === 2, "First free after sheet number X 1000", () => { s.method = 2; }, "kd-ss-x1000"),
    checkbox("Allow reference reuse", s.reuse, (on) => { s.reuse = on; }, { id: "kd-ss-reuse", disabled: ro }));
  const rs = KD().staticBox(pg, "Reused Sheets");
  rs.append(radio("kd-ss-reused", !s.suffixes, "Number each sheet instance separately (R1, R2 ...)", () => { s.suffixes = false; }, "kd-ss-separate"),
    radio("kd-ss-reused", s.suffixes, "Number each file once and add the sheet's reference suffix (R1_M1, R1_M2 ...)", () => { s.suffixes = true; }, "kd-ss-suffix"),
    h("p", { class: "kd-note", style: "margin:2px 0 6px 22px" }, "Repeated instances of one sheet file need distinct full reference suffixes. Set Reference Suffix in Sheet Properties."),
    checkbox("Give pasted sheets the next free reference suffix", s.incrementPasted, (on) => { s.incrementPasted = on; }, { id: "kd-ss-incpasted", disabled: ro }));
  const tip = rs.querySelector("#kd-ss-incpasted"); if (tip && tip.parentElement) tip.parentElement.title = "A pasted sheet whose suffix is already in use continues its series, so _M1 becomes _M4 when _M3 is in use";
}

// ---------------------------------------------------------------- Compare Symbol with Library
export function parityPage(pg: HTMLElement, p: Record<string, boolean>, ro: boolean): void {
  for (const [title, rows] of PARITY) {
    const box = KD().staticBox(pg, title);
    for (const [k, label] of rows) box.append(checkbox(label, p[k], (on) => { p[k] = on; }, { id: "kd-ss-parity-" + k, disabled: ro }));
  }
}

// ---------------------------------------------------------------- Net Chains
/** PANEL_SETUP_NET_CHAINS: the Chains tab (grid, member nets) and the Net Chain Classes tab. The chains themselves live
 *  in the schematic, so their name, net class and colour show here as KiCad has them; the class assignments are the
 *  project's and are edited. */
export function netChainsPage(pg: HTMLElement, st: ChainState, netClasses: () => string[], ro: boolean): void {
  void netClasses;
  KD().notebook(pg, [
    { label: "Chains", build(tab) {
      const header = h("div", { id: "kd-ss-chains-header", style: "margin:4px 0 4px 2px" });
      const members = h("div", { class: "kd-list", id: "kd-ss-chain-members", style: "height:240px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-1);background:var(--field)" });
      const mlabel = h("div", { style: "margin:0 0 4px" }, "Member Nets");
      const show = (r: ChainRow | null): void => {
        mlabel.textContent = r ? (r.name ? `Member Nets — ${r.name} (${r.nets.length})` : `Member Nets (${r.nets.length})`) : "Member Nets";
        members.replaceChildren(...(r ? r.nets : []).map((n) => h("div", { style: "padding:1px 6px" }, n)));
      };
      const rows = st.chains;
      header.textContent = `${rows.length} net chain(s)`;
      const g = KD().grid<ChainRow>(h("div"), [
        { key: "name", label: "Name", type: "ro" }, { key: "nets", label: "Members", type: "ro", width: 80, format: (v) => `${(v as string[]).length} nets` },
        { key: "chainClass", label: "Net Chain Class", type: "choice", width: 150, options: () => [["", ""] as [string, string], ...st.classes.map((c) => [c, c] as [string, string])] },
        { key: "netClass", label: "Net Class", type: "ro", width: 120 }, { key: "color", label: "Colour", type: "ro", width: 140 }], rows,
        { readOnly: ro, height: 240, onSelect: (r) => show(r) });
      const left = h("div", { style: "flex:3;min-width:0" }, g.el), right = h("div", { style: "flex:1;min-width:140px" }, mlabel, members);
      const del = bitmapButton("small_trash", "Delete the selected committed net chain", null, { cls: "kd-ss-chain-del" }); del.disabled = true;
      tab.append(header, h("div", { style: "display:flex;gap:8px" }, left, right), h("div", { class: "kd-row", style: "margin-top:4px" }, del,
        h("span", { class: "kd-note" }, "Net chains are created, renamed and deleted on the schematic canvas.")));
      if (rows.length) g.select(0); else show(null);
    } },
    { label: "Net Chain Classes", build(tab) {
      const count = (c: string): number => st.chains.filter((r) => r.chainClass === c).length;
      const rows = st.classes.map((name) => ({ name, members: count(name) }));
      const host = h("div");
      const g = KD().grid<{ name: string; members: number }>(host, [{ key: "name", label: "Class Name", type: "ro" }, { key: "members", label: "Members", type: "ro", width: 90 }], rows, { readOnly: ro, height: 260 });
      const sync = (): void => { st.classes.splice(0, st.classes.length, ...rows.map((r) => r.name)); for (const r of rows) r.members = count(r.name); g.refresh(); };
      const taken = (n: string, except = -1): boolean => !n.trim() || rows.some((r, i) => i !== except && r.name === n.trim());
      const add = bitmapButton("small_plus", "Add a new net chain class", async () => {
        const n = await promptText("Add Class", "New net chain class name:"); if (n === null) return;
        if (taken(n)) { await messageBox("That class name is empty or already in use.", "Add Class"); return; }
        rows.push({ name: n.trim(), members: 0 }); sync(); g.select(rows.length - 1);
      });
      const ren = bitmapButton("small_edit", "Rename the selected class (updates every chain that uses it)", async () => {
        const i = g.selected(); if (i < 0) return; const old = rows[i].name;
        const n = await promptText("Rename Class", "Rename net chain class:", old); if (n === null || n.trim() === old) return;
        if (taken(n, i)) { await messageBox("That class name is empty or already in use.", "Rename Class"); return; }
        rows[i].name = n.trim(); for (const c of st.chains) if (c.chainClass === old) c.chainClass = n.trim(); sync();
      });
      const del = bitmapButton("small_trash", "Delete the selected class (chains revert to no class)", async () => {
        const i = g.selected(); if (i < 0) return;
        if (!(await confirmBox("Delete Class", `Delete net chain class '${rows[i].name}'?  Chains assigned to it will become unclassified.`, "Yes"))) return;
        const old = rows[i].name; rows.splice(i, 1); for (const c of st.chains) if (c.chainClass === old) c.chainClass = ""; sync();
      });
      for (const b of [add, ren, del]) b.disabled = ro;
      tab.append(h("div", { style: "margin:4px 0 6px 2px" }, "Group net chains under a class label so DRC rules can target the whole group via ", h("code", null, "inNetChainClass('name')"), "."),
        host, h("div", { class: "kd-row", style: "margin-top:4px" }, add, ren, h("span", { style: "width:20px" }), del));
    } },
  ]);
}
// ---------------------------------------------------------------- Embedded Files
// PANEL_EMBEDDED_FILES over the root schematic's (embedded_files …): the list, and Export... writes the files out (the
// selected one, else all of them) as EMBEDDED_FILES::DecompressAndDecode gives them.  Adding, removing and the
// Embed fonts flag change the file's header, which no collaborative change carries yet, so they stay disabled.
export function embeddedFilesPage(pg: HTMLElement, load: () => Promise<string>): void {
  const rows: { name: string; ref: string }[] = [];
  const host = h("div");
  let sel = -1, text = "";
  const g = KD().grid<{ name: string; ref: string }>(host, [{ key: "name", label: "Filename", type: "ro" }, { key: "ref", label: "Embedded Reference", type: "ro" }], rows, { readOnly: true, height: 300 });
  host.addEventListener("click", (ev) => { const tr = (ev.target as HTMLElement).closest("tr"); if (tr && tr.parentElement && tr.parentElement.tagName === "TBODY") sel = Array.from(tr.parentElement.children).indexOf(tr); });
  const fonts = checkbox("Embed fonts", false, () => undefined, { id: "kd-ss-embedfonts", disabled: true });
  const add = bitmapButton("small_plus", "Add embedded file", null), del = bitmapButton("small_trash", "Remove embedded file", null);
  add.disabled = del.disabled = true;
  const exp = h("button", { type: "button", class: "btn", id: "kd-ss-embedexport", disabled: true }, "Export...") as HTMLButtonElement;
  exp.addEventListener("click", () => {
    const names = sel >= 0 && sel < rows.length ? [rows[sel].name] : rows.map((r) => r.name);
    const bad = names.filter((n) => { const b = embeddedFileBytes(text, n); if (b) downloadBytes(n, b); return !b; });
    if (bad.length) void messageBox(`Could not read the embedded file '${bad[0]}'.`);
  });
  pg.append(host, h("div", { class: "kd-row", style: "margin-top:4px" }, add, del, h("span", { style: "flex:1" }), fonts, exp),
    h("p", { class: "kd-note", style: "margin:6px 0 0" }, "Files are embedded in the root schematic file; adding and removing them is done in the desktop application."));
  void load().then((t) => {
    text = t; const e = embeddedOf(t); rows.push(...e.files.map((n) => ({ name: n, ref: "kicad-embed://" + n }))); g.refresh();
    exp.disabled = !rows.length;
    const cb = pg.querySelector<HTMLInputElement>("#kd-ss-embedfonts"); if (cb) cb.checked = e.fonts;
  }).catch(() => undefined);
}
/** EMBEDDED_FILES::DecompressAndDecode of the root file's embedded file `name`: base64, then the zstd frame. */
function embeddedFileBytes(text: string, name: string): Uint8Array | null {
  const src = embeddedFilesText(text); if (!src) return null;
  const ef = KiCadCanvas.parse(src) as SNode | null; if (!ef) return null;
  const f = (KiCadCanvas.kids(ef, "file") as SNode[]).find((x) => String((KiCadCanvas.kid(x, "name") || [])[1] ?? "") === name); if (!f) return null;
  const d = KiCadCanvas.kid(f, "data"); if (!d) return null;
  const b64 = d.slice(1).map((x) => String(x)).join("").replace(/[|\s]/g, "");
  try { const bin = atob(b64); const raw = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i); return zstdDecompress(raw); } catch { return null; }
}
function downloadBytes(name: string, bytes: Uint8Array): void {
  const a = h("a", { href: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" })), download: name }) as HTMLAnchorElement;
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------- Import Settings
