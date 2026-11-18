// The board the hero's small editor works on: an STM32F042 USB-C devboard, designed by the two
// harness scripts in scripts/landing-hero/design and checked by KiCad (hero/stm32.kicad_pcb), with
// what scripts/landing-hero/meta.mjs worked out about it (hero/stm32.json): the parts and where
// each waits in the pile, the copper as connections in an order they can be routed in, the ground
// pours with their stitching vias, and the silkscreen texts.

import PCB_TEXT from "./hero/stm32.kicad_pcb";
import SCH_TEXT from "./hero/stm32.kicad_sch";
import META from "./hero/stm32.json";
import { K, Pt, boardTextOf, openOf } from "./demo";

/** One run of track on one layer, from a pad or from copper laid before it (`needs`), ending in
 *  `via` when it changes layer there.  `loose` ones neither need nor carry another. */
export interface Route { net: string; layer: string; ids: string[]; pts: Pt[]; w: number; via: string | null; needs: number[]; loose: boolean }
/** `pile` is where the part lies at the start; `stage` is its spot in its group's cluster, where it is sorted to before it goes on the board. */
export interface Part { ref: string; value: string; id: string; x: number; y: number; rot: number; pile: Pt; group: number; stage: Pt }
export const meta = META as unknown as {
  board: { x: number; y: number; w: number; h: number; r: number }; pileBottom: number; stageBottom: number; left: number; groups: { name: string; box: [number, number, number, number] }[];
  /** Parts that sit together on the board: sorted into a cluster `off` away from their places, wired there, then moved on together. */
  units: { group: number; off: Pt; parts: string[] }[];
  parts: Part[]; routes: Route[]; zones: string[]; stitch: string[]; texts: { id: string; text: string }[];
  ground: number; pads: number; nets: number;
};
export const BOARD = meta.board;
export const loadPcb = (): KDoc => K.parseDoc(PCB_TEXT);
export const loadPcbOpen = (): KDoc => openOf(PCB_TEXT);
export const boardText = (doc: KDoc): string => boardTextOf(PCB_TEXT, doc);

/** The schematic the board was made from, for the hero's schematic tab (hero-sch.ts). */
export const schText: string = SCH_TEXT;
