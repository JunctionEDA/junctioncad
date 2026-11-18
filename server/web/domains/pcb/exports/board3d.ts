// exports/board3d.ts — what other domains may import to draw a board in 3D as the 3D viewer draws it.
//
// The three.js half of the electronics domain's export surface for the board as a mechanical object (the pure
// geometry half is exports/board-geometry.ts).  A caller keeps its own scene; these are the viewer's pieces:
//
//   slabGeometries(shape, perOutline, thickness, toModel, uvOf)   the laminate: two faces, the edge, the barrels
//   FaceComposer / textureExtent                                  the two faces as images, from the document's layers
//   partTriangles(body, thickness, models, toModel)               one part: its 3D model when loaded, else a stand-in
//   modelStore()                                                  the page's store of tessellated part models
//   layerColor(key)                                               KiCad's 3D colours (board, copper, …)
//
// Model space is the viewer's: millimetres, front face of the board at z = 0, back at −thickness; `toModel` maps a
// board point (Y down) to model XY.  FaceComposer and the model store need a page (canvas, worker).
export { partTriangles, slabGeometries, type PartTriangles } from "../viewer3d/scene";
export { FaceComposer, textureExtent, type FaceLayers, type Side, type TextureExtent } from "../viewer3d/textures";
export { modelStore, type ModelRef, type ModelStore } from "../viewer3d/models";
export { layerColor } from "../viewer3d/colors";
