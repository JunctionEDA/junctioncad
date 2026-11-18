// index.ts — the worker side of the mechanical domain in one import: the kernel helpers, the regeneration
// engine and the generated lists of features and services.  The worker (worker.ts) and the node tests
// (static/tests/mechanical-kernel.test.js) both start here.
export { Kernel, ShapeIndex, type History, type Keep, type NamedResult } from "./occ";
export { RegenEngine, buildTopo, frameOf, resolveRef, resultBuffers, sketchView } from "./regen";
export { DEFAULT_QUALITY, qualityFor, tessellate, type MeshQuality } from "./tessellate";
export { FeatureError } from "./types";
export type * from "./types";
export type * from "./protocol";
export { FEATURES, SERVICES } from "../generated/worker";
