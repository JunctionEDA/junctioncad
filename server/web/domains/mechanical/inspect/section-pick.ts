// section-pick.ts — opening a section view from what is selected: a flat face gives the plane (asked of the
// worker, exact), otherwise the section opens on the last default plane.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import type { MeasureResult } from "../services/measure-entities";
import type { PartStudio } from "../ui/studio";
import { sectionOf } from "./section-view";

/** Open (or move) the section on the selected flat face.  False, with a note to the person, when there is none. */
export async function sectionFromSelection(studio: PartStudio): Promise<boolean> {
  const face = studio.getState().selection.find((p) => p.kind === "face");
  if (!face || face.kind !== "face") return false;
  try {
    const r = await studio.kernel.call<Json>("measure", { items: [{ kind: "face", body: face.body, name: face.name }] } as unknown as Json) as unknown as MeasureResult;
    const info = r.items[0];
    if (!info || info.surface !== "plane" || !info.normal) { studio.host.toast("A section needs a flat face. Pick a planar face, or use Top, Front or Right.", 3500); return false; }
    sectionOf(studio).open("face", { body: face.body, name: face.name, origin: info.origin || info.centroid, normal: info.normal });
    // the face is usually cut away: its highlight would float over the section
    studio.select(studio.getState().selection.filter((p) => !(p.kind === "face" && p.body === face.body && p.name === face.name)));
    return true;
  } catch (e) {
    studio.host.toast(e instanceof Error ? e.message : String(e), 3500);
    return false;
  }
}

/** The Section tool: off when on; else on the selected flat face, or the last default plane. */
export async function toggleSection(studio: PartStudio): Promise<void> {
  const sec = sectionOf(studio);
  if (sec.getState().on) { sec.close(); return; }
  if (studio.getState().selection.some((p) => p.kind === "face") && (await sectionFromSelection(studio))) return;
  sec.open(sec.getState().plane === "face" ? "front" : sec.getState().plane);
}
