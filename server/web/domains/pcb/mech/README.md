# mech: the board follows a part studio

The board editor's half of the board link. A part studio of the project can drive this board's outline,
mounting holes and keep-outs; the model and the link item are described in
[`web/domains/mechanical/boardlink/README.md`](../../mechanical/boardlink/README.md). This folder reads the link
and makes the board hold what it asks for, checks components against the enclosure, and shows the enclosure in
the 3D viewer. It is part of the editor bundle (`editor/index.ts` imports it); it imports the mechanical domain
only through `mechanical/api.ts`.

## What a person sees

- A board that is driven shows a **"Driven by <part studio>"** badge at the bottom left of the canvas. The
  driven items are locked (KiCad's own lock: they are drawn with the lock shadow, they do not follow a drag)
  and grouped per drive, the group named after the part studio.
- The badge opens a panel: every drive with what it made on the board, **Show** (select it), **Model** (open
  the part studio with the source selected) and **Break link**. Breaking a link removes the drive from the
  part studio; what it made stays on the board, unlocked and ungrouped, and is the board's own from then on
  (the info bar offers Undo). A drive whose model reference is lost reads "Not following" and keeps its last
  geometry.
- **Height check**: a component that stands in a keep-out and is taller than it allows is listed in the
  panel, counted on the badge and marked on the canvas (a DRC-style marker, code `enclosure_height`). It runs
  by itself whenever the board or the link changes. From a clash: **Part** and **Area** select the offender on
  the board, **Model** opens the part studio at the face or sketch that makes the keep-out. Selecting a
  component says how much room it has under each keep-out it stands in.
- **3D viewer**: the linked part studios' bodies are drawn around the board (see-through, solid, a section
  through the middle, or hidden), and follow the model while the viewer is open. The selected component is
  marked, with a plate at the height each keep-out over it allows.

## How it works

| File | What |
|---|---|
| `links.ts` | a live session on every part studio of the project while a board is open; the links that name the board |
| `boarditems.ts` | pure: the KiCad items a link asks for, and `reconcile` (the changes that make the board hold them) |
| `sync.ts` | the reconciler on the editor's change path; the check; selection helpers |
| `check.ts` | pure: keep-out areas, polygon overlap, clashes |
| `enclosure.ts` | the enclosure and the selection marker in the 3D viewer |
| `panel.ts` | the badge and the panel |

**Writing to the board.** `reconcile` compares the driven items on the board (ids that start with `6a756e63-`)
with what the links ask for and yields ordinary item changes: added, replaced, removed. `sync.ts` applies them
with the editor's `applyChanges` and sends them with `sendOp`, the path every edit takes: one sequenced, stored
op that collaborators, the desktop client, version history and the stored file all get. They are deliberately
not put on this person's undo list: the board follows the model, and the step that takes an outline back is
undo in the part studio. Ids are a function of the link, the drive and the item's index, so two browsers
reconciling the same board write the same items and the second finds nothing to do.

**When.** Live: a link changes (its session delivers the change), or somebody edits or deletes a driven item on
the board (the next pass puts it back). On open: whatever the model changed while no browser had the board
open is applied then. Nothing writes to a board that no browser has open; the stored file catches up when one
does. A viewer of the board does not write.

**What is never deleted.** A driven item is removed only when its drive is alive and no longer asks for it (a
boss was deleted, so its hole goes). When the drive itself is gone, the items are released (unlocked, their
group removed), and only once every part studio of the project has been read, so a part studio that is slow to
load is not mistaken for a broken link. More than twelve part studios in a project are not all watched, and
then nothing is released.

**Heights.** KiCad has no component height in its board format or its DRC, so the limit lives in the link and
in the rule area's name ("Height ≤ 3.9 mm: Lid rib"), and the check is this folder's own rather than a DRC
provider. A component's height is its footprint's `Height` field (millimetres) when it has one, otherwise the
height of the stand-in body the 3D viewer draws for it (`viewer3d/bodies.ts`), which is an estimate from the
kind and size of the part; a clash says "(estimated)" in that case. A keep-out with no components allowed is
also a real KiCad keep-out (`footprints not_allowed`), so KiCad's own DRC reports it too.

**The enclosure's meshes.** A part studio document stores features, not triangles, and nothing is cached with
it (a mesh in the document would go through the collaboration log on every edit). The board page runs the
modelling worker itself: one `KernelClient` per linked part studio, fed the session `links.ts` already holds
through the mechanical domain's `studioInputs` (variables applied; a `BoardFeed` supplies the board of a studio
that also shows this board, so its openings and standoffs are built). The studio's reference bodies, the
board's own stand-in solids, are not drawn: the real board is right there. The worker and its kernel are fetched only when the 3D viewer is open on a linked board with the
enclosure shown, and are dropped when the viewer closes. `viewer3d` gained three small additions for this:
`Viewer.setExtras(meshes, section)`, `BoardScene.origin()` and the `KiCadViewer3DOpened` hook list.

## Tests

- `static/tests/pcb-mech.test.js`: the items, the reconciler against a real board document, the check.
- `static/tests/cad-boardlink.test.js`: the transform, the link item, the solver on the real kernel.
- `scripts/cad-boardlink-ui.mjs`: the whole thing in two browser contexts.

## Limits

- A keep-out is the outer boundary of its source; holes in it are ignored. Curved boundaries are polygons.
- One placement per link; the board cannot be mounted with its front towards the plane it lies on other than
  by picking a face whose normal points that way.
- Component heights are estimates unless the footprint has a `Height` field; real 3D model heights are not
  read.
- The check is not part of the DRC dialog's list and is not written to a DRC report.
