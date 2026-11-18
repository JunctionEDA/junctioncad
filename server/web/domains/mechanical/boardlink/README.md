# The board link: a part studio drives a board

A part studio can drive a board of the same project: the board's outline, its mounting holes and keep-out areas
with height limits are taken from the model and follow it. This folder is the part studio's half; the board
editor's half is [`web/domains/pcb/mech`](../../pcb/mech/README.md). The opposite direction, the board shown as
a model inside a part studio, is `mechanical/board/`; when a studio does both, the board lies where its Board
feature puts it (see "Placement").

## The model

```
part studio (.jpart)                                   board (.kicad_pcb)
 feature items                                          Edge.Cuts lines, arcs, circles   ┐ locked, in a group
 board-link item ─ plane, lift, anchor, rotation        mounting-hole footprints         ├ per drive, with ids
   drives { outline | holes | keepout }                 rule areas named with a limit    ┘ derived from the link
   solved { the drives as board geometry, in nm } ───►  written by the board editor's reconciler
        ▲
        └ written by the part studio page after each rebuild (driver.ts → the "boardlink-solve" service)
```

- **The link lives in the part studio**, as one item of type `board-link` per board (`format.ts`). The board
  holds no link data: what it holds are ordinary KiCad items, recognisable as driven by their ids
  (`ids.ts`: all start with `6a756e63-`), their lock and their group ("Board outline (driven by Enclosure)").
- **A drive** names a source in the model (every region or circle of a sketch, or picked faces) and what it
  becomes: `outline` (with a clearance inwards, optionally keeping inner loops as cut-outs), `holes` (one at each
  circle of a sketch, at the centre of each picked flat face, or on the axis of each picked bore; a drill
  diameter and an optional pad), `keepout` (no components, components up to a height, or components up to the
  picked face less a clearance, so the limit follows the model).
- **`solved`** is the drives turned into board geometry by the kernel (`solve.ts`, in the worker): whole
  nanometres, Y down, arcs as start / mid / end. It is stored in the link item so the board editor never has to
  run the kernel to follow a link, and so a board that nobody has open is brought up to date when it is next
  opened. It is the *last good* answer: a drive whose source is lost (a face renamed by a redrawn sketch, a
  suppressed feature) keeps its geometry and gets a message in `solved.errors`; both editors show it as not
  following. A broken reference never deletes a board outline.
- **Placement.** One of two, never both:
  - *By a Board feature* (`feature: <id>` on the link): the board is shown in the model by that feature and
    lies where it puts it. The worker takes the frame the feature was built with (`board/placement.ts
    builtFrames`) and the feature's `origin` as the sheet point at the frame's origin, with no further turn; the
    answer carries them as `solved.frame`, `solved.anchor` and `solved.rotation` (`placementOf` reads those).
    The link's own `plane`, `lift`, `anchor` and `rotation` are not used. This is what **Link this board** makes
    when the studio already shows the board, and what **Show the board in the model** turns a link into (it adds
    a Board feature on the link's plane, raised by its lift, with the link's anchor as its origin and the
    opposite turn: the same place exactly). A feature that is suppressed or gone leaves the link "not
    following", with its last geometry.
  - *By the link itself*: `plane` (a default plane or a planar face) raised by `lift` is the board's *back* face;
    the plane's normal points to the board's front. `anchor` is where the plane's origin lands on the KiCad
    sheet and `rotation` turns the board about it. The picked face of a boss top therefore places a board on the
    bosses with its components facing away from them, whichever way the bosses point.

## Units and coordinates

`transform.ts` is the one place a point crosses between the two: `modelToBoard` (millimetres, Z up →
nanometres, Y down, plus the height above the board's back face), its inverse, and `modelToBoard3D` for
drawing a model around a board (a rigid motion: no mirror). Nothing else converts. Tested in
`static/tests/cad-boardlink.test.js`.

## When things happen

- `driver.ts` runs in every part studio page that may edit. After each rebuild of the *committed* model (not
  while a feature dialog previews, a sketch is open, or the rollback bar is above the end) it calls the
  service and, if the answer differs, commits it to the link item (not an undo step). Everybody's driver
  computes the same answer, so a second writer sends nothing.
- The board editor follows the link item live through a session on the part studio document, and reconciles
  on open. See the other README.
- **Limit:** the answer is written by a part studio *page*. An edit to the `.jpart` by something that does not
  run this driver (an import, a future server-side tool) leaves `solved` stale until a part studio page opens.
- **Limit:** while a sketch is open the board waits; it follows when the sketch is finished.

## Files

| File | What |
|---|---|
| `format.ts` | the link item, the drives, `Solved`, and every edit as item changes |
| `transform.ts` | the coordinate transform |
| `ids.ts` | ids of driven board items |
| `solve.ts` | worker: drives → board geometry on OpenCascade (`services/boardlink-solve.ts` registers it) |
| `driver.ts` | page: keeps the links solved |
| `Panel.tsx` | the Board panel (`panels/boardlink.tsx` registers it); its first part is `board/ShownBoards.tsx` |
| `hint.ts` | the note one editor leaves the other for a jump between a board item and its source |
| `api.ts` | what the board editor imports (re-exported by `mechanical/api.ts`) |
