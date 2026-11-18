// Panel.tsx — the Board panel of a part studio: which board this model drives, where the board lies in the
// model, and what it drives there (the outline, mounting holes, keep-outs).  Everything it does is an edit of
// the link item (format.ts); the driver (driver.ts) keeps the link solved, and the board editor follows.
import { useEffect, useState, useSyncExternalStore } from "react";
import { newId, type ItemChange, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import { cx } from "../../../shared/util";
import { DEFAULT_PLANES, type GeomRef, type PlaneRef } from "../core/geometry";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";
import type { Pick } from "../viewport/modelview";
import { ensureDriver } from "./driver";
import { DRIVE_TITLES, addDrive, addLink, drivesOf, linksOf, removeDrive, removeLink, setDrive, setLink, type BoardLinkItem, type Drive, type DriveKind, type DriveSource, type SolvedKeepout } from "./format";
import { leaveHint, takeHint } from "./hint";
import { ShownBoards } from "../board/ShownBoards";
import { featuresOf, nextName, orderAt, type FeatureItem } from "../document/format";
import { addedChange } from "../../../shared/itemdoc/itemdoc";
import { featureDef } from "../ui/studio";

const BOARD_FEATURE = "board-reference";

/**
 * A Board feature that puts the board exactly where a link has it: on the link's plane, raised by its lift,
 * the link's sheet anchor at the plane's origin, turned the other way (the link turns the sheet, the feature
 * the board).  The link is then placed by the feature (format.ts `feature`), so there is one placement.
 */
function showBoardChanges(studio: PartStudio, link: BoardLinkItem): ItemChange[] {
  const doc = studio.doc, def = featureDef(BOARD_FEATURE); if (!doc || !def) return [];
  const features = featuresOf(doc);
  const feature: FeatureItem = {
    id: newId(), type: "feature", featureType: BOARD_FEATURE, name: nextName(features, def.title), order: orderAt(features, features.length),
    params: { ...def.defaults(), board: link.board, plane: link.plane as unknown as JsonObject, x: 0, y: 0, z: link.lift, angle: -link.rotation || 0, flip: false, origin: [link.anchor[0], link.anchor[1]] },
  };
  return [addedChange(feature), ...setLink(doc, link.id, { feature: feature.id })];
}

const BOARD_DOC_TYPE = "kicad_pcb";
const baseName = (path: string) => (path.split("/").pop() || path).replace(/\.[^.]+$/, "");

/** What the selection could drive: picked faces, or a sketch (picked in the model or selected in the list). */
function sourceFromSelection(studio: PartStudio): DriveSource | null {
  const s = studio.getState();
  const faces = s.selection.filter((p): p is Extract<Pick, { body: string }> => p.kind === "face");
  if (faces.length) return { kind: "faces", refs: faces.map((p): GeomRef => ({ kind: "face", body: p.body, name: p.name })) };
  const sk = s.selection.find((p): p is Extract<Pick, { featureId: string }> => p.kind === "sketch");
  if (sk) return { kind: "sketch", feature: sk.featureId };
  const f = s.selectedFeature ? s.features.find((x) => x.id === s.selectedFeature) : null;
  return f && f.featureType === "sketch" ? { kind: "sketch", feature: f.id } : null;
}

/** The plane the selection names: a default plane, a face, or the plane a selected sketch is drawn on. */
function planeFromSelection(studio: PartStudio): PlaneRef | null {
  const s = studio.getState();
  for (const p of s.selection) {
    if (p.kind === "plane") return { kind: "plane", plane: p.plane };
    if (p.kind === "face") return { kind: "face", ref: { kind: "face", body: p.body, name: p.name } };
  }
  const src = sourceFromSelection(studio);
  if (src && src.kind === "sketch") { const f = s.features.find((x) => x.id === src.feature); const pl = f && (f.params.plane as unknown as PlaneRef | undefined); if (pl) return pl; }
  return null;
}

function showSource(studio: PartStudio, source: DriveSource): void {
  if (source.kind === "sketch") { studio.select([]); studio.selectFeature(source.feature); return; }
  studio.selectFeature(null);
  studio.select(source.refs.map((r): Pick => ({ kind: "face", body: r.body, name: r.name, point: [0, 0, 0] })));
}

function sourceText(studio: PartStudio, source: DriveSource): string {
  if (source.kind === "sketch") { const f = studio.getState().features.find((x) => x.id === source.feature); return f ? f.name : "a sketch that is gone"; }
  return `${source.refs.length} face${source.refs.length === 1 ? "" : "s"}`;
}

function Num({ value, onCommit, label, unit = "mm", name }: { value: number; onCommit(v: number): void; label: string; unit?: string; name: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => { const v = Number(text); if (text.trim() !== "" && Number.isFinite(v)) { if (v !== value) onCommit(v); } else setText(String(value)); };
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_64px_18px] items-center gap-1.5 min-h-6" title={label}>
      <span className="text-ink-2 truncate">{label}</span>
      <input className="input mono min-w-0 w-full" inputMode="decimal" value={text} data-field={name} aria-label={label}
        onChange={(ev) => setText(ev.target.value)} onBlur={commit} onKeyDown={(ev) => { if (ev.key === "Enter") { commit(); (ev.target as HTMLInputElement).blur(); } ev.stopPropagation(); }} />
      <span className="text-ink-3 font-mono text-xs">{unit}</span>
    </label>
  );
}

function limitText(k: SolvedKeepout): string {
  if (k.mode === "none") return "no components";
  if (k.mode === "height") return `components up to ${k.max} mm`;
  const room = Math.abs(k.gap);
  return `${k.side === "top" ? "face" : "face behind the board,"} ${room.toFixed(2)} mm from the board's back`;
}

function DriveRow({ studio, link, drive, canEdit }: { studio: PartStudio; link: BoardLinkItem; drive: Drive & { id: string }; canEdit: boolean }) {
  const commit = (changes: ItemChange[]) => { if (changes.length) studio.commit(changes); };
  const set = (patch: JsonObject) => commit(setDrive(studio.doc!, link.id, drive.id, patch));
  const error = link.solved.errors[drive.id];
  const solved = link.solved.drives[drive.id];
  let summary = "";
  if (solved && solved.kind === "outline") summary = `${solved.curves.length} edge${solved.curves.length === 1 ? "" : "s"} on Edge.Cuts`;
  else if (solved && solved.kind === "holes") summary = `${solved.holes.length} hole${solved.holes.length === 1 ? "" : "s"}`;
  else if (solved && solved.kind === "keepout") summary = limitText(solved);
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 border-t border-line" data-drive={drive.id} data-drive-kind={drive.kind} data-drive-state={error ? "error" : solved ? "ok" : "pending"}>
      <div className="flex items-center gap-1.5">
        <span className="flex-1 font-semibold truncate" title={drive.name}>{drive.name}</span>
        <button type="button" className="btn sm ghost" title="Show what this is taken from" data-act="show" onClick={() => showSource(studio, drive.source)}>{sourceText(studio, drive.source)}</button>
        {canEdit ? <button type="button" className="btn sm ghost px-1" title="Stop driving this. What it made on the board stays there, unlocked." data-act="remove" onClick={() => commit(removeDrive(studio.doc!, link.id, drive.id))}>×</button> : null}
      </div>
      {drive.kind === "outline" ? <>
        <Num name="inset" label="Clearance inside" value={drive.inset} onCommit={(v) => set({ inset: v })} />
        <label className="flex items-center gap-1.5 min-h-6"><span className="flex-1 text-ink-2">Inner loops are cut-outs</span><input type="checkbox" checked={!!drive.cutouts} data-field="cutouts" onChange={(ev) => set({ cutouts: ev.target.checked })} /></label>
      </> : null}
      {drive.kind === "holes" ? <>
        <Num name="diameter" label={drive.source.kind === "sketch" ? "Drill (0: as drawn)" : "Drill"} value={drive.diameter} onCommit={(v) => set({ diameter: Math.max(0, v) })} />
        <Num name="pad" label="Pad (0: unplated)" value={drive.pad} onCommit={(v) => set({ pad: Math.max(0, v) })} />
      </> : null}
      {drive.kind === "keepout" ? <>
        <span className="seg" data-field="mode">
          <button type="button" className={cx(drive.mode === "none" && "on")} title="No components may stand here" onClick={() => set({ mode: "none" })}>None</button>
          <button type="button" className={cx(drive.mode === "height" && "on")} title="Components up to a height" onClick={() => set({ mode: "height" })}>Height</button>
          <button type="button" className={cx(drive.mode === "ceiling" && "on")} title="Components up to the picked face, less a clearance: the limit follows the model" disabled={drive.source.kind !== "faces"} onClick={() => set({ mode: "ceiling" })}>Under face</button>
        </span>
        {drive.mode === "height" ? <Num name="maxHeight" label="Tallest component" value={drive.maxHeight} onCommit={(v) => set({ maxHeight: Math.max(0, v) })} /> : null}
        {drive.mode === "ceiling" ? <Num name="clearance" label="Clearance to the face" value={drive.clearance} onCommit={(v) => set({ clearance: Math.max(0, v) })} /> : null}
        {drive.mode !== "ceiling" ? (
          <label className="flex items-center gap-1.5 min-h-6"><span className="flex-1 text-ink-2">Side of the board</span>
            <span className="seg" data-field="side"><button type="button" className={cx(drive.side !== "bottom" && "on")} onClick={() => set({ side: "top" })}>Front</button><button type="button" className={cx(drive.side === "bottom" && "on")} onClick={() => set({ side: "bottom" })}>Back</button></span>
          </label>
        ) : null}
      </> : null}
      {error ? <p className="callout warn m-0" role="status">{error} The board keeps what it had.</p> : summary ? <p className="note m-0">{summary}</p> : <p className="note m-0">Working it out…</p>}
    </div>
  );
}

export function BoardLinkPanel({ studio }: { studio: PartStudio }) {
  const driver = ensureDriver(studio);
  const driverStatus = useSyncExternalStore(driver.subscribe, driver.getStatus);
  const loaded = useStudio(studio, (s) => s.loaded);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  // the links are read from the document: `features` is made anew on every change of it (a link item's too),
  // so reading it draws the panel again when the link changes; the other two follow the selection
  useStudio(studio, (s) => s.features);
  useStudio(studio, (s) => s.selection);
  useStudio(studio, (s) => s.selectedFeature);
  const boards = studio.host.docs.filter((d) => d.docType === BOARD_DOC_TYPE);
  const [boardId, setBoardId] = useState(boards[0]?.docId || "");
  const [probe, setProbe] = useState("");
  const doc = studio.doc;
  const links = doc ? linksOf(doc) : [];
  const link = links.find((l) => l.board === boardId) || null;

  // a jump from the board editor: show what the named drive is taken from
  useEffect(() => {
    if (!loaded || !studio.doc) return;
    const hint = takeHint(studio.host.doc.docId); if (!hint) return;
    const l = linksOf(studio.doc).find((x) => x.id === hint.link); if (!l) return;
    setBoardId(l.board);
    const d = hint.drive ? l.drives[hint.drive] : null;
    if (d) window.setTimeout(() => showSource(studio, d.source), 300);
    // a clash on the board: the component is drawn in the model where it stands
    if (hint.box && hint.box.length >= 6) { const box = hint.box; setProbe(hint.note || "A component of the board is drawn in the model."); window.setTimeout(() => studio.view.setOverlay(box), 350); }
  }, [loaded, studio]);

  if (!loaded) return null;
  if (!boards.length) return <p className="note px-2 py-1 m-0">This project has no board.</p>;
  // the Board feature that shows this board in the model, and the one the link is placed by
  const shown = studio.getState().features.filter((f) => f.featureType === BOARD_FEATURE && f.params.board === boardId);
  const placedBy = link && link.feature ? shown.find((f) => f.id === link.feature) || null : null;
  const commit = (changes: ItemChange[]) => { if (changes.length) studio.commit(changes); };
  const source = sourceFromSelection(studio);
  const plane = planeFromSelection(studio);
  const openBoard = () => { if (link) leaveHint({ doc: link.board, link: link.id }); studio.host.openDoc(boardId); };
  const add = (kind: DriveKind) => { if (link && source) commit(addDrive(studio.doc!, link.id, newId().slice(0, 8), kind, source)); };
  const hasOutline = !!link && Object.values(link.drives).some((d) => d.kind === "outline");
  const planeText = !link ? "" : link.plane.kind === "plane" ? `${DEFAULT_PLANES[link.plane.plane]?.title || link.plane.plane} plane` : "A face of the model";
  const need = source ? "" : "Select a sketch or flat faces first";

  return (
    <div className="flex flex-col text-sm" data-boardlink={link ? link.id : ""} data-solving={driverStatus.solving || undefined} data-writes={driverStatus.writes}>
      <ShownBoards studio={studio} />
      <div className="px-2 pt-1.5 text-2xs uppercase tracking-wide text-ink-3 mono border-t border-line">Driven by this model</div>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {boards.length > 1
          ? <select className="input flex-1 min-w-0" value={boardId} aria-label="Board" onChange={(ev) => setBoardId(ev.target.value)}>{boards.map((b) => <option key={b.docId} value={b.docId}>{baseName(b.path)}</option>)}</select>
          : <span className="flex-1 truncate font-semibold">{baseName(boards[0].path)}</span>}
        <button type="button" className="btn sm" data-act="open-board" title="Open the board" onClick={openBoard}>Open</button>
      </div>
      {probe ? (
        <p className="callout err mx-2 mb-1.5 mt-0 flex items-start gap-1.5" role="status" data-probe>
          <span className="flex-1">{probe}</span>
          <button type="button" className="btn sm ghost px-1" title="Clear the box from the model" onClick={() => { setProbe(""); studio.view.setOverlay(null); }}>×</button>
        </p>
      ) : null}
      {!link ? (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {shown.length
            ? <p className="note m-0">Not driven by this part studio. Linking lets the model drive the board’s outline, holes and keep-outs; the board stays where {shown[0].name} puts it.</p>
            : <p className="note m-0">Not driven by this part studio. Linking places the board on a plane of the model; the selection is used when it names one.</p>}
          {canEdit ? <button type="button" className="btn sm primary self-start" data-act="link" onClick={() => commit(shown.length ? addLink(newId(), boardId, shown[0].params.plane as unknown as PlaneRef, shown[0].id) : addLink(newId(), boardId, plane || { kind: "plane", plane: "top" }))}>Link this board</button> : null}
        </div>
      ) : (
        <>
          {placedBy ? (
            <div className="flex flex-col gap-1 px-2 pb-1.5" data-section="placement" data-placed-by={placedBy.id}>
              <label className="flex items-center gap-1.5 min-h-6">
                <span className="flex-1 text-ink-2 truncate" title="The board is shown in the model by this feature, and lies where it puts it">Placed by</span>
                <span className="truncate" data-field="plane">{placedBy.name}</span>
                {canEdit ? <button type="button" className="btn sm" data-act="edit-placement" title="Change where the board lies" onClick={() => studio.editFeature(placedBy.id)}>Edit</button> : null}
              </label>
              {link.solved.errors.plane ? <p className="callout warn m-0" role="status">{link.solved.errors.plane} The board keeps what it had.</p> : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1 px-2 pb-1.5" data-section="placement">
              <label className="flex items-center gap-1.5 min-h-6">
                <span className="flex-1 text-ink-2 truncate" title="Where the back of the board lies">Board lies on</span>
                <span className="truncate" data-field="plane">{planeText}</span>
                {canEdit ? <button type="button" className="btn sm" data-act="plane" disabled={!plane} title={plane ? "Lay the board on the selected plane or face" : "Select a plane or a flat face first"} onClick={() => plane && commit(setLink(studio.doc!, link.id, { plane }))}>Set</button> : null}
              </label>
              <Num name="lift" label="Raised by" value={link.lift} onCommit={(v) => commit(setLink(studio.doc!, link.id, { lift: v }))} />
              <Num name="anchor-x" label="Origin on the sheet, X" value={link.anchor[0]} onCommit={(v) => commit(setLink(studio.doc!, link.id, { anchor: [v, link.anchor[1]] }))} />
              <Num name="anchor-y" label="Origin on the sheet, Y" value={link.anchor[1]} onCommit={(v) => commit(setLink(studio.doc!, link.id, { anchor: [link.anchor[0], v] }))} />
              <Num name="rotation" label="Turned" unit="°" value={link.rotation} onCommit={(v) => commit(setLink(studio.doc!, link.id, { rotation: v }))} />
              {canEdit ? (shown.length
              ? <button type="button" className="btn sm self-start" data-act="place-by" title={`The board lies where ${shown[0].name} shows it: one placement for both`} onClick={() => commit(setLink(studio.doc!, link.id, { feature: shown[0].id }))}>Place it where {shown[0].name} is</button>
              : <button type="button" className="btn sm self-start" data-act="show-board" title="Show the board in the model, where this link places it" onClick={() => commit(showBoardChanges(studio, link))}>Show the board in the model</button>) : null}
            {link.solved.errors.plane ? <p className="callout warn m-0" role="status">{link.solved.errors.plane} The board keeps what it had.</p> : null}
            </div>
          )}
          {drivesOf(link).map((d) => <DriveRow key={d.id} studio={studio} link={link} drive={d} canEdit={canEdit} />)}
          {canEdit ? (
            <div className="flex flex-col gap-1 px-2 py-1.5 border-t border-line" data-section="add">
              <span className="text-ink-2">Drive from the selection</span>
              <div className="flex flex-wrap gap-1">
                <button type="button" className="btn sm" data-add="outline" disabled={!source || hasOutline} title={hasOutline ? "The outline is already driven" : need || "The board's Edge.Cuts follows the selection"} onClick={() => add("outline")}>Outline</button>
                <button type="button" className="btn sm" data-add="holes" disabled={!source} title={need || "A mounting hole at every circle of the sketch, or at the centre of every picked face"} onClick={() => add("holes")}>{DRIVE_TITLES.holes}</button>
                <button type="button" className="btn sm" data-add="keepout" disabled={!source} title={need || "A rule area on the board, with a height limit"} onClick={() => add("keepout")}>Keep-out</button>
              </div>
              {driverStatus.error ? <p className="callout err m-0" role="status">{driverStatus.error}</p> : null}
              <button type="button" className="btn sm ghost self-start" data-act="unlink" title="Stop driving this board. What was made on it stays there, unlocked." onClick={() => commit(removeLink(studio.doc!, link.id))}>Remove the link</button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
