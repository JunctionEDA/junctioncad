// api.ts — what other domains may import from the mechanical domain.  Anything not exported here is internal
// and may change without notice (server/web/README.md: a domain never imports another domain's internals).
//
// An assembly uses these to read a part studio and show its bodies: open the document with ItemDocSession
// (web/shared/itemdoc/sync.ts, expectKind PART_STUDIO_KIND), turn it into worker input with `studioInputs`
// (never by hand: it applies the variables and takes the filters that supply what is not in the document, as
// BoardFeed supplies a Board feature's board), regenerate with a KernelClient, and draw each BodyResult's mesh.
export { PART_STUDIO_EXT, PART_STUDIO_KIND, featureInputs, featuresOf, rollbackIndex, studioOf, type FeatureItem, type StudioItem } from "./document/format";
export { studioInputs, type InputFilter, type StudioInput, type StudioInputOptions } from "./document/inputs";
export { BoardFeed, BOARD_FEATURE_TYPE, type BoardFeedOptions } from "./board/feed";
// a board as it looks, for another 3D editor that places one (an assembly): board/README.md
export { BoardDisplay } from "./board/display";
export type { BoardDelta, BoardReader } from "./board/model";
export { KernelClient, type KernelOptions, type KernelState } from "./kernel/client";
export type { BodyMesh, BodyResult, FeatureInput, FeatureReport, FeatureStatus, RegenResult, SketchView } from "./kernel/protocol";
export { DEFAULT_PLANES, add, cross, dot, isGeomRef, length, normalize, scale, sub, toPlane, toWorld, type DefaultPlaneId, type Frame, type GeomKind, type GeomRef, type PlaneRef, type Vec2, type Vec3 } from "./core/geometry";
export type { ParamField } from "./core/feature";
export { densities, materialOf, materialsOf, type Material } from "./document/mass-materials";
// the board link (boardlink/): the link item a part studio drives a board with, as the board editor reads it
export * from "./boardlink/api";
// Live presence for another domain's 3D editor (who is here, pointers, views, Follow): collab/attach.tsx.
export { mountViewportCollab, type ViewportCollabOptions } from "./collab/attach";
export type { Collab, CollabHost, CollabState, LocalPresence } from "./collab/collab";
export type { CadPresence, Collaborator, SelRef } from "./collab/presence";
