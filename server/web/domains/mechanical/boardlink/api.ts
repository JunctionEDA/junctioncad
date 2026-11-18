// api.ts — what the board editor (web/domains/pcb/mech) may import of the board link: the link item's format,
// the coordinate transform, the ids of driven items and the jump hint.  Re-exported by mechanical/api.ts.
// Pure: nothing here touches the DOM, three.js, React or the kernel.
export {
  BOARD_LINK_TYPE, DRIVE_TITLES, drivesOf, keepoutLimit, linksOf, placementOf, readLink, removeDrive, removeLink,
  type BoardLinkItem, type Curve, type Drive, type DriveKind, type DriveSource, type Solved, type SolvedDrive, type SolvedHoles, type SolvedKeepout, type SolvedOutline,
} from "./format";
export { NM_PER_MM, boardToModel, directionToBoard3D, mmToNm, modelToBoard, modelToBoard3D, nmToMm, type BoardPoint, type Placement } from "./transform";
export { DRIVEN_PREFIX, drivenId, isDrivenId } from "./ids";
export { leaveHint, takeHint, type FocusHint } from "./hint";
