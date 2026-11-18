// Autorouter — the run: what to connect, in which order, with rip-up and retry, and the tracks and vias that
// come out.  Pure: reads a parsed board and the design rules, returns item nodes; nothing is written to the board
// here (the caller commits them as ordinary edits).
import { bboxOf, buildClass, domainGap, DX, DY, fillPoly, Grid, growFor, growVia, Obstacle, pickGrid, pointGap, Pt, RuleClass, Shape, stamp, stampClass, viaFits } from "./grid";
import { minCut } from "./ripcut";
import { costOf, dirOf, Features, featuresOf, Node, probe, ProbeResult, Terminal, Win, work } from "./probe";

/** Search steps an ordinary machine takes per millisecond of routing: turns the time allowed into a work budget. */
const STEPS_PER_MS = 12000;
/** What a millimetre of signal track with nothing beside it costs, in millimetres of length: tracks bundle. */
const BUNDLE_COST = 0.3;
import { TRAINED, Weights } from "./weights";
import { cornerAngle, SQUARE_MAX } from "./corners";
import { fanout, padRows, type Boxed, type Escape, type FanJob, type FanRow } from "./fanout";
import { plan as globalPlan, type Corridor, type PlanConn, type PlanResult } from "./globalplan";
import { CLUSTER_BOX_MM, CLUSTER_MAX, emptyLadder, FEEDBACK_MAX_CONNS, Ladder, type LadderReport, type RescueRung } from "./ladder";
import { stackupOf, traceOn, usualImpedance, RF_CONTROL, widthFor, z0, zdiff } from "./impedance";
/** Hole clearance is kept with this much to spare: a diagonal track on the grid can come a few microns closer to a
 *  via's hole than its grown cell says (Cyberboard: 0.2419 mm against a 0.25 mm rule). */
export const HOLE_SLACK = 0.012;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A supply net by its name: ground, a rail voltage, or one of the usual rail names. */
/** A signal laid without a via may be this much longer than the straight line between its pads (times, plus mm) before a layer change is tried instead. */
const FLAT_DETOUR = 1.6, FLAT_SLACK_MM = 5;
// What a mm of track on an inner plane layer counts against one on an outer layer: a little more, so a route that could
// take the back or an inner layer takes the back (the probe otherwise tries the layers in stack order and an inner one wins a tie).
const PLANE_COST = 1;   // 1.3 and 3 tried 2026-11-17: Ember +1.3, Cyberboard +0.2, but Ledify -10 (two more opens), so off
// An inner layer that pours cover this much of is a plane: it takes no tracks, only the vias of its own nets.  A pad of
// a plane's net under it counts as this far from the plane (a stub and a via), so it drops in rather than run to a
// far pad of the net.
const PLANE_COVER = 0.5, PLANE_HOP_MM = 1.5;
const FAN_ROWS_MM = [0.8, 1.5, 2.2], FAN_FAR_MM = 4;
// Fine-pitch escapes (fanout.ts), the way Copper's engine runs its fan-out: the board is routed first without
// any, and only the fine-pitch rows (Copper's needs_fanout) where that leaves a pin's connection open are escaped and
// the board routed again; the second result is kept only when it is strictly better (fewer open connections, then
// fewer vias, then shorter), as Copper keeps a second opinion.  A board that routes cleanly without escapes comes
// out identical.  On by default: measured 2026-11-18 with board-bench.py (score, open connections, vias, seconds),
// off -> on: Ledify 97.5 / 0 / 224 / 491 s -> the same board (its one boxed row came out worse, 1 -> 2 open, and was
// not kept) / 898 s; Cyberboard 75.0 / 11 / 130 / 486 s -> 75.0 / 9 / 133 / 860 s; Ember 75.0 / 11 / 478 / 2126 s ->
// 75.0 / 11 / 478 / 3700 s.  The second run costs the time (+75 to 85 %).  Before, with every fine-pitch row escaped
// up front and the spreading fan, Ledify fell 94.9 -> 74.0 (0 -> 5 open).
const ESCAPES: Escapes = true, SPREAD = 0;   // the spreading fan (ours, not Copper's) is off unless a run asks: { spread: 1.5 }
export type Escapes = boolean | number | { depth?: number; spread?: number };
// Global planning before routing (globalplan.ts, after Copper): coarse paths on a tile graph with negotiated
// congestion and layers assigned along them.  The connections the negotiation fought over are laid first in their
// tier and taken up first when a route is blocked, and only those it moved off their direct path are steered by their
// corridor.  Off unless a run asks.  Measured with board-bench.py (score, open connections):
// 2026-11-17, 2.5 mm tiles with capacity from one map column, every connection steered (off: Ledify 94.9 with 0 open,
// Cyberboard 75.0 with 12 open):
//   corridor as a mask, searched first:           Ledify 69.4 (8 open)  Cyberboard 75.0 (10 open)
//   the same, pour nets and one-layer tries left alone:  78.2 (4 open)             75.0 (11 open)
//   corridor and layer as a cost (0.5 per mm):          90.0 (2 open)             75.0 (10 open)
// 2026-11-18, Copper's capacities (free gaps on both sides of each border, gaps across tile corners joined, own pads'
// borders free) on 0.5 mm tiles (both boards have 0.5 mm pitch parts; the plan takes 2.6 s on Ledify, 5 s on
// Cyberboard), corridor as a cost (off: Ledify 97.5 with 0 open, Cyberboard 75.0 with 11 open):
//   all three (order, rip, steer the moved ones):       Ledify 79.8 (4 open)  Cyberboard 75.0 (13 open)
//   steer the moved ones only (order: false, rip: false):      92.5 (2 open)             75.0 (12 open)
//   order and rip, no steering (steer: "none"):                87.5 (3 open)
//   order only (steer: "none", rip: false):                    72.5 (8 open)
//   rip only (steer: "none", order: false):                    77.5 (5 open)
//   rip and steer (order: false):                              77.5 (5 open)
// Laying the fought-over connections first undoes the shortest-first order the rest of the router is tuned to (the
// first round overflows by 98 mm on Ledify and 207 mm on Cyberboard, so many are), and the extra rip-ups cost
// connections too; steering
// only the moved ones is the least harm but still worse than no plan.  So it stays off.
const PLAN: Plan = false;
// What the plan does besides: a route it had to fight for costs this much of its usual rip price (ripPrice, used by
// ripup "mincut") and may be taken up this many times more than the others in a pass
const PLAN_RIP = 0.5, PLAN_RIPS = 1;
/** tile: tile size in mm (default: 0.5 mm when the finest pad pitch is 0.5 mm or less, else 1 mm, doubled until the
 *  graph has 60 000 nodes or fewer, as in Copper); iters: negotiation rounds (16); layerCost: what a mm off the planned
 *  layer costs, in mm of track (0.5); outside: what a mm outside the corridor costs (0.5); mask: search inside the
 *  corridor only first, the whole board only when that finds nothing (default false: the corridor is a cost, not a
 *  wall); vias: a connection the plan routes through a via may change layer at once instead of being tried on one
 *  layer first (default false); open: with mask, mm round each end the corridor never closes (1); steer: which
 *  connections the corridor steers ("moved": those the negotiation moved off their direct path, the default; "all";
 *  "none"); order: false keeps the usual order instead of laying the fought-over connections first in their tier;
 *  rip: false takes routes up as without a plan instead of the fought-over ones first. */
export type Plan = boolean | { tile?: number; iters?: number; layerCost?: number; outside?: number; mask?: boolean; vias?: boolean; open?: number; steer?: "moved" | "all" | "none"; order?: boolean; rip?: boolean };
/** How far (mm, pad to pad on a shared net) a small part may stand from a chip and still count as part of its cluster. */
const GROUP_REACH = 5;
/** A via costs this many times what the reference boards' routing says it does (4.66 mm of track): people asked for
 *  fewer vias than those boards use, but at four times a signal ran 80 mm round the board to save two. */
const VIA_PRICE = 2.5;
// rip-up by minimum cut (ripcut.ts, after Copper's repair.py): a route's base price in mm, what a cut that did not pay
// adds to each of its routes, how many cuts are tried per connection, and how deep a route taken up may take up its own
const CUT_RIP_MM = 4, CUT_HISTORY_MM = 0.3, CUT_TRIES = 3, CUT_DEPTH = 2;
// With "mincut" the cut is tried first and the old rule after it (CUT_ORDER).  Measured 2026-11-17 with board-bench.py
// (score, open connections at the end of board.design(); "near": Ledify 94.9 with 0 open, Cyberboard 75.0 with 12):
//   cut first, then the old rule:             Ledify 94.5 (1 open)   Cyberboard 75.0 (10 open)
//   the old rule first, then the cut:                93.7 (1 open)               75.0 (10 open)
// Inside route() the cut leaves no more open than the old rule on Ledify (1 either way, a different one); the board
// loses its point in the steps of design() after it.  So "near" stays the default.
// "ladder" (ladder.ts, Copper's repair ladder), measured 2026-11-18 with board-bench.py on 8c3015fe (score, open
// connections, signal vias; defaults: Ledify 78.9 with 4 open and 34 vias, Cyberboard 75.0 with 11 open and 42 vias):
//   ladder:                Ledify 77.6 (4 open, 44 vias)   Cyberboard 74.2 (8 open, 37 vias)
//   ladder with plan:             90.0 (2 open, 38 vias)              74.8 (6 open, 45 vias)
//   mincut with plan:             79.8 (4 open, 40 vias)              75.0 (8 open, 48 vias)
// The ladder leaves fewer open everywhere, but alone it costs Ledify a little score, and with the plan Cyberboard
// a hair; so the default stays "near" (and the plan off) until a board says otherwise.
const RIPUP: "near" | "mincut" | "ladder" = "near";
const CUT_ORDER = "cut-first" as "near-first" | "cut-first" | "cut-only";
// the repair ladder (ripup "ladder", ladder.ts): half Copper's cluster box, and the most cells (all layers share them)
// the half-pitch rescue rasterises round a connection
const CLUSTER_HALF = CLUSTER_BOX_MM / 2, FINE_CELLS = 2.5e6;
/** Nets a person routes before anything else: RF feeds, crystal lines and USB data. */
export const isCritical = (net: string, kind: NetKind): boolean => kind === "rf" || usualImpedance(net, true) === 90
  || /(^|[\/_\-.(])(XTAL|XIN|XOUT|XI|XO|XC\d?|XL\d?|OSC(_?32K?)?_?(IN|OUT|I|O)|OSCI|OSCO|XTAL_?[PN]|X(32K?)_?[PN])\d*([_\-.)]|$)/i.test(net);
export const isSupply = (net: string): boolean => /^\/?(.*\/)?(A|D|P)?(GND|VSS|VEE)\w*$|^\/?(.*\/)?[+-]?\d+(V\d*|\.\d+V)\w*$|^\/?(.*\/)?(VCC|VDD|VBUS|VBAT|VIN|VSYS|VPP|VAA|VREF|VOUT|V\d+V\d*|PWR|\+BATT|-BATT)\w*$/i.test(net) && !/(_|\b)(EN|SENSE|SNS|FB|PG|OK|DET|MON|ADC)\w*$/i.test(net);
/** What a net carries, as far as its neighbours are concerned. */
export type NetKind = "analog" | "rf" | "switching" | "fast" | "digital" | "supply";
/** A net's kind from its name.  Analog: ADC and DAC inputs, references, audio, sense and feedback lines, crystals.
 *  RF: antenna and RF feeds.  Switching: a converter's switch node, bootstrap and gate drives.  Fast: clocks and
 *  differential pairs.  Supply: rails and ground.  Everything else is digital, and so is a general-purpose pin
 *  (GPIO26_ADC0), whatever its second function.  A net KiCad named after a pin
 *  (Net-(U3-SW)) is judged by the pin's name. */
export function netKind(net: string, paired = /(\+|-|_P|_N)\)?$/.test(net)): NetKind {
  if (isSupply(net)) return "supply";
  const m = /^Net-\((.+)-([^-]+)\)$/.exec(net); const n = m ? m[2] : net.replace(/^.*\//, ""); const auto = !!m;
  if (auto && /^(Pad)?\d+$/i.test(n)) return "digital";
  if (/^(GPIO|GP|IO|P[A-Z]?)_?\d+([_.\-]|$)/i.test(n)) return "digital";   // a general-purpose pin broken out, whatever else it can do
  if (usualImpedance(net, false) || (/^(ANT\d*|RF\w*|ANTENNA)$/i.test(n) && !RF_CONTROL.test(n)) || (m && /^(AE|ANT)\d+$/i.test(m[1]))) return "rf";
  if (/(^|[_\-.])(SW|LX|PHASE|PH|BST|SWN|GATE|HG|LG|HDRV|LDRV|UGATE|LGATE)\d*([_\-.]|$)/i.test(n) && !/SW(D|O|CLK|DIO)/i.test(n) && (auto || !/^SW\d+$/i.test(n))) return "switching";
  if (auto && /^(BOOT|CB|BS)$/i.test(n)) return "switching";
  if (/(^|[_\-.])(AIN|ADC|DAC|VREF|AREF|REF|MIC|AUDIO|AUD|LINE_?IN|LINE_?OUT|HP_?[LR]|SENSE|SNS|ISENSE|ISNS|VSENSE|THERM|NTC|XTAL|XIN|XOUT|XI|XO|XC|XL|OSC_?IN|OSC_?OUT|OSCI|OSCO|COMP|FB|VFB|ANALOG|ANA)[A-Z]?\d*([_\-.+]|$)/i.test(n)) return "analog";
  if ((paired && pairName(net)) || /(CLK|SCK|LRCK|CLOCK)\d*(_\w+)?$/i.test(n) || /(^|[_\-.])CK\d*$/i.test(n)) return "fast";
  return "digital";
}
/** Which nets were kept apart, and where that had to give. */
export interface DomainReport { kinds: Record<string, NetKind>; quiet: number; noisy: number; relaxed: string[] }
/** Ground vias set beside a net's tracks (a fence) and beside its layer changes (return vias). */
export interface FenceReport { net: string; ground: string; fence: number; returns: number; spacing: number; note?: string }
/** The rim of the board: how far in from the edge it reaches, how much of a route may lie in it for nothing (the
 *  approach to an edge connector's pad), and what each further mm costs, in mm of ordinary track. */
const RIM_MM = 1.3, RIM_FREE_MM = 4, RIM_COST = 3;

export interface RouteOptions {
  /** true lets tracks run along the board edge at no extra cost (by default a long run in the rim is priced up). */
  edgeRuns?: boolean;
  /** Ground vias for high-frequency nets.  A fence: vias down both sides of every track of an RF net (and of the
   *  nets named in `nets`), `spacing` mm apart (default 2 mm, about a twentieth of a wavelength at 2.4 GHz on FR4),
   *  wherever the ground pour lies on two layers and the rules leave room.  Return vias: one ground via beside each
   *  layer change of an RF, clock or pair net, so the return current changes layer with the signal.  false turns
   *  both off.  Reported in `result.fences`. */
  fence?: boolean | { spacing?: number; nets?: string[]; returnVias?: boolean };
  /** Keep sensitive nets (analog, RF) away from the rest: `quiet` mm from ordinary digital tracks and `noisy` mm
   *  from switching nodes, clocks and pairs (defaults: twice and three times the board clearance, at least 0.3 and
   *  0.5 mm).  Pads are exempt, and so is the copper within `nearPads` mm of any pad (default 1.2): parts sit where
   *  they sit, and a fine-pitch fan-out has no room to give.  false turns it off.  A connection that cannot be made
   *  with the gap is made without it and named in `result.domains.relaxed`. */
  separate?: boolean | { quiet?: number; noisy?: number; nearPads?: number };
  nets?: string[] | null;        // only these nets (names); default every net with a missing connection
  layers?: string[] | null;      // copper layers tracks may use; default the signal layers
  allowVias?: boolean;           // default true
  ripUp?: boolean;               // default true
  /** What the repair after the passes takes up to lay a connection left open.  "near": every route the cheapest way
   *  through runs into (and so on, a few levels deep).  "mincut": the cheapest set of routes whose removal opens a
   *  way, each priced by what laying it again costs (ripcut.ts, after Copper); only those come up, are laid again,
   *  and the result is kept only when fewer connections are open; where no cut pays, the "near" rule is tried after
   *  it.  "ladder": Copper's repair ladder (ladder.ts), one rung at a time over every open connection: rescue (laid
   *  alone with one extra via and without the plan's steering, then on a lattice of half the pitch, then at the
   *  board's minimum width, then from the other side of its escape), the min-cut rip (as "mincut"), permutation of
   *  the cluster fighting for its channel, and, with a plan, feedback into the plan; each rung kept only when fewer
   *  connections are open and none laid before is open now.  Counts in `result.ladder`.  Default "near" (see RIPUP
   *  for what the benchmark boards said). */
  ripup?: "near" | "mincut" | "ladder";
  passes?: number;               // whole-board attempts with a different order; default 3
  pitch?: number;                // force the grid pitch, mm
  weights?: Partial<Weights>;
  signalWidth?: number;          // the width plain signals are widened to after routing wherever the clearances allow (default 0.2 mm; 0 keeps the class width)
  powerWidth?: number;           // track width for supply nets (GND, +3V3, VBUS …) that have no class of their own; 0 keeps the class width.  Default: twice the class width, 0.3 to 0.5 mm
  impedance?: boolean;           // size tracks for the impedance their nets call for (a plan's impedance, else by name: USB 90 Ω, HDMI/Ethernet 100 Ω, antenna feeds 50 Ω); default true
  splitPairs?: boolean;          // route a differential pair's two lines separately when no coupled run fits (default false: they stay unrouted and the report says why)
  fanoutVias?: boolean;          // true: a longer lane with room for a via at fine-pitch pins whose net goes far
  plan?: Plan;                    // plan every connection on a coarse tile graph first (negotiated congestion, layers per tile), lay the connections it fought over first, take them up first, and steer the ones it moved off their direct path by their corridor (globalplan.ts); see Plan
  escapes?: Escapes;              // escapes for fine-pitch chip rows that a plain route leaves boxed in: route once without, then again with a stub (a ring, a leg or a via) out of each pin of those rows, routed from its end (fanout.ts), keeping the better result (see routeRuns); a number sets how far past the pad the first ring lies (mm), { depth, spread } both (spread > 1: our spreading fan first, off by default)
  escapeRows?: string[];          // internal (routeRuns): escape only these rows (Router.fineRows keys) and route once
  fanoutLanes?: boolean | number; // keep a lane (mm, default 0.25) out from each fine-pitch chip pin for its own net only; false turns it off
  matchLengths?: boolean;        // lengthen the shorter members of a matched group with serpentines; default true
  match?: { nets: string[]; tolerance?: number; length?: number }[];   // nets to bring to one length (the longest, or the length given), within the tolerance in mm (default 0.25)
  skewTolerance?: number;        // the most the two tracks of a pair may differ in length, mm; default 0.1
  maxAmplitude?: number;         // how far a serpentine may swing off its track, mm; default 3
  pairs?: boolean;               // route differential pairs (D+/D-, _P/_N, DP/DM …) side by side at a constant gap; default true
  pairGap?: number;              // the gap between a pair's tracks in mm; default the nets' clearance
  fewerVias?: boolean;
  /** the most vias any one connection (pad to pad) may use; a connection that cannot be made within it is left open and reported */
  maxViasPerConnection?: number;
  /** Width in mm of the ground band kept free of other nets round an antenna's clear area (default 1.2; 0 turns it off). */
  antennaBand?: number;
  /** false keeps every via at its net class's size.  By default a connection that cannot be made with it may use
   *  the smallest via Board Setup's constraints permit. */
  smallVias?: boolean;           // after routing, lay each route that changes layer again without (or with fewer) vias where the finished board leaves room; default true
  bundle?: boolean;              // signals prefer to run beside what is already there (other tracks, pads) rather than out in the open; default true
  planarFirst?: boolean;         // lay each signal without a via first, pushing others aside; only what cannot be made on one layer changes layer; default true
  timeMs?: number;               // stop starting new connections after this long
  zones?: boolean;               // let a route end in the net's own copper zone; default true
  // ---- a plan from outside (the assistant's model, or a person): the engine still does the geometry and the rules
  groups?: Record<string, string[]>;   // clusters by name: the parts of each (a chip and what serves it); connections inside one cluster are laid before any between clusters.  Parts not named are grouped from the board
  groupsFirst?: boolean;         // false turns the cluster-first order off
  criticalFirst?: boolean;       // false: the inside of each cluster before the critical nets (the owner chose critical first, 2026-11-16)
  splitPlaneEnds?: boolean;      // true: no route ends where two nets' pours overlap on a layer
  planeShortcuts?: boolean;      // false: keep long supply tracks that could drop into the net's inner plane at both ends
  planeDrops?: boolean;          // true: a pad of a net with an inner plane counts as 1.5 mm from it, so it drops in rather than run to a far pad
  planeCost?: number;           // what a mm of track on an inner plane layer counts (default 1, like any layer; 3 matched the owner's layer split but cut the back pour: Ledify -11, Ember -0.8)
  planes?: boolean;              // true keeps tracks off an inner ground layer its pour covers, and drops ground pins straight into it
  order?: string[];              // net names to route first, in this order; the rest follow in the heuristic order
  netOpts?: Record<string, NetPlan>;
  keepouts?: { layers?: string[]; box: Box }[];   // areas no new track or via may enter, for this run only
  explain?: boolean;             // say why each failed connection failed (default true)
}
export type Box = [number, number, number, number];   // x0, y0, x1, y1 in mm
export interface NetPlan {
  layers?: string[];             // copper layers the net should run on
  width?: number;                // track width in mm (never below the board's minimum)
  impedance?: number;            // ohms: single-ended, or differential when the net is one of a pair
  allowVias?: boolean; maxVias?: number;
  avoid?: Box[];                 // areas this net stays out of
  viaAvoid?: Box[];              // areas where this net may run tracks but put no via (a supply joined on the top layer round a fine-pitch chip)
  priority?: number;             // higher routes earlier (after `order`)
  kind?: NetKind;                // what the net carries, when its name does not say (see netKind)
}
/** What became of one connection, in words a reviewer (a person or a model) can act on. */
export interface ConnReport {
  net: string; from: { x: number; y: number; pad?: string }; to: { x: number; y: number; pad?: string };
  routed: boolean; length: number; vias: number; bends: number; layers: string[]; detourRatio: number;
  reason?: "blocked" | "no-room" | "rule" | "budget"; detail?: string; blockedBy?: { nets: string[]; items: string[] };
}
export interface Anchor { p: Pt; layers: number[]; shape: Shape | null; cluster: number; grp?: number; plane?: boolean; narrow?: number; axis?: Pt }
export interface Conn {
  id: number; net: string; cls: RuleClass; a: Anchor; b: Anchor; len: number;
  nodes: Node[] | null; shapes: Obstacle[]; viaCells: number[]; landed: number; rips: number; feat: Features | null; stubs: [Pt, Pt, number][]; zoneEnd: boolean; ends?: [Anchor, Anchor]; stitch?: boolean; planeOnly?: number; moot?: boolean; pair?: boolean;
  why?: string; pairOnly?: string;   // a differential pair's connection whose coupled run could not be laid: it is never routed alone
  partner?: Conn;                    // the other line of a pair that cannot be one coupled run (its pads change layer): routed beside it
}
export interface RouteItem { kind: "segment" | "via"; node: any; net: any; netName: string; conn: number }
export interface RouteResult {
  items: RouteItem[]; total: number; routed: number; failed: { net: string; a: Pt; b: Pt }[];
  segments: number; vias: number; length: number; ms: number; passes: number; zoneEnds: number; zoneCovered: number; pairs?: PairReport[]; impedance?: ImpedanceReport[]; matched?: MatchReport[];
  grid: { pitch: number; w: number; h: number; layers: string[] }; nets: number;
  connections: ConnReport[]; domains?: DomainReport; fences?: FenceReport[];
  groups?: { clusters: number; inside: number; insideRouted: number; insideVias: number; critical: string[]; members: Record<string, string[]> };   // connections that lie inside one cluster, and how they came out
  fanout?: { escapes: number; ring: number; via: number; used: number; boxed: Boxed[]; rows?: number; kept?: boolean; open?: [number, number] };   // the escapes laid before routing, and the pins that got none; with routeRuns: the rows escaped, whether that run was kept, and the open connections without / with escapes
  ladder?: LadderReport;   // ripup "ladder": connections each rung laid (rescued, by rescue rung in rungs; mincut; permuted, and the orders tried; feedback), transactions tried and rolled back
  plan?: { tile: number; tiles: [number, number]; conns: number; iterations: number; overflowFirst: number; overflow: number; crossings: number; relayered: number; moved: number; contested: number; viaConns: number; ms: number; inside: number; outside: number };   // the global plan: overflow (mm) before and after negotiation, how many connections it moved off their direct path (only those are steered) and had to fight for (they go first), and how many steered searches found their route inside the corridor
}
export interface Progress { done: number; total: number; routed: number; pass: number; net: string }

export interface ImpedanceReport { nets: string[]; target: number; differential: boolean; layer: string; model: string; width: number | null; gap?: number; achieved?: number; applied: boolean; note?: string }
export interface MatchReport { group: string; target: number; tolerance: number; members: { nets: string[]; before: number; length: number; matched: boolean; note?: string }[] }
export interface PairReport { p: string; n: string; coupled: boolean; layer?: string; width?: number; gap?: number; lengthP?: number; lengthN?: number; skew?: number; reason?: string }
/** The two nets of a differential pair, by name: D+/D-, X_P/X_N, DP/DM, TXP/TXN. */
export function pairName(net: string): { base: string; pol: 1 | -1 } | null {
  const m = /^(.*?)(\+|-|_P|_N|DP|DM|P|N)(\)?)$/.exec(net); if (!m || !m[1] || isSupply(net) || /(^|[\/_(])V$/i.test(m[1])) return null;
  const t = m[2]; if ((t === "P" || t === "N") && !/[A-Z0-9]$/.test(m[1])) return null;
  return { base: m[1] + (t.length === 2 && t[0] === "D" ? "D" : "") + "~" + m[3], pol: t === "+" || t === "_P" || t === "DP" || t === "P" ? 1 : -1 };
}
interface Pair { p: NetInfo; n: NetInfo; cp: Conn; cn: Conn; swap: boolean; laid?: { c: Pt[]; l: number; w: number; d: number; clr: number; sgn: number; lead: Lead[] } }
interface Lead { e: Pt; s: number }   // each track first leaves its pad straight, this far, before it turns in to its partner
interface Guide { allowed: boolean[] | null; allowVias: boolean; maxVias: number; avoid: [number, number, number, number][]; viaAvoid: [number, number, number, number][]; rank: number; priority: number }
interface Found { res: ProbeResult; owner: Map<number, number>; flip: boolean; esc?: (Pt | undefined)[] }
interface NetInfo { key: string; obj: any; cls: RuleClass; conns: Conn[]; clusters: number; zoneCells: Node[] | null; zoneCluster: number; guide: Guide; anchors?: Anchor[]; drop?: (a: Anchor) => Anchor | null; pour?: { mask: (Uint8Array | null)[]; width: number; clr: number } }

const r6 = (v: number) => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };

export class Router {
  G!: Grid; rim: Uint8Array | null = null; nets: NetInfo[] = []; conns: Conn[] = []; pref: number[] = []; W: Weights; allowVias: boolean; s: any;
  tight = false;   // while a fine-pitch row is laid again in pin order: each track takes the lane next to the last
  stopped = false; zoneCovered = 0; dropped: any[] = []; stat: Record<string, number> = { noSoft: 0, noBlockers: 0, tooMany: 0, ripped: 0, ripLimit: 0 };
  constructor(public K: any, public P: any, public doc: any, settings: any, public opts: RouteOptions = {}) {
    // the weights were fitted to how people route; a via is then charged four times over, because a board with few layer
    // changes is what is asked for: a track goes round on its own layer for up to ~19 mm before it changes layer
    this.W = Object.assign({}, TRAINED, { via: TRAINED.via * VIA_PRICE }, opts.weights || {}); this.allowVias = opts.allowVias !== false;
    this.s = settings && settings.netclasses ? settings : P.designSettings(settings);
    this.build();
  }

  /** Everything on the board a new track must keep clear of: copper by net, unplated holes and the board edge. */
  collectObstacles(nl: any): Map<string, Obstacle[]> {
    const { K, P, doc, s } = this; const copper: string[] = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const L = copper.length; const all = copper.map((_, i) => i);
    const obstacles = new Map<string, Obstacle[]>(); const push = (o: Obstacle) => { let l = obstacles.get(o.net); if (!l) obstacles.set(o.net, l = []); l.push(o); };
    for (const c of nl.conductors) {
      if (c.kind === "zone") continue;
      const layers = Array.from(c.layers as Set<string>).map((l) => copper.indexOf(l)).filter((i) => i >= 0); if (!layers.length) continue;
      // a via's drilled hole needs the hole clearance from other nets' copper, which beats the copper clearance when the ring is thin
      const hole = c.kind === "via" && s.holeClearance && c.size && c.drill ? s.holeClearance + HOLE_SLACK - (c.size - c.drill) / 2 : 0;
      push({ net: c.net || "", layers, shape: c.shape, clr: Math.max(P.netClearance(s, c.net), hole), pad: c.kind === "pad", thru: L > 1 && layers.length === L && (c.kind === "pad" || c.kind === "via") ? [c.anchors[0][0], c.anchors[0][1]] : undefined });
    }
    for (const it of doc.items.values()) if (it.kind === "footprint") for (const p of P.padsOf(it)) if (p.type === "np_thru_hole") {
      const d = K.kid(p.node, "drill"); const nums: number[] = d ? d.slice(1).filter((v: any) => typeof v === "number") : [];
      const w = nums.length ? nums[0] : p.w, h = nums.length > 1 ? nums[1] : nums.length ? nums[0] : p.h;
      push({ net: "", layers: all, shape: P.padShape({ shape: w === h ? "circle" : "oval", x: p.x, y: p.y, w, h, rot: p.rot }), clr: Math.max(s.clearance, s.holeClearance !== undefined ? s.holeClearance : 0.25) });   // Board Setup > Constraints: hole clearance
    }
    for (const e of P.edgeShapes(doc).shapes) push({ net: "", layers: all, shape: e, clr: 0, edge: true });
    for (const o of this.escapeObs) push(o);   // the fan-out laid before routing stays copper of its net
    // Fan-out lanes.  Each pin of a fine-pitch chip (QFN, QFP, 0.5 mm pitch and finer) keeps a short straight lane
    // out from the end of its pad that only its own net may use: a neighbour's track may not jog across in front of
    // it, so every pin can still get out, as a person fans a chip out before routing anything else.
    if (this.opts.fanoutLanes !== false) {
      const lane = typeof this.opts.fanoutLanes === "number" ? this.opts.fanoutLanes : 0.25;
      const byPart = new Map<any, any[]>(); for (const c of nl.conductors) if (c.kind === "pad" && c.pad && c.pad.type === "smd" && c.item) { let l = byPart.get(c.item); if (!l) byPart.set(c.item, l = []); l.push(c); }
      // Fan-out with vias, the way a dense chip is escaped by hand: a pin whose net goes far keeps a longer lane with
      // room for a via at its end, in three staggered rows, so neighbours cannot box it in before it has changed layer.
      // A lane that would run into another net's pad stays the short one.
      // Off by default: reserved via spots that nothing lays yet only block (Cyberboard 122 -> 110 routed).
      const fan = this.opts.fanoutVias === true && copper.length > 1; const viaR = (s.viaDiameter || 0.5) / 2;
      const padsOf = new Map<string, Pt[]>(); const allPads: { x: number; y: number; r: number; net: string; item: any }[] = [];
      if (fan) for (const c of nl.conductors) if (c.kind === "pad" && c.pad) { allPads.push({ x: c.pad.x, y: c.pad.y, r: Math.max(c.pad.w, c.pad.h) / 2, net: c.net || "", item: c.item }); if (c.net) { let l = padsOf.get(c.net); if (!l) padsOf.set(c.net, l = []); l.push([c.pad.x, c.pad.y]); } }
      const zoned = new Set<string>(); if (fan) for (const it of doc.items.values()) if (it.kind === "zone") { const n = nl.table.key(P.netOf(it.node)); if (n) zoned.add(n); }
      for (const cs of byPart.values()) {
        let pitch = Infinity; if (fan && cs.length >= 8) for (let i = 1; i < cs.length; i++) pitch = Math.min(pitch, Math.hypot(cs[i].pad.x - cs[i - 1].pad.x, cs[i].pad.y - cs[i - 1].pad.y) || Infinity);
        if (cs.length < 8) continue; const cx = cs.reduce((a, c) => a + c.pad.x, 0) / cs.length, cy = cs.reduce((a, c) => a + c.pad.y, 0) / cs.length;
        for (const c of cs) {
          const p = c.pad; if (!c.net || Math.min(p.w, p.h) > 0.35 || Math.max(p.w, p.h) < 1.2 * Math.min(p.w, p.h)) continue;
          const ax = padAxis(p); const sg = ax[0] * (p.x - cx) + ax[1] * (p.y - cy) >= 0 ? 1 : -1; const half = Math.max(p.w, p.h) / 2;
          if (Math.hypot(p.x - cx, p.y - cy) < half) continue;   // a pin in the middle
          const layers = Array.from(c.layers as Set<string>).map((l) => copper.indexOf(l)).filter((i) => i >= 0); if (!layers.length) continue;
          const a: Pt = [p.x + sg * ax[0] * half, p.y + sg * ax[1] * half], b: Pt = [a[0] + sg * ax[0] * lane, a[1] + sg * ax[1] * lane];
          if (fan && pitch <= 0.65 && !isSupply(c.net) && !zoned.has(c.net) && (padsOf.get(c.net) || []).some((q) => Math.hypot(q[0] - p.x, q[1] - p.y) > FAN_FAR_MM)) {
            const k = Math.round((-(p.x - cx) * ax[1] + (p.y - cy) * ax[0]) / pitch); const depth = FAN_ROWS_MM[((k % 3) + 3) % 3];
            const e: Pt = [a[0] + sg * ax[0] * depth, a[1] + sg * ax[1] * depth]; const dx = e[0] - a[0], dy = e[1] - a[1], dd = dx * dx + dy * dy;
            const hit = allPads.some((q) => { if (q.net === c.net || q.item === c.item) return false; const t = Math.max(0, Math.min(1, ((q.x - a[0]) * dx + (q.y - a[1]) * dy) / dd)); const far = Math.hypot(q.x - e[0], q.y - e[1]); return Math.hypot(q.x - a[0] - t * dx, q.y - a[1] - t * dy) < q.r + 0.25 || far < q.r + viaR + 0.25; });
            if (!hit) { push({ net: c.net, layers, shape: { t: "seg", a, b: e, r: 0.05 } as Shape, clr: P.netClearance(s, c.net) }); push({ net: c.net, layers: all, shape: { t: "circle", x: e[0], y: e[1], r: viaR } as Shape, clr: P.netClearance(s, c.net) }); this.fanned++; continue; }
          }
          push({ net: c.net, layers, shape: { t: "seg", a, b, r: 0.05 } as Shape, clr: P.netClearance(s, c.net) });
        }
      }
    }
    return obstacles;
  }
  /** The board may have changed under a long run (other people edit it too): check the routes against it as it is now. */
  revalidate(): number {
    const before = this.conns.filter((c) => c.nodes).length; this.G.obstacles = this.collectObstacles(this.P.netlist(this.doc)); this.oidx = null; this.validate();
    if (this.fenceVias.length) { const g = this.fenceVias[0]; this.fenceVias = this.fenceVias.filter((v) => this.G.layers.every((_, l) => this.clearOf({ t: "circle", x: v.p[0], y: v.p[1], r: g.cls.viaD / 2 }, l, v.net, g.cls.clr))); }
    return before - this.conns.filter((c) => c.nodes).length;
  }

  // ------------------------------------------------------------------ board → grid
  build(): void {
    const { K, P, doc, s } = this; const copper: string[] = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const L = copper.length;
    const nl = P.netlist(doc); const all = copper.map((_, i) => i);
    const obstacles = this.collectObstacles(nl);
    const pads: number[][] = []; let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const hv = copper.map(() => [0, 0]); const smd: Shape[] = [], chip: Shape[] = [];
    // the pads of two and three pad parts (chip resistors and capacitors, small diodes and transistors): the ones a via can stand on end
    const chipPads = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "footprint") { const ps: any[] = P.padsOf(it); if (ps.length <= 3) for (const p of ps) chipPads.add(p.x.toFixed(3) + "," + p.y.toFixed(3)); }
    for (const c of nl.conductors) {
      if (c.kind === "zone") continue;
      const layers = Array.from(c.layers as Set<string>).map((l) => copper.indexOf(l)).filter((i) => i >= 0); if (!layers.length) continue;
      if (c.bbox[0] < bx0) bx0 = c.bbox[0]; if (c.bbox[1] < by0) by0 = c.bbox[1]; if (c.bbox[2] > bx1) bx1 = c.bbox[2]; if (c.bbox[3] > by1) by1 = c.bbox[3];
      if (c.kind === "pad") { const fine = c.pad.type === "smd" && Math.min(c.pad.w, c.pad.h) <= 0.35 ? 25 : 1; const ax = padAxis(c.pad); const along = Math.abs(ax[0]) > 0.7; pads.push([c.pad.x, c.pad.y, fine > 1 && along ? 0.2 : fine, fine > 1 && !along ? 0.2 : fine]); if (layers.length < L || L === 1) { smd.push(c.shape); if (chipPads.has(c.pad.x.toFixed(3) + "," + c.pad.y.toFixed(3))) chip.push(c.shape); } }
      if (c.kind === "segment") { const [a, b] = c.anchors; const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); if (dy < dx * 0.2) hv[layers[0]][0] += dx; else if (dx < dy * 0.2) hv[layers[0]][1] += dy; }
    }
    const outline: Pt[] | null = P.boardOutline(doc).outline;
    let bounds: [number, number, number, number];
    if (outline) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of outline) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } bounds = [x0, y0, x1, y1]; }
    else if (bx0 < bx1) bounds = [bx0 - 5, by0 - 5, bx1 + 5, by1 + 5]; else bounds = [0, 0, 10, 10];
    const pg = pickGrid(pads, bounds, L, this.opts.pitch);
    const W = Math.floor((bounds[2] - pg.ox) / pg.g) + 2, H = Math.floor((bounds[3] - pg.oy) / pg.g) + 2;
    const allow = this.opts.layers && this.opts.layers.length ? this.opts.layers : null;
    const routable = copper.map((name) => allow ? allow.includes(name) : (doc.layers.get(name) || { type: "signal" }).type !== "power");
    if (!routable.some(Boolean)) routable.fill(true);
    const rmin = s.clearance + s.trackWidth / 2;
    const G: Grid = this.G = { g: pg.g, ox: pg.ox, oy: pg.oy, W, H, layers: copper, routable, noVia: new Uint16Array(W * H), thru: new Uint8Array(W * H), outside: null, keep: copper.map(() => null),
      edgeClr: Math.max(s.edgeClearance || 0, 0), holeClr: Math.max(s.holeClearance || 0, 0), margin: pg.g * pg.g / (4 * Math.max(rmin, 0.05)) + 0.002, obstacles, classes: new Map(), weights: this.W };
    if (outline) { const out = G.outside = new Uint8Array(W * H).fill(1); fillPoly(G, outline, (x0, x1, iy) => out.fill(0, iy * W + x0, iy * W + x1 + 1)); }
    // The rim: cells within a header pitch of the board edge.  A track may reach a pad there, but a long run along
    // the edge (out past a pin row and down the side of the board) is priced so that a way through the board wins.
    { const r = Math.max(1, Math.round(RIM_MM / pg.g)); const out = G.outside; const rim = this.rim = new Uint8Array(W * H);
      const off = (ix: number, iy: number) => ix < 0 || iy < 0 || ix >= W || iy >= H || (out ? out[iy * W + ix] === 1 : false);
      let front: number[] = []; for (let iy = 0; iy < H; iy++) for (let ix = 0; ix < W; ix++) { if (off(ix, iy)) continue; if (off(ix - 1, iy) || off(ix + 1, iy) || off(ix, iy - 1) || off(ix, iy + 1)) { rim[iy * W + ix] = 1; front.push(iy * W + ix); } }
      for (let d = 1; d < r && front.length; d++) { const next: number[] = []; for (const i of front) { const ix = i % W, iy = (i - ix) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = ix + dx, y = iy + dy; if (off(x, y)) continue; const j = y * W + x; if (!rim[j]) { rim[j] = 1; next.push(j); } } } front = next; } }
    for (const sh of smd) stamp(G, G.noVia, sh, 0, 1);
    // no via in or against a small part's solder pad: the hole drains the solder and stands the part on end (a centre
    // just outside the pad's corner still puts the hole in it), so via centres keep a drill radius off those pads
    for (const sh of chip) stamp(G, G.noVia, sh, 0.15, 1);
    // rule areas
    const zoneLayers = (n: any): number[] => { const l = K.kid(n, "layer"), ls = K.kid(n, "layers"); const names: string[] = l ? [K.str(l[1])] : ls ? ls.slice(1).map(K.str) : []; const out = new Set<number>(); for (const nm of names) { if (nm === "*.Cu" || nm === "F&B.Cu") all.forEach((i) => out.add(i)); else { const i = copper.indexOf(nm); if (i >= 0) out.add(i); } } return Array.from(out); };
    // A zone's outline may carry holes as further polygons: inside means inside an odd number of them.
    const zones: { net: string; layers: number[]; polys: Pt[][]; clr: number; minW: number }[] = [];
    const cellsIn = (polys: Pt[][]): Uint8Array => { const t = new Uint8Array(W * H); for (const pts of polys) fillPoly(G, pts, (x0, x1, iy) => { for (let i = iy * W + x0; i <= iy * W + x1; i++) t[i] ^= 1; }); return t; };
    const ncs = Object.values(s.netclasses || {}) as { track_width?: number; via_diameter?: number }[];
    const maxTrack = Math.max(s.trackWidth || 0, ...ncs.map((c) => c.track_width || 0)), maxVia = Math.max(s.viaDiameter || 0, ...ncs.map((c) => c.via_diameter || 0));
    const band = (polys: Pt[][], inside: Uint8Array, r: number): Uint8Array => {
      const t = inside.slice(); if (!(r > 0)) return t;
      for (const pts of polys) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        const ix0 = Math.max(0, Math.floor((x0 - r - G.ox) / G.g)), ix1 = Math.min(W - 1, Math.ceil((x1 + r - G.ox) / G.g)), iy0 = Math.max(0, Math.floor((y0 - r - G.oy) / G.g)), iy1 = Math.min(H - 1, Math.ceil((y1 + r - G.oy) / G.g));
        for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
          const i = iy * W + ix; if (t[i]) continue; const x = G.ox + ix * G.g, y = G.oy + iy * G.g;
          for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
            const a = pts[j], b = pts[k], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const u = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
            if (Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy) < r - 1e-6) { t[i] = 1; break; }
          }
        }
      }
      return t;
    };
    for (const it of doc.items.values()) {
      if (it.kind !== "zone") continue; const n = it.node; const polys: Pt[][] = K.kids(n, "polygon").map((poly: any) => K.ptsOf(poly) as Pt[]).filter((pts: Pt[]) => pts.length >= 3); if (!polys.length) continue;
      const ko = K.kid(n, "keepout"); const layers = zoneLayers(n);
      if (ko) {
        const no = (k: string) => { const c = K.kid(ko, k); return !!c && K.str(c[1]) === "not_allowed"; };
        if (no("copperpour")) { const t = cellsIn(polys); const m = G.noPour || (G.noPour = new Uint8Array(W * H)); for (let i = 0; i < t.length; i++) if (t[i]) m[i] = 1; }
        if (!no("tracks") && !no("vias")) continue; const t = cellsIn(polys);
        // a track or via whose centre sits on the area's edge still reaches into it by its half width (the DRC's
        // DRC_TEST_PROVIDER_DISALLOW): the band within the widest half width of the edge is kept out too
        const tt = band(polys, t, maxTrack / 2), tv = band(polys, t, maxVia / 2);
        if (no("tracks")) for (const l of layers) { const m = G.keep[l] || (G.keep[l] = new Uint8Array(W * H)); for (let i = 0; i < tt.length; i++) if (tt[i]) m[i] = 1; }
        if (no("vias")) for (let i = 0; i < tv.length; i++) if (tv[i]) G.noVia[i]++;
      } else if (layers.length) { const cp = K.kid(n, "connect_pads"), cc = cp && K.kid(cp, "clearance"), mt = K.kid(n, "min_thickness"); zones.push({ net: nl.table.key(P.netOf(n)), layers, polys, clr: cc ? K.num(cc[1], 0) : 0, minW: mt ? K.num(mt[1], 0.25) : 0.25 }); }
    }
    for (const ko of this.opts.keepouts || []) {
      const b = this.cellBox(ko.box); if (!b) continue; const ls = ko.layers && ko.layers.length ? ko.layers.map((nm) => copper.indexOf(nm)).filter((i) => i >= 0) : all;
      for (const l of ls) { const m = G.keep[l] || (G.keep[l] = new Uint8Array(W * H)); for (let iy = b[1]; iy <= b[3]; iy++) m.fill(1, iy * W + b[0], iy * W + b[2] + 1); }
      for (let iy = b[1]; iy <= b[3]; iy++) for (let ix = b[0]; ix <= b[2]; ix++) G.noVia[iy * W + ix]++;
    }
    // Under a crystal nothing runs but the crystal's own nets (and ground): its two nodes are the most sensitive on a
    // digital board.  The area is the part's courtyard, on every layer.
    for (const it of doc.items.values()) {
      if (it.kind !== "footprint") continue; const ref = refOf(K, it.node) || ""; const pads: any[] = P.padsOf(it);
      if (!(/^(Y|XTAL)\d/i.test(ref) || /crystal|xtal|resonator/i.test(String(it.lib || "") + " " + String(it.value || ""))) || pads.length < 2 || pads.length > 6) continue;
      const nets = pads.map((p) => nl.table.key(p.net) || ""); if (nets.some((n) => /^\/?(\+|VCC|VDD|VBUS|VBAT|VIN)|\dV\d?$/i.test(n))) continue;      // an oscillator module is not a bare crystal
      let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
      try { const cy = P.courtyards({ node: it.node }); for (const key of Object.keys(cy)) for (const loop of cy[key]) for (const q of loop) b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])]; } catch { /* no courtyard */ }
      if (b[0] > b[2]) for (const p of pads) b = [Math.min(b[0], p.x - 0.6), Math.min(b[1], p.y - 0.6), Math.max(b[2], p.x + 0.6), Math.max(b[3], p.y + 0.6)];
      b = [b[0] - 0.1, b[1] - 0.1, b[2] + 0.1, b[3] + 0.1];      // a track must not even touch the area
      const cb = this.cellBox(b); if (!cb) continue; const q = G.quiet || (G.quiet = new Uint8Array(W * H));
      for (let iy = cb[1]; iy <= cb[3]; iy++) q.fill(1, iy * W + cb[0], iy * W + cb[2] + 1);
      for (const n of nets) if (n) this.xtalNets.add(n);
    }
    // An antenna's clear area takes nothing but the antenna's own feed: the keep-out round it lets tracks in so that
    // the feed can reach the pad, and every other net would otherwise take the short cut through it.
    for (const it of doc.items.values()) {
      if (it.kind !== "footprint") continue; const ref = refOf(K, it.node) || ""; const what = String(it.lib || "") + " " + String(it.value || "");
      if (!(/^(AE|ANT)\d/i.test(ref) || /antenna/i.test(what)) || /u\.?fl|sma|ipex|mmcx|coax/i.test(what)) continue;
      const pads: any[] = P.padsOf(it); if (!pads.length) continue;
      const cx = pads.reduce((a, p) => a + p.x, 0) / pads.length, cy = pads.reduce((a, p) => a + p.y, 0) / pads.length;
      const inside = (pts: Pt[]) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) if ((pts[i][1] > cy) !== (pts[j][1] > cy) && cx < ((pts[j][0] - pts[i][0]) * (cy - pts[i][1])) / (pts[j][1] - pts[i][1]) + pts[i][0]) c = !c; return c; };
      const q = G.quiet || (G.quiet = new Uint8Array(W * H)); let marked = false;
      for (const z of doc.items.values()) {
        if (z.kind !== "zone" || !K.kid(z.node, "keepout")) continue;
        const polys: Pt[][] = K.kids(z.node, "polygon").map((poly: any) => K.ptsOf(poly) as Pt[]).filter((pts: Pt[]) => pts.length >= 3);
        if (!polys.some(inside)) continue; const t = cellsIn(polys); const cl = G.clear || (G.clear = new Uint8Array(W * H)); for (let i = 0; i < t.length; i++) if (t[i]) { q[i] = 1; cl[i] = 1; } marked = true;
        // the ground beside the clear area is part of the antenna: a band of it stays whole, so no other net runs along the edge
        const band = this.opts.antennaBand === undefined ? 1.2 : Math.max(0, +this.opts.antennaBand);
        if (band > 0) { let b: Box = [Infinity, Infinity, -Infinity, -Infinity]; for (const pts of polys) for (const pt of pts) b = [Math.min(b[0], pt[0] - band), Math.min(b[1], pt[1] - band), Math.max(b[2], pt[0] + band), Math.max(b[3], pt[1] + band)];
          const cb = this.cellBox(b); if (cb) for (let iy = cb[1]; iy <= cb[3]; iy++) q.fill(1, iy * W + cb[0], iy * W + cb[2] + 1); }
      }
      if (!marked) { let b: Box = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pads) b = [Math.min(b[0], p.x - 2.5), Math.min(b[1], p.y - 2.5), Math.max(b[2], p.x + 2.5), Math.max(b[3], p.y + 2.5)];
        const cb = this.cellBox(b); if (cb) for (let iy = cb[1]; iy <= cb[3]; iy++) q.fill(1, iy * W + cb[0], iy * W + cb[2] + 1); }
      for (const p of pads) { const n = nl.table.key(p.net) || ""; if (n) { this.xtalNets.add(n); this.feedNets.add(n); } }
    }
    for (const it of doc.items.values()) if (it.kind === "footprint") { const ref = refOf(K, it.node); for (const p of P.padsOf(it)) this.padNames.set(p.x.toFixed(3) + "," + p.y.toFixed(3), (ref || "?") + "." + p.number); }
    // Groups: a chip and the small parts that serve it (its capacitors, pull-ups, crystal, inductor) are one cluster,
    // and a person routes inside each cluster before anything runs between clusters.  A plan names them
    // (opts.groups); what it leaves out is found from the board: a small part belongs to the nearest chip it shares a
    // net with, within GROUP_REACH mm of a pad of that net, and a small part that hangs on a grouped one joins it.
    {
      type FP = { ref: string; pads: any[]; nets: Map<string, any[]> };
      const fps: FP[] = [];
      for (const it of doc.items.values()) if (it.kind === "footprint") {
        const ref = refOf(K, it.node); const pads = P.padsOf(it); if (!ref || !pads.length) continue; const nets = new Map<string, any[]>();
        for (const p of pads) { const n = nl.table.key(p.net) || ""; if (n) { const l = nets.get(n); if (l) l.push(p); else nets.set(n, [p]); } }
        fps.push({ ref, pads, nets });
      }
      for (const [name, refs] of Object.entries(this.opts.groups || {})) for (const r of refs || []) this.groupOf.set(r, name);
      const chips = fps.filter((f) => f.pads.length >= 5); const small = fps.filter((f) => f.pads.length < 5 && !this.groupOf.has(f.ref));
      for (const c of chips) if (!this.groupOf.has(c.ref)) this.groupOf.set(c.ref, c.ref);
      const reach = (f: FP, o: FP, lim: number): number => { let best = Infinity; for (const [n, ps] of f.nets) { const qs = o.nets.get(n); if (!qs) continue; const w = /^\/?(.*\/)?(A|D|P)?(GND|VSS)\w*$/i.test(n) ? 1e3 : 0;   // a shared ground says nothing about whose part it is
        for (const p of ps) for (const q of qs) { const d = Math.hypot(p.x - q.x, p.y - q.y) + w; if (d < best) best = d; } } return best <= lim ? best : Infinity; };
      for (const f of small) { let best = Infinity, owner = ""; for (const c of chips) { const d = reach(f, c, GROUP_REACH); if (d < best) { best = d; owner = this.groupOf.get(c.ref)!; } } if (owner) this.groupOf.set(f.ref, owner); }
      for (let round = 0; round < 2; round++) for (const f of small) { if (this.groupOf.has(f.ref)) continue; let best = Infinity, owner = ""; for (const o of small) { const g = this.groupOf.get(o.ref); if (!g || o === f) continue; const d = reach(f, o, GROUP_REACH * 0.7); if (d < best) { best = d; owner = g; } } if (owner) this.groupOf.set(f.ref, owner); }
    }
    this.pref = hv.map(([h, v]) => h + v > 20 ? (h - v) / (h + v) : 0);
    // An empty board has no habit yet: give it the usual one, alternate layers running across and along.
    if (!allow && this.opts.planes === true && L > 2) {   // off by default: closing the ground layer to tracks cost Ledify 20 points (2026-11-16)
      const area = (pts: Pt[]) => { let t = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; t += p[0] * q[1] - q[0] * p[1]; } return Math.abs(t) / 2; };
      const whole = outline ? area(outline) : (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
      for (let l = 1; l < L - 1; l++) { let a = 0; for (const z of zones) if (z.net && z.layers.includes(l) && z.polys.length) a += area(z.polys[0]); const ground = zones.some((z) => z.layers.includes(l) && /^\/?(GND|AGND|DGND|PGND|VSS)/i.test(z.net));
        if (ground && whole > 0 && a >= PLANE_COVER * whole && routable.filter(Boolean).length > 2) { routable[l] = false; this.planeLayers.push(copper[l]); } }   // a supply plane stays open to tracks: the owner runs a few signals on it (Ledify, Ember)
    }
    // The owner keeps inner planes whole and runs signals on the outer layers, the back as much as the front (Ledify,
    // Ember, Cyberboard: 2 to 15% of their track on inner layers, where the router laid 30 to 40%): a mm of track on an
    // inner layer a pour covers counts more, so a route takes the back first and a plane only when it saves a lot.
    if (L > 2 && (this.opts.planeCost ?? PLANE_COST) > 1) {
      const area = (pts: Pt[]) => { let t = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; t += p[0] * q[1] - q[0] * p[1]; } return Math.abs(t) / 2; };
      const whole = outline ? area(outline) : (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]); const k = this.opts.planeCost ?? PLANE_COST;
      const lc = copper.map(() => 1); for (let l = 1; l < L - 1; l++) { let a = 0; for (const z of zones) if (z.net && z.layers.includes(l) && z.polys.length) a += area(z.polys[0]); if (whole > 0 && a >= PLANE_COVER * whole) lc[l] = k; }
      if (lc.some((c) => c !== 1)) G.layerCost = lc;
    }
    if (hv.every(([h, v]) => h + v <= 20) && routable.filter(Boolean).length > 1) { let k = 0; this.pref = routable.map((r) => r ? (k++ % 2 ? -0.5 : 0.5) : 0); }

    // ---- what to connect: per net, a spanning tree over its islands of copper
    const want = this.opts.nets ? new Set(this.opts.nets) : null; const useZones = this.opts.zones !== false;
    this.sizeForImpedance(Array.from(nl.nets.values() as Iterable<any>).map((n: any) => n.key).filter((k: string) => k && (!want || want.has(k))));
    // Routing only some nets still watches every poured net (the ground plane above all): a new track that cuts a
    // pad of it off its pour, or closes a loop round one, is answered by stitch() with a track of that net, so a
    // later route call never leaves a ground pad stranded.  Such a net gets no connections of its own here.
    // per layer, the cells two nets' pours both claim (a split plane, a pour over another): 2 there
    let sharedMemo: (Uint8Array | null)[] | null = null;
    const shared = () => { if (sharedMemo) return sharedMemo; const own: (Int32Array | null)[] = copper.map(() => null); const out: (Uint8Array | null)[] = copper.map(() => null); const ids = new Map<string, number>();
      for (const z of zones) { if (!z.net) continue; let id = ids.get(z.net); if (id === undefined) ids.set(z.net, id = ids.size + 1); const t = cellsIn(z.polys);
        for (const l of z.layers) { const o = own[l] || (own[l] = new Int32Array(W * H)); for (let i = 0; i < t.length; i++) if (t[i]) { if (!o[i]) o[i] = id; else if (o[i] !== id) { const m = out[l] || (out[l] = new Uint8Array(W * H)); m[i] = 2; } } } }
      return sharedMemo = out; };
    const poured = new Set<string>(useZones ? zones.map((z: any) => z.net).filter(Boolean) : []);
    for (const net of nl.nets.values()) {
      if (!net.key || (want && !want.has(net.key) && !poured.has(net.key))) continue;
      const watchOnly = !!want && !want.has(net.key);
      const clusters: Anchor[][] = [];
      for (const cl of net.clusters) {
        const anchors: Anchor[] = [];
        for (const c of cl.items) {
          if (c.kind === "zone") continue;
          const layers = Array.from(c.layers as Set<string>).map((l) => copper.indexOf(l)).filter((i) => i >= 0); if (!layers.length) continue;
          for (const p of c.anchors) {
            const ix = Math.round((p[0] - G.ox) / G.g), iy = Math.round((p[1] - G.oy) / G.g);
            if (ix < 0 || iy < 0 || ix >= W || iy >= H || (G.outside && G.outside[iy * W + ix])) continue;   // off the board: nothing to route to
            anchors.push({ p: [p[0], p[1]], layers, shape: c.kind === "pad" || c.kind === "via" ? c.shape : { t: "circle", x: p[0], y: p[1], r: (c.width || 0.2) / 2 }, cluster: 0, narrow: c.kind === "pad" && c.pad.type === "smd" ? Math.min(c.pad.w, c.pad.h) : undefined, axis: c.kind === "pad" && c.pad.type === "smd" ? padAxis(c.pad) : undefined });
          }
        }
        if (anchors.length) { for (const a of anchors) a.grp = clusters.length; clusters.push(anchors); }
      }
      // An unfilled zone of the net joins the pads it covers on its own layers once it is filled: those need no
      // track.  The remaining islands may reach the zone with a short track and a via instead of a long one.
      const mine = useZones ? zones.filter((z) => z.net === net.key) : []; let zoneCluster = -1; let zoneCells: Node[] | null = null; let pour: NetInfo["pour"]; const anchors = ([] as Anchor[]).concat(...clusters); let planeEnd: ((a: Anchor) => Anchor | null) | null = null; let dropAt: ((a: Anchor) => Anchor | null) | undefined;
      if (mine.length) {
        const inZone = (a: Anchor) => mine.some((z) => z.layers.some((l) => a.layers.includes(l)) && z.polys.filter((pts) => pointInPolyPts(pts, a.p)).length % 2 === 1);
        const covered: number[] = [], rest: Anchor[][] = [];
        // a plane on a layer no pad of the net is on: the plane itself is the island the pads drop into
        const inner = (l: number) => this.opts.planeDrops === true ? /^In\d/.test(copper[l]) : !routable[l]; const pz = mine.filter((z) => z.layers.some(inner));   // drops into a supply plane: opt-in, they cost Ledify 21 points on its split +3V3/VBUS plane (Ember +1.4)
        if (pz.length && !watchOnly) {
          const pl = pz[0].layers.find(inner)!;
          // only where the plane is really there: inside its outline, 0.6 mm in from the edge, and not where another
          // net's pour shares the layer (a split plane: the fill there may be the other net's)
          const edgeGap = (polys: Pt[][], p: Pt) => { let d = Infinity; for (const pts of polys) for (let i = 0; i < pts.length; i++) { const a0 = pts[i], b0 = pts[(i + 1) % pts.length]; const dx = b0[0] - a0[0], dy = b0[1] - a0[1], L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((p[0] - a0[0]) * dx + (p[1] - a0[1]) * dy) / L)) : 0; d = Math.min(d, Math.hypot(p[0] - a0[0] - t * dx, p[1] - a0[1] - t * dy)); } return d; };
          const others = zones.filter((z) => z.net !== net.key && z.layers.includes(pl));
          const under = (a: Anchor) => pz.some((z) => z.polys.filter((pts) => pointInPolyPts(pts, a.p)).length % 2 === 1 && edgeGap(z.polys, a.p) >= 0.6) && !others.some((z) => z.polys.filter((pts) => pointInPolyPts(pts, a.p)).length % 2 === 1 || edgeGap(z.polys, a.p) < 0.6);
          planeEnd = (a: Anchor) => under(a) && !a.layers.includes(pl) ? { p: [a.p[0], a.p[1]], layers: [pl], shape: { t: "circle", x: a.p[0], y: a.p[1], r: 0.01 }, cluster: 0, plane: true } as Anchor : null;
          if (!clusters.some((cl) => cl.some(inZone))) { const a = anchors.find(under); if (a) clusters.push([planeEnd(a) || a]); }
        }
        // the same drop for the shortcut pass after routing, whether or not planeDrops is on: any inner plane of the net
        { const pzi = mine.filter((z) => z.layers.some((l) => /^In\d/.test(copper[l]))); if (pzi.length && !watchOnly) { const pl = pzi[0].layers.find((l) => /^In\d/.test(copper[l]))!; const others = zones.filter((z) => z.net !== net.key && z.layers.includes(pl)); const inP = (polys: Pt[][], p: Pt) => polys.filter((pts) => pointInPolyPts(pts, p)).length % 2 === 1;
          const gap = (polys: Pt[][], p: Pt) => { let d = Infinity; for (const pts of polys) for (let i = 0; i < pts.length; i++) { const a0 = pts[i], b0 = pts[(i + 1) % pts.length]; const dx = b0[0] - a0[0], dy = b0[1] - a0[1], L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((p[0] - a0[0]) * dx + (p[1] - a0[1]) * dy) / L)) : 0; d = Math.min(d, Math.hypot(p[0] - a0[0] - t * dx, p[1] - a0[1] - t * dy)); } return d; };
          dropAt = (a: Anchor) => !a.plane && !a.layers.includes(pl) && pzi.some((z) => inP(z.polys, a.p) && gap(z.polys, a.p) >= 0.6) && !others.some((z) => inP(z.polys, a.p) || gap(z.polys, a.p) < 0.6) ? { p: [a.p[0], a.p[1]], layers: [pl], shape: { t: "circle", x: a.p[0], y: a.p[1], r: 0.01 }, cluster: 0, plane: true } as Anchor : null; } }
        clusters.forEach((cl, i) => { if (cl.some(inZone)) covered.push(i); else rest.push(cl); });
        if (covered.length) {
          const merged: Anchor[] = []; for (const i of covered) merged.push(...clusters[i]);
          this.zoneCovered += covered.length - 1; clusters.length = 0; clusters.push(merged, ...rest); zoneCluster = 0;
          zoneCells = [];
          pour = { mask: copper.map(() => null), width: Math.max(...mine.map((z) => z.minW)), clr: Math.max(P.netClearance(s, net.key), s.minClearance || 0, ...mine.map((z) => z.clr)) };
          for (const z of mine) { const t = cellsIn(z.polys); for (const l of z.layers) { const m = pour.mask[l] || (pour.mask[l] = new Uint8Array(W * H)); const sh = this.opts.splitPlaneEnds ? shared()[l] : null; for (let i = 0; i < t.length; i++) if (t[i] && !(G.noPour && G.noPour[i])) { m[i] = 1; if (!sh || sh[i] !== 2) zoneCells.push({ ix: i % W, iy: (i / W) | 0, l }); } } }   // where pours of two nets overlap, the fill may be the other's: no end there
        }
      }
      if (clusters.length < 2 && !pour) continue;
      clusters.forEach((cl, i) => cl.forEach((a) => { a.cluster = i; }));
      if (watchOnly && !pour) continue;
      const cls = this.classFor(net.key);
      const info: NetInfo = { key: net.key, obj: nl.table.byName.get(net.key) || { code: net.code, name: net.name }, cls, conns: [], clusters: clusters.length, zoneCells, zoneCluster, guide: this.guideFor(net.key), anchors, pour, drop: dropAt };
      // Prim's tree over the islands through their nearest anchors (the ratsnest)
      // A differential pair's net passes through its in-line parts: a connector's twin pins are bridged first, and a
      // chip joins the ESD part or series resistor beside the connector, never the connector's other pin past it.
      const isPair = !!pairName(net.key); const partOf = (i: number) => { for (const a of clusters[i]) { const r = this.padNames.get(a.p[0].toFixed(3) + "," + a.p[1].toFixed(3)); if (r) return r.replace(/\.[^.]*$/, ""); } return "#" + i; };
      const parts = isPair ? clusters.map((_, i) => partOf(i)) : null; const isConn = (r: string) => /^(J|P|CN|USB|X)\d/i.test(r);
      const near = (i: number, j: number) => {
        let best: [number, Anchor, Anchor] | null = null; for (const a of clusters[i]) for (const b of clusters[j]) { const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); if (!best || d < best[0]) best = [d, a, b]; }
        // straight down into the plane beats a track to a far pad; a pad of the net close by is joined by track instead,
        // as people do (one via serves the pads that stand together)
        if (planeEnd && zoneCluster === 0 && (i === 0 || j === 0) && best![0] > PLANE_HOP_MM) {
          for (const a of clusters[i === 0 ? j : i]) { const e = planeEnd(a); if (e) { best = i === 0 ? [PLANE_HOP_MM, e, a] : [PLANE_HOP_MM, a, e]; break; } }
        }
        return best!;
      };
      const cost = (i: number, j: number, e: [number, Anchor, Anchor]) => !parts ? e[0] : parts[i] === parts[j] ? e[0] * 0.01 : e[0] + (isConn(parts[i]) || isConn(parts[j]) ? 5 : 0);
      const inTree = clusters.map(() => false); const bestTo: ([number, Anchor, Anchor] | null)[] = clusters.map(() => null);
      const bestCost: number[] = clusters.map(() => Infinity);
      const update = (k: number) => { for (let j = 0; j < clusters.length; j++) { if (inTree[j]) continue; const e = near(k, j), c = cost(k, j, e); if (!bestTo[j] || c < bestCost[j]) { bestTo[j] = e; bestCost[j] = c; } } };
      inTree[0] = true; update(0);
      for (let n = 1; n < (watchOnly ? 0 : clusters.length); n++) {
        let j = -1; for (let i = 0; i < clusters.length; i++) if (!inTree[i] && (j < 0 || bestCost[i] < bestCost[j])) j = i;
        inTree[j] = true; const e = bestTo[j]!;
        const room = Math.min(this.roomAt(e[1], net.key), this.roomAt(e[2], net.key));
        const conn: Conn = { id: this.conns.length, net: net.key, cls: this.classFor(net.key, room), a: e[2], b: e[1], len: e[0], nodes: null, shapes: [], viaCells: [], landed: -1, rips: 0, feat: null, stubs: [], zoneEnd: false };
        this.conns.push(conn); info.conns.push(conn); update(j);
      }
      this.nets.push(info);
    }
    this.rows = this.fineRows(nl);
    if ((this.opts.escapes ?? ESCAPES) !== false) this.fanout();
  }

  // ------------------------------------------------------------------ fan-out before routing (fanout.ts)
  escapeObs: Obstacle[] = []; private laid: { e: Escape; anchors: Anchor[]; obs: Obstacle[]; orig: Pick<Anchor, "p" | "layers" | "shape" | "narrow" | "axis">[] }[] = []; fanReport: RouteResult["fanout"]; fanNote?: Partial<NonNullable<RouteResult["fanout"]>>;   // set by routeRuns
  /** The fine-pitch rows of the board, by key: Copper's needs_fanout (fanout.py) picks the parts, those with a row
   *  where two tracks do not fit between neighbouring pads (pitch < 2 (w + clr) + pad width, at the board's own
   *  track and clearance) or with 16 pads or more; every SMD row of such a part counts. */
  rows = new Map<string, FanRow>();
  private fineRows(nl: any): Map<string, FanRow> {
    const G = this.G, s = this.s; const key = (p: Pt) => p[0].toFixed(3) + "," + p[1].toFixed(3); const out = new Map<string, FanRow>();
    const w = s.trackWidth || 0.25, clr = Math.max(s.clearance || 0.2, s.minClearance || 0);
    const byPart = new Map<any, any[]>(); for (const c of nl.conductors) if (c.kind === "pad" && c.pad && c.pad.type === "smd" && c.item && c.layers.size === 1) { let l = byPart.get(c.item); if (!l) byPart.set(c.item, l = []); l.push(c); }
    for (const cs of byPart.values()) {
      if (cs.length < 3) continue; const cx = cs.reduce((s, c) => s + c.pad.x, 0) / cs.length, cy = cs.reduce((s, c) => s + c.pad.y, 0) / cs.length;
      // pads longer than wide: their long axis is the way out of the part
      const pads = cs.filter((c) => Math.max(c.pad.w, c.pad.h) >= 1.2 * Math.min(c.pad.w, c.pad.h)).map((c) => ({ name: this.padNames.get(key([c.pad.x, c.pad.y])) || key([c.pad.x, c.pad.y]), p: [c.pad.x, c.pad.y] as Pt, len: Math.max(c.pad.w, c.pad.h), across: Math.min(c.pad.w, c.pad.h), axis: padAxis(c.pad), layer: G.layers.indexOf(Array.from(c.layers as Set<string>)[0]) }));
      const rows = padRows(pads.filter((q) => q.layer >= 0 && G.routable[q.layer]), [cx, cy]); if (!rows.length) continue;
      const dense = (r: FanRow) => { let pitch = Infinity; for (let i = 1; i < r.pads.length; i++) pitch = Math.min(pitch, Math.hypot(r.pads[i].p[0] - r.pads[i - 1].p[0], r.pads[i].p[1] - r.pads[i - 1].p[1])); return pitch < 2 * (w + clr) + Math.max(...r.pads.map((p) => p.across)) - 1e-9; };
      if (cs.length < 16 && !rows.some(dense)) continue;
      for (const r of rows) out.set(`${r.pads[0].name}~${r.pads[r.pads.length - 1].name}@${key(r.pads[0].p)}`, r);
    }
    return out;
  }
  /** The rows (keys of `rows`) with a pin that ends a connection this run left open: the pins a plain route left boxed in. */
  boxedRows(): string[] {
    const key = (p: Pt) => p[0].toFixed(3) + "," + p[1].toFixed(3); const at = new Map<string, string>();
    for (const [k, r] of this.rows) for (const p of r.pads) at.set(key(p.p), k);
    const out = new Set<string>();
    for (const c of this.conns) if (!c.nodes && !c.moot) for (const a of [c.a, c.b, ...(c.ends || [])]) { const k = at.get(key(a.p)); if (k) out.add(k); }
    return Array.from(out).sort();
  }
  /** Escape every connected pin of the fine-pitch rows (those of `escapeRows` when given) before anything is routed,
   *  and move the ends of its connections to the escapes.  The pins whose net goes elsewhere keep their lane even when
   *  they get no escape. */
  private fanout(): void {
    const G = this.G; const all = G.layers.map((_, i) => i); const key = (p: Pt) => p[0].toFixed(3) + "," + p[1].toFixed(3);
    const ends = new Map<string, { anchors: Set<Anchor>; conns: Conn[]; other: Anchor[] }>();
    for (const net of this.nets) for (const c of net.conns) for (const [a, b] of [[c.a, c.b], [c.b, c.a]] as [Anchor, Anchor][]) {
      if (!a.axis || !a.narrow || a.plane) continue; let e = ends.get(key(a.p)); if (!e) ends.set(key(a.p), e = { anchors: new Set(), conns: [], other: [] }); e.anchors.add(a); e.conns.push(c); e.other.push(b);
    }
    const only = this.opts.escapeRows ? new Set(this.opts.escapeRows) : null;
    const rows = Array.from(this.rows).filter(([k]) => !only || only.has(k)).map(([, r]) => r);
    if (!rows.length) return;
    // a job for every pin that ends a connection; pins of a differential pair, an RF feed, or with copper of their
    // net already on them only keep their lane (near = 0: no escape of their own)
    const jobs = new Map<string, FanJob>(); const at = new Map<string, string>();
    for (const r of rows) for (const pad of r.pads) {
      const e = ends.get(key(pad.p)); if (!e || jobs.has(pad.name)) continue; const c = e.conns[0], cls = c.cls, net = this.netOf(c.net);
      let near = Infinity, partner: Pt = e.other[0].p, off = true;
      for (const o of e.other) { const d = Math.hypot(o.p[0] - pad.p[0], o.p[1] - pad.p[1]); if (d < near) { near = d; partner = o.p; } if (o.layers.includes(pad.layer)) off = false; }
      const a = Array.from(e.anchors)[0]; const crowd = (net.anchors || []).filter((x) => x.cluster === a.cluster).length > 1;
      if (pairName(c.net) || this.kindOf(c.net) === "rf" || crowd || net.guide.allowed) near = 0;   // leaving supply pins out too cost Ember 3 (17 -> 20 open)
      jobs.set(pad.name, { pad, net: c.net, w: Math.min(cls.width, pad.across), clr: cls.clr, viaD: cls.viaD, viaDrill: cls.viaDrill, partner, near, offLayer: off && net.guide.allowVias && this.allowVias });
      at.set(pad.name, key(pad.p));
    }
    const live = new Map<Escape, Obstacle[]>();
    const add = (o: Obstacle) => { let l = G.obstacles.get(o.net); if (!l) G.obstacles.set(o.net, l = []); l.push(o); };
    const why = { net: "", gap: 0, need: 0 };
    const cellsOf = (s: Shape): number[] => { const out: number[] = []; const pts: Pt[] = s.t === "circle" ? [[s.x, s.y]] : []; if (s.t === "seg") { const n = Math.max(1, Math.ceil(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) / (G.g / 2))); for (let k = 0; k <= n; k++) pts.push([s.a[0] + (s.b[0] - s.a[0]) * k / n, s.a[1] + (s.b[1] - s.a[1]) * k / n]); }
      for (const p of pts) { const ix = Math.round((p[0] - G.ox) / G.g), iy = Math.round((p[1] - G.oy) / G.g); out.push(ix < 0 || iy < 0 || ix >= G.W || iy >= G.H ? -1 : iy * G.W + ix); } return out; };
    const ctx = {
      hit: (s: Shape, l: number, net: string, clr: number): string | null => {
        for (const i of cellsOf(s)) if (i < 0 || (G.outside && G.outside[i]) || (G.keep[l] && G.keep[l]![i])) return "keep-out";
        return this.clearOf(s, l, net, clr, why) ? null : why.net || "edge";
      },
      viaHit: (p: Pt, j: FanJob): string | null => {
        const s: Shape = { t: "circle", x: p[0], y: p[1], r: j.viaD / 2 }; const clr = Math.max(j.clr, (G.holeClr || 0) + HOLE_SLACK - (j.viaD - j.viaDrill) / 2);
        for (const i of cellsOf(s)) if (i < 0 || G.noVia[i] || (G.outside && G.outside[i])) return "keep-out";
        for (const o of G.obstacles.get(j.net) || []) if (o.pad && o.layers.length < G.layers.length && pointGap(o.shape, p[0], p[1]) < j.viaD * 0.3) return "via in pad";   // touching its own pad is fine, sitting on it is not
        for (const l of all) if (!this.clearOf(s, l, j.net, clr, why)) return why.net || "edge";
        return null;
      },
      place: (e: Escape) => {
        const j = jobs.get(e.pad.name)!; const obs: Obstacle[] = e.segs.map(([a, b]) => ({ net: e.net, layers: [e.pad.layer], shape: { t: "seg", a, b, r: e.w / 2 } as Shape, clr: j.clr }));
        if (e.via) obs.push({ net: e.net, layers: all, shape: { t: "circle", x: e.via[0], y: e.via[1], r: j.viaD / 2 } as Shape, clr: Math.max(j.clr, (G.holeClr || 0) + HOLE_SLACK - (j.viaD - j.viaDrill) / 2), thru: e.via });
        for (const o of obs) add(o); live.set(e, obs); this.oidx = null;
      },
      unplace: (e: Escape) => { const obs = live.get(e) || []; const l = G.obstacles.get(e.net); if (l) G.obstacles.set(e.net, l.filter((o) => !obs.includes(o))); live.delete(e); this.oidx = null; },
    };
    const want = this.opts.escapes ?? ESCAPES; const o = typeof want === "object" ? want : { depth: typeof want === "number" ? want : 0 };
    const { escapes, boxed } = fanout(rows, jobs, ctx, o.depth || 0, o.spread ?? SPREAD);
    // the escapes are board copper of their nets from here on, and their ends are where the connections start
    for (const e of escapes) {
      const obs = live.get(e)!; this.escapeObs.push(...obs); for (const c of G.classes.values()) for (const o of obs) stampClass(G, c, o, 1, true);
      const j = jobs.get(e.pad.name)!; const anchors = Array.from(ends.get(at.get(e.pad.name)!)!.anchors); const orig = anchors.map((a) => ({ p: a.p, layers: a.layers, shape: a.shape, narrow: a.narrow, axis: a.axis }));
      for (const a of anchors) { a.p = e.end; a.layers = e.via ? all.filter((l) => G.routable[l]) : [e.pad.layer]; a.shape = { t: "circle", x: e.end[0], y: e.end[1], r: e.via ? j.viaD / 2 : e.w / 2 }; a.narrow = e.w; a.axis = e.via ? undefined : e.n; }
      this.padNames.set(key(e.end), e.pad.name); this.laid.push({ e, anchors, obs, orig });
    }
    // the lane kept goes on past each stub's end, as fanoutLanes keeps it past a pad's: only the pin's own net may
    // use it, so a neighbour's route cannot turn across in front of a stub and box it in
    const lane = this.opts.fanoutLanes === false ? 0 : typeof this.opts.fanoutLanes === "number" ? this.opts.fanoutLanes : 0.25;
    if (lane > 0) for (const e of escapes) if (!e.via) {
      const j = jobs.get(e.pad.name)!; const sh: Shape = { t: "seg", a: e.end, b: [e.end[0] + e.n[0] * lane, e.end[1] + e.n[1] * lane], r: 0.05 };
      if (ctx.hit({ ...sh, r: e.w / 2 }, e.pad.layer, e.net, j.clr) !== null) continue; const o: Obstacle = { net: e.net, layers: [e.pad.layer], shape: sh, clr: j.clr };
      add(o); this.escapeObs.push(o); for (const c of G.classes.values()) stampClass(G, c, o, 1, true); this.oidx = null;
    }
    this.oidx = null;
    this.fanReport = { escapes: escapes.length, ring: escapes.filter((e) => e.kind === "ring").length, via: escapes.filter((e) => e.kind === "via").length, used: 0, boxed, rows: rows.length };
  }

  private xtalNets = new Set<string>(); private feedNets = new Set<string>();
  private planeLayers: string[] = []; private fanned = 0;
  /** The rule class a net routes with (its netclass's track width, clearance and via), built on first use. */
  classFor(netKey: string, cap = Infinity, want = 0, smallVia = false): RuleClass {
    const { P, s, G } = this; const nc = P.netclassOf(s, netKey); const plan = (this.opts.netOpts || {})[netKey]; const pw = plan && +plan.width! > 0 ? +plan.width! : 0;
    const zw = pw ? 0 : (this.zWidth.get(netKey) || 0);   // a plan's own width stands; else the width its impedance asks for
    let width = Math.max(pw || zw || Math.max(nc.track_width !== undefined ? nc.track_width : s.trackWidth, want), s.minTrackWidth || 0);
    // A fine-pitch pad only has room for so wide a track between its neighbours: a connection that ends on one
    // runs as wide as that room allows, as people neck tracks down at such pads.
    if (cap < width) width = Math.max(s.minTrackWidth || 0.1, 0.1, Math.floor(cap * 100 + 1e-6) / 100);
    const clr = Math.max(P.netClearance(s, netKey), s.minClearance || 0); const viaD0 = Math.max(nc.via_diameter !== undefined ? nc.via_diameter : s.viaDiameter, s.minViaDiameter || 0);
    let viaD = viaD0, viaDrill = Math.max(nc.via_drill !== undefined ? nc.via_drill : s.viaDrill, s.minThroughDrill || 0);
    // The smallest via Board Setup permits, for a connection the class's own via cannot serve (a ball in a grid
    // array has no room for it).  Only when the board states its minimums; the hole keeps its annular ring.
    if (smallVia && s.minViaDiameter > 0 && s.minThroughDrill > 0 && s.minViaDiameter < viaD0 - 1e-6) { const d = Math.max(s.minViaDiameter, s.minThroughDrill + 2 * (s.minViaAnnular || 0.05)); if (d < viaD0 - 1e-6) { viaD = d; viaDrill = Math.min(viaDrill, s.minThroughDrill); } }
    const kind = this.relax ? undefined : this.kindFor(netKey);
    const open = !G.quiet || this.xtalNets.has(netKey) || /^\/?(GND|AGND|DGND|PGND|VSS)/i.test(netKey);
    const feed = this.feedNets.has(netKey);   // an antenna's clear area takes its feed and nothing else, not even ground (no pour reaches there to join it)
    const key = `${width}/${clr}/${viaD}/${viaDrill}` + (kind ? "/" + kind : "") + (open ? "" : "/q") + (feed ? "/f" : ""); let c = G.classes.get(key);
    if (!c) { c = buildClass(G, key, width, clr, viaD, viaDrill, kind, open, feed); if (this.conns.length) for (const o of this.conns) if (o.nodes) for (const sh of o.shapes) stampClass(G, c, sh, 1, false); }
    return c;
  }
  relax = false; relaxed = new Set<string>(); pairNets = new Set<string>(); private kindMemo = new Map<string, NetKind>(); private domains: boolean | null = null;
  /** The net's kind, as planned or by name. */
  kindOf(netKey: string): NetKind { let k = this.kindMemo.get(netKey); if (!k) { const plan = (this.opts.netOpts || {})[netKey]; k = (plan && plan.kind) || netKind(netKey, this.pairNets.has(netKey) || undefined); this.kindMemo.set(netKey, k); } return k; }
  /** The kind a net's rule class carries: none when the board has nothing sensitive on it (or separation is off),
   *  and none for supply nets, which every domain shares. */
  private kindFor(netKey: string): string | undefined {
    const G = this.G;
    if (this.domains === null) {
      const names = new Set<string>([...G.obstacles.keys(), ...Object.keys(this.opts.netOpts || {})]); names.delete("");
      { const by = new Map<string, string[]>(); for (const n of names) { const k = pairName(n); if (k) { const e = by.get(k.base) || []; by.set(k.base, e); e[k.pol > 0 ? 0 : 1] = n; } } for (const e of by.values()) if (e[0] && e[1]) { this.pairNets.add(e[0]); this.pairNets.add(e[1]); } this.kindMemo.clear(); }
      this.domains = this.opts.separate !== false && Array.from(names).some((n) => { const k = this.kindOf(n); return k === "analog" || k === "rf"; });
      if (this.domains) {
        const o = typeof this.opts.separate === "object" ? this.opts.separate : {}; const base = Math.max(this.s.clearance || 0.2, this.s.minClearance || 0);
        const quiet = o.quiet !== undefined ? o.quiet : Math.max(2 * base, 0.3), noisy = o.noisy !== undefined ? o.noisy : Math.max(3 * base, 0.5); this.sepGaps = { quiet, noisy };
        const sens = (k: string) => k === "analog" || k === "rf", loud = (k: string) => k === "switching" || k === "fast";
        G.kinds = new Proxy(new Map<string, string>(), { get: (_t, prop) => prop === "get" ? (n: string) => { const k = this.kindOf(n); return k === "supply" ? undefined : k; } : undefined }) as any;
        { const near = G.nearPad = new Uint8Array(G.W * G.H); const reach = o.nearPads !== undefined ? o.nearPads : 1.2; for (const list of G.obstacles.values()) for (const ob of list) if (ob.pad) stamp(G, near as any, ob.shape, reach, 1); }
        G.sep = (a, b) => a === b || a === "supply" || b === "supply" ? 0 : sens(a) && sens(b) ? quiet : sens(a) ? (loud(b) ? noisy : quiet) : sens(b) ? (loud(a) ? noisy : quiet) : 0;
      }
    }
    if (!this.domains) return undefined; const k = this.kindOf(netKey); return k === "supply" ? undefined : k;
  }
  sepGaps = { quiet: 0, noisy: 0 };
  /** Supply nets carry the board's current: where the net has no class or plan of its own, they run wider. */
  /** The width a plain signal is drawn at where there is room: people route at 0.2 mm and neck down only at a
   *  fine-pitch pin, whatever minimum the net class allows.  0 for a net whose width is set by a plan, an impedance or a pair. */
  signalWidth(c: Conn): number {
    const o = this.opts.signalWidth; const want = o === undefined ? 0.2 : +o; if (!(want > 0) || c.pair || isSupply(c.net)) return 0;
    const plan = (this.opts.netOpts || {})[c.net]; if ((plan && +plan.width! > 0) || this.zWidth.get(c.net)) return 0;
    return want;
  }
  powerWidth(netKey: string): number {
    const { P, s } = this; const o = this.opts.powerWidth; if (o === 0 || !isSupply(netKey)) return 0;
    if (((this.opts.netOpts || {})[netKey] || {}).width) return 0; const nc = P.netclassOf(s, netKey); if (s.netclasses.Default && nc !== s.netclasses.Default) return 0; const w = nc.track_width !== undefined ? nc.track_width : s.trackWidth;
    return o && o > 0 ? o : Math.min(0.5, Math.max(0.3, w * 2));
  }
  padNames = new Map<string, string>();
  /** The cluster each part belongs to (a chip's reference, or a plan's group name). */
  groupOf = new Map<string, string>();
  /** The cluster a connection lies inside (both its pads belong to parts of one cluster), or "". */
  groupFor(c: Conn): string {
    const ref = (p: Pt) => (this.padNames.get(p[0].toFixed(3) + "," + p[1].toFixed(3)) || "").replace(/\.[^.]*$/, "");
    const a = this.groupOf.get(ref(c.a.p)), b = this.groupOf.get(ref(c.b.p)); return a && a === b ? a : "";
  }
  private cellBox(b: Box): [number, number, number, number] | null {
    const G = this.G; if (!b || b.length < 4) return null;
    const x0 = Math.max(0, Math.ceil((Math.min(b[0], b[2]) - G.ox) / G.g)), x1 = Math.min(G.W - 1, Math.floor((Math.max(b[0], b[2]) - G.ox) / G.g));
    const y0 = Math.max(0, Math.ceil((Math.min(b[1], b[3]) - G.oy) / G.g)), y1 = Math.min(G.H - 1, Math.floor((Math.max(b[1], b[3]) - G.oy) / G.g));
    return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
  }
  /** The plan's wishes for a net, resolved against this board. */
  private guideFor(netKey: string): Guide {
    const G = this.G, plan: NetPlan = (this.opts.netOpts || {})[netKey] || {}; const rank = (this.opts.order || []).indexOf(netKey);
    let allowed: boolean[] | null = null;
    if (plan.layers && plan.layers.length) { allowed = G.layers.map((nm) => plan.layers!.includes(nm)); if (!allowed.some(Boolean)) allowed = null; }
    // USB 2.0 data lines take no via unless the plan allows one: a via is a stub and an impedance step on a 90 ohm pair (the person's rule)
    const usbData = plan.maxVias === undefined && usualImpedance(netKey, true) === 90 && /USB|(^|[\/_(])D[+\-PM]\)?$/i.test(netKey) && !!pairName(netKey);
    return { allowed, allowVias: this.allowVias && plan.allowVias !== false, maxVias: usbData ? 0 : plan.maxVias === undefined || plan.maxVias === null ? Infinity : Math.max(0, +plan.maxVias),
      avoid: (plan.avoid || []).map((b) => this.cellBox(b)).filter(Boolean) as [number, number, number, number][], viaAvoid: (plan.viaAvoid || []).map((b) => this.cellBox(b)).filter(Boolean) as [number, number, number, number][], rank: rank < 0 ? Infinity : rank, priority: +plan.priority! || 0 };
  }
  /** A connection between two given points of a net, outside the run's own list (the trainer and tools use this). */
  adhoc(netKey: string, a: { p: Pt; layers: number[]; shape: Shape | null }, b: { p: Pt; layers: number[]; shape: Shape | null }): Conn {
    let info = this.nets.find((n) => n.key === netKey);
    if (!info) { info = { key: netKey, obj: null, cls: this.classFor(netKey), conns: [], clusters: 2, zoneCells: null, zoneCluster: -1, guide: this.guideFor(netKey) }; this.nets.push(info); }
    return { id: -1, net: netKey, cls: info.cls, a: { ...a, cluster: 0 }, b: { ...b, cluster: 1 }, len: Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]), nodes: null, shapes: [], viaCells: [], landed: -1, rips: 0, feat: null, stubs: [], zoneEnd: false };
  }

  // ------------------------------------------------------------------ lifting a net's own copper out of its map
  private netOf(key: string): NetInfo { return this.nets.find((n) => n.key === key)!; }
  lift(net: NetInfo, sign: number, c: RuleClass = net.cls): void {
    const G = this.G;
    for (const o of G.obstacles.get(net.key) || []) {
      stampClass(G, c, o, -sign, true);
      if (o.thru) {   // a plated hole: a pad or via through every layer
        const ix = Math.round((o.thru[0] - G.ox) / G.g), iy = Math.round((o.thru[1] - G.oy) / G.g);
        if (ix >= 0 && iy >= 0 && ix < G.W && iy < G.H) G.thru[iy * G.W + ix] = sign > 0 ? 1 : 0;
      }
    }
    for (const b of net.guide.avoid) for (const maps of [c.full, c.fixed, c.vfull, c.vfixed]) for (const m of maps) for (let iy = b[1]; iy <= b[3]; iy++) for (let i = iy * G.W + b[0]; i <= iy * G.W + b[2]; i++) m[i] += sign;
    for (const b of net.guide.viaAvoid) for (let iy = b[1]; iy <= b[3]; iy++) for (let i = iy * G.W + b[0]; i <= iy * G.W + b[2]; i++) G.noVia[i] += sign;
    for (const conn of net.conns) if (conn.nodes) {
      for (const o of conn.shapes) stampClass(G, c, o, -sign, false);
      for (const gi of conn.viaCells) G.thru[gi] = sign > 0 ? 1 : 0;
    }
  }
  private place(conn: Conn, sign: number): void {
    const G = this.G; for (const c of G.classes.values()) for (const o of conn.shapes) stampClass(G, c, o, sign, false);
  }
  private mm(n: { ix: number; iy: number }): Pt { return [r6(this.G.ox + n.ix * this.G.g), r6(this.G.oy + n.iy * this.G.g)]; }

  /** The free cell a route starts from at an anchor: its own cell, else the nearest free one still on the pad. */
  access(a: Anchor, maps: Uint16Array[], rt: boolean[] = this.G.routable): Terminal | null {
    const G = this.G; const cx = (a.p[0] - G.ox) / G.g, cy = (a.p[1] - G.oy) / G.g; const layers = a.layers.filter((l) => rt[l]); if (!layers.length) return null;
    let best: Terminal | null = null, bd = Infinity; const R = a.shape ? Math.min(6, Math.ceil(1 / G.g)) : 0;
    for (let iy = Math.round(cy) - R; iy <= Math.round(cy) + R; iy++) for (let ix = Math.round(cx) - R; ix <= Math.round(cx) + R; ix++) {
      if (ix < 0 || iy < 0 || ix >= G.W || iy >= G.H) continue; const d = Math.hypot(ix - cx, iy - cy); if (d >= bd) continue;
      if (R && d > 0.71 && pointGap(a.shape, G.ox + ix * G.g, G.oy + iy * G.g) > 0) continue;
      const free = layers.filter((l) => !maps[l][iy * G.W + ix]); if (!free.length) continue;
      bd = d; best = { ix, iy, layers: free };
    }
    return best || this.escape(a, maps, layers);
  }
  /**
   * A pad with no legal track centre on the grid (a fine-pitch pad whose row falls between grid rows): leave it
   * straight along its own axis, off the grid, to the first point from which a grid cell is reached — both pieces
   * checked exactly against everything around.
   */
  private escape(a: Anchor, maps: Uint16Array[], layers: number[]): Terminal | null {
    if (!a.axis || !this.cur) return null; const G = this.G, w = this.cur.cls.width, net = this.cur.net, clr = this.cur.cls.clr;
    for (let t = G.g; t <= 3; t += G.g / 2) for (const sgn of [1, -1]) {
      const q: Pt = [r6(a.p[0] + a.axis[0] * t * sgn), r6(a.p[1] + a.axis[1] * t * sgn)]; const ix = Math.round((q[0] - G.ox) / G.g), iy = Math.round((q[1] - G.oy) / G.g);
      if (ix < 0 || iy < 0 || ix >= G.W || iy >= G.H) continue; const free = layers.filter((l) => !maps[l][iy * G.W + ix]); if (!free.length) continue;
      const c: Pt = [r6(G.ox + ix * G.g), r6(G.oy + iy * G.g)];
      const ok = free.filter((l) => this.clearOf({ t: "seg", a: a.p, b: q, r: w / 2 }, l, net, clr) && this.clearOf({ t: "seg", a: q, b: c, r: w / 2 }, l, net, clr));
      if (ok.length) return { ix, iy, layers: ok, esc: q };
    }
    return null;
  }
  /** The widest track that can leave a fine-pitch pad along its axis and keep the clearance to what is beside it. */
  private roomAt(a: Anchor, net: string): number {
    if (!a.axis || !a.narrow || a.narrow > 0.35) return Infinity; const G = this.G, P = this.P; const clr = Math.max(P.netClearance(this.s, net), this.s.minClearance || 0); this.index();
    let half = Infinity; const B = 2; const seen = new Set<any>();
    for (const sgn of [1, -1]) {
      let h = Infinity; const b: Pt = [a.p[0] + a.axis[0] * 0.45 * sgn, a.p[1] + a.axis[1] * 0.45 * sgn]; const sh = { t: "seg", a: a.p, b, r: 0 }; seen.clear();
      for (let y = Math.floor((Math.min(a.p[1], b[1]) - 1) / B); y <= Math.floor((Math.max(a.p[1], b[1]) + 1) / B); y++) for (let x = Math.floor((Math.min(a.p[0], b[0]) - 1) / B); x <= Math.floor((Math.max(a.p[0], b[0]) + 1) / B); x++) for (const e of this.oidx!.get(x + "," + y) || []) {
        if (seen.has(e)) continue; seen.add(e); if ((e.o.net && e.o.net === net) || !e.o.layers.some((l) => a.layers.includes(l))) continue;
        const v = P.shapeGap(e.o.shape, sh) - (e.o.edge ? G.edgeClr : Math.max(e.o.clr, clr)); if (v < h) h = v;
      }
      if (sgn === 1 || h > half) half = sgn === 1 ? h : Math.max(half, h);   // the better of the two ways out
    }
    return half === Infinity ? Infinity : Math.max(0, 2 * (half - G.margin - 0.004));
  }
  private index(): void {
    if (this.oidx) return; const G = this.G, B = 2; const idx = this.oidx = new Map();
    const full = (s: Shape): number[] => { if (s.t === "circle") return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r]; if (s.t === "seg") return [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const pts: Pt[] = s.pts || [[s.x - Math.hypot(s.w, s.h) / 2, s.y - Math.hypot(s.w, s.h) / 2], [s.x + Math.hypot(s.w, s.h) / 2, s.y + Math.hypot(s.w, s.h) / 2]]; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } const o = s.r || 0; return [x0 - o, y0 - o, x1 + o, y1 + o]; };
    const add = (o: Obstacle) => { const bb = full(o.shape); const e = { o, bb }; for (let y = Math.floor(bb[1] / B); y <= Math.floor(bb[3] / B); y++) for (let x = Math.floor(bb[0] / B); x <= Math.floor(bb[2] / B); x++) { const k = x + "," + y; let l = idx.get(k); if (!l) idx.set(k, l = []); l.push(e); } };
    for (const list of G.obstacles.values()) for (const o of list) { if (o.shape.t === "path" && o.shape.pts.length > 2) { for (let i = 0; i + 1 < o.shape.pts.length; i++) add({ net: o.net, layers: o.layers, clr: o.clr, edge: o.edge, shape: { t: "seg", a: o.shape.pts[i], b: o.shape.pts[i + 1], r: o.shape.r || 0 } }); } else add(o); }
  }
  zWidth = new Map<string, number>(); zGap = new Map<string, number>(); zReports: ImpedanceReport[] = [];
  /** Work out, before anything is laid, the width (and for pairs the gap) each impedance-controlled net needs on
   *  this stackup.  A geometry the board cannot reasonably carry is reported and left at the class width. */
  private sizeForImpedance(keys: string[]): void {
    if (this.opts.impedance === false) return; const { K, P, s, doc, G } = this; const stack = stackupOf(K, doc);
    const outer = G.layers.find((_, l) => G.routable[l]) || G.layers[0]; const tr = traceOn(stack, outer); if (!tr) return;
    const model = `${tr.kind} on ${tr.layer} over ${tr.reference.join(" and ")}, ${+tr.h.toFixed(3)} mm of εr ${+tr.er.toFixed(2)}${stack.assumed ? " (stackup assumed: the board carries none)" : ""}`;
    const planned = (k: string) => +(((this.opts.netOpts || {})[k] || {}).impedance || 0);
    const by = new Map<string, { key: string }[]>(); const single: { key: string }[] = [];
    for (const key of keys) { const net = { key }; const k = pairName(net.key); if (k) { const e = by.get(k.base) || []; by.set(k.base, e); e.push(net); } else single.push(net); }
    const minW = Math.max(s.minTrackWidth || 0, 0.09); const r2 = (v: number) => Math.round(v * 100) / 100;
    for (const e of by.values()) {
      if (e.length !== 2) { single.push(...e); continue; }
      const target = planned(e[0].key) || planned(e[1].key) || usualImpedance(e[0].key, true); if (!target) continue;
      const clr = Math.max(P.netClearance(s, e[0].key), P.netClearance(s, e[1].key), s.minClearance || 0); const cw = this.classFor(e[0].key).width;
      // the tightest gap first (the strongest coupling), then wider ones, until the width is one the board can carry
      let pick: { w: number; g: number } | null = null, first: number | null = null;
      for (const g of [Math.max(clr, this.opts.pairGap || 0), clr * 1.5, clr * 2, clr * 3]) { const w = widthFor(tr, target, g); if (w !== null && first === null) first = w; if (w !== null && w >= minW && w <= Math.max(0.6, cw * 3)) { pick = { w: r2(w), g: r2(g) }; break; } }
      const rep: ImpedanceReport = { nets: e.map((n) => n.key), target, differential: true, layer: tr.layer, model, width: pick ? pick.w : first !== null ? r2(first) : null, gap: pick ? pick.g : r2(clr), applied: !!pick };
      if (pick) { for (const n of e) { this.zWidth.set(n.key, pick.w); this.zGap.set(n.key, pick.g); } rep.achieved = Math.round(zdiff(tr, pick.w, pick.g)); }
      else rep.note = first !== null ? `${target} Ω needs ${r2(first)} mm tracks on this stackup, more than the board can carry: routed at the class width (${Math.round(zdiff(tr, cw, clr))} Ω). A thinner dielectric under the layer (a 4-layer build) brings the width down.` : `no track width gives ${target} Ω on this stackup`;
      this.zReports.push(rep);
    }
    for (const net of single) {
      const target = planned(net.key) || usualImpedance(net.key, false); if (!target) continue; const cw = this.classFor(net.key).width; const w = widthFor(tr, target);
      const ok = w !== null && w >= minW && w <= Math.max(1.2, cw * 5);
      const rep: ImpedanceReport = { nets: [net.key], target, differential: false, layer: tr.layer, model, width: w !== null ? r2(w) : null, applied: ok };
      if (ok) { this.zWidth.set(net.key, r2(w!)); rep.achieved = Math.round(z0(tr, r2(w!))); }
      else rep.note = w !== null && w < minW ? `${target} Ω needs a ${r2(w)} mm track on this stackup, under the board's minimum track width (${r2(minW)} mm): routed at the class width (${Math.round(z0(tr, cw))} Ω).`
        : w !== null ? `${target} Ω needs a ${r2(w)} mm track on this stackup, more than the board can carry: routed at the class width (${Math.round(z0(tr, cw))} Ω). A thinner dielectric under the layer (a 4-layer build), or a coplanar feed with ground beside it, brings the width down.` : `no track width gives ${target} Ω on this stackup`;
      this.zReports.push(rep);
    }
  }
  pairList: Pair[] | null = null; pairReports = new Map<string, PairReport>();
  /** The connections of paired nets that start side by side and end side by side: those run as a pair. */
  private findPairs(): Pair[] {
    const by = new Map<string, { p?: NetInfo; n?: NetInfo }>(); const out: Pair[] = [];
    for (const net of this.nets) { const k = pairName(net.key); if (!k) continue; const e = by.get(k.base) || {}; by.set(k.base, e); if (k.pol > 0) e.p = net; else e.n = net; }
    const d = (a: Anchor, b: Anchor) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); const NEAR = 3;
    for (const e of by.values()) {
      if (!e.p || !e.n) continue; const used = new Set<Conn>();
      for (const cp of e.p.conns) {
        if (cp.len < 2) continue; let best: [number, Conn, boolean] | null = null;
        for (const cn of e.n.conns) {
          if (used.has(cn)) continue; const st = d(cp.a, cn.a) + d(cp.b, cn.b), sw = d(cp.a, cn.b) + d(cp.b, cn.a); const swap = sw < st;
          const [x, y] = swap ? [d(cp.a, cn.b), d(cp.b, cn.a)] : [d(cp.a, cn.a), d(cp.b, cn.b)]; if (x > NEAR || y > NEAR || x < 1e-3 || y < 1e-3) continue;
          if (!best || x + y < best[0]) best = [x + y, cn, swap];
        }
        if (best) {
          used.add(best[1]); const pr: Pair = { p: e.p, n: e.n, cp, cn: best[1], swap: best[2] }; out.push(pr);
          // Each net's tree could as well reach another of its pads on the same side (a USB-C socket has two D+ and
          // two D- pads, interleaved): take the two that sit closest together and the same way round as the far end.
          for (const end of ["a", "b"] as const) {
            const other = end === "a" ? "b" : "a"; const cn = pr.cn, nEnd = (pr.swap ? other : end) as "a" | "b", nOther = (pr.swap ? end : other) as "a" | "b";
            const side = (net: NetInfo, c: Conn, at: "a" | "b"): Anchor[] => {   // the pads this end may move to and the net's tree stays a tree
              const seen = new Set<number>([c[at].cluster]); let grew = true;
              while (grew) { grew = false; for (const o of net.conns) if (o !== c) { const x = o.a.cluster, y = o.b.cluster; if (seen.has(x) !== seen.has(y)) { seen.add(x); seen.add(y); grew = true; } } }
              return (net.anchors || []).filter((a) => seen.has(a.cluster) && a.axis);
            };
            const cps = side(e.p, cp, end), cns = side(e.n, cn, nEnd); const far: Pt = [cp[other].p[0] - cn[nOther].p[0], cp[other].p[1] - cn[nOther].p[1]];
            // the same way round means P on the same side of the run at both ends.  The run leaves each end the way
            // its pads face (out of the part), so a pair that has to come back on itself (a chip whose pins face away
            // from the connector) still compares right; ends turned at odd angles (a QFN at 45°) too.
            const hand = (a: Anchor, b: Anchor): number => { const e = this.outward(a) || this.outward(b); const v: Pt = [a.p[0] - b.p[0], a.p[1] - b.p[1]]; return e ? Math.sign(e[0] * v[1] - e[1] * v[0]) : 0; };
            const farHand = hand(cp[other], cn[nOther]); const side2 = (a: Anchor, b: Anchor) => { const h = hand(a, b); return !!h && !!farHand && h * farHand > 0; };
            let pick: [number, Anchor, Anchor] | null = null;
            for (const a of cps) for (const b of cns) { const dd = d(a, b); if (dd < 1e-3 || dd > NEAR) continue; const sc = dd + (side2(a, b) ? 5 : 0) + 0.05 * (d(a, cp[other]) + d(b, cn[nOther])); if (!pick || sc < pick[0] - 1e-9) pick = [sc, a, b]; }
            if (pick && (pick[1] !== cp[end] || pick[2] !== cn[nEnd])) { cp[end] = pick[1]; cn[nEnd] = pick[2]; cp.len = d(cp.a, cp.b); cn.len = d(cn.a, cn.b); cp.cls = this.classFor(cp.net, Math.min(this.roomAt(cp.a, cp.net), this.roomAt(cp.b, cp.net))); cn.cls = this.classFor(cn.net, Math.min(this.roomAt(cn.a, cn.net), this.roomAt(cn.b, cn.net))); }
          }
        }
      }
    }
    return out;
  }
  /** A differential pair is laid as one: a single wide route down the middle between the two starts and the two
   *  ends, split into two tracks a constant gap apart, each fanned to its own pad.  Every piece is checked exactly;
   *  when the pair cannot be laid this way its nets are routed like any other, and the report says so. */
  layPairs(): void {
    if (this.opts.pairs === false) return; if (!this.pairList) this.pairList = this.findPairs();
    for (const pr of this.pairList) {
      if (pr.cp.nodes || pr.cn.nodes) continue; const key = pr.cp.id + "/" + pr.cn.id;
      const why = this.layPair(pr); if (why) this.pairReports.set(key, { p: pr.p.key, n: pr.n.key, coupled: false, reason: why });
      // a short hop (pads up to 6 mm apart, as from a connector to the ESD part beside it) is too short to need coupling: each line goes straight, the second along the first
      if (why && (Math.max(pr.cp.len, pr.cn.len) <= 6 || (/too close together|turn is too tight|fan-out to the pads/.test(why) && Math.max(pr.cp.len, pr.cn.len) <= 12))) { pr.cp.pairOnly = pr.cn.pairOnly = undefined; pr.cp.partner = pr.cn; pr.cn.partner = pr.cp; }
      else pr.cp.pairOnly = pr.cn.pairOnly = why || undefined;
    }
  }
  /** A pair whose two ends are on different layers: a via pair side by side just off the pads of one end, a short
   *  fan-out from those pads to the vias on their own layer, and from the vias the pair goes on as one coupled run on
   *  the other end's layer.  Both lines change layer at the same place through matched vias. */
  private layPairVias(pr: Pair): string {
    const G = this.G, P = this.P, { cp, cn } = pr; const w = Math.min(cp.cls.width, cn.cls.width), clr = Math.max(cp.cls.clr, cn.cls.clr), gap = Math.max(clr, this.opts.pairGap || 0, this.zGap.get(pr.p.key) || 0);
    const viaD = Math.max(cp.cls.viaD, cn.cls.viaD), drill = Math.max(cp.cls.viaDrill, cn.cls.viaDrill), clrV = Math.max(clr, (G.holeClr || 0) + HOLE_SLACK - (viaD - drill) / 2), pitch = viaD + Math.max(clrV, gap); const all = G.layers.map((_, l) => l).filter((l) => G.routable[l]);
    if (!this.allowVias || !pr.p.guide.allowVias || !pr.n.guide.allowVias) return "its pads are not all on one layer and vias are not allowed";
    const nEnd = (e: "a" | "b"): "a" | "b" => (pr.swap ? (e === "a" ? "b" : "a") : e);
    const half = (a: Anchor) => { const sh = a.shape as any; return sh ? (sh.t === "circle" ? sh.r : Math.max(sh.w || 0, sh.h || 0) / 2 || sh.r || 0) : 0; };
    let why = "its pads are not all on one layer, and there is no room for a via pair beside them";
    for (const end of ["b", "a"] as const) {   // the via pair at one end; the coupled run on the other end's layer
      const other = end === "a" ? "b" : "a"; const pv = cp[end], nv = cn[nEnd(end)], po = cp[other], no = cn[nEnd(other)];
      const mine = all.filter((l) => pv.layers.includes(l) && nv.layers.includes(l)), run = all.filter((l) => po.layers.includes(l) && no.layers.includes(l));
      if (!mine.length || !run.length) continue; const lv = mine[0];
      const mx = (pv.p[0] + nv.p[0]) / 2, my = (pv.p[1] + nv.p[1]) / 2; let ux = nv.p[0] - pv.p[0], uy = nv.p[1] - pv.p[1]; const h = Math.hypot(ux, uy); if (h < 1e-6) continue; ux /= h; uy /= h;
      const tx = (po.p[0] + no.p[0]) / 2 - mx, ty = (po.p[1] + no.p[1]) / 2 - my; let ex = -uy, ey = ux; if (ex * tx + ey * ty < 0) { ex = -ex; ey = -ey; }
      const s1 = Math.max(half(pv), half(nv)) + clr + viaD / 2;
      for (const t of [s1, s1 + 0.3, s1 + 0.6, s1 + 1, s1 + 1.6, s1 + 2.4, s1 + 3.2, s1 + 4]) for (const side of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4]) for (const dir of [1, -1]) for (const bend of [false, true]) {
        const cx = mx + ex * t * dir + ux * side, cy = my + ey * t * dir + uy * side;
        const cell = (x: number, y: number) => ({ ix: Math.round((x - G.ox) / G.g), iy: Math.round((y - G.oy) / G.g) });
        const kp = cell(cx - ux * pitch / 2, cy - uy * pitch / 2), kn = cell(cx + ux * pitch / 2, cy + uy * pitch / 2); const vp = this.mm(kp), vn = this.mm(kn);
        if (Math.hypot(vp[0] - vn[0], vp[1] - vn[1]) < viaD + clr - 1e-6) continue;
        const via = (q: Pt): Shape => ({ t: "circle", x: q[0], y: q[1], r: viaD / 2 } as Shape), stub = (a: Pt, b: Pt) => ({ t: "seg", a, b, r: w / 2 } as Shape & { a: Pt; b: Pt });
        // each line leaves its pad straight out past the pad's end, then turns to its via
        const fan = (a: Anchor, v: Pt) => { const o = half(a) + w / 2 + 0.05, q: Pt = [r6(a.p[0] + ex * dir * o), r6(a.p[1] + ey * dir * o)]; return !bend || (q[0] - a.p[0]) * (v[0] - a.p[0]) + (q[1] - a.p[1]) * (v[1] - a.p[1]) < o * o ? [stub(a.p, v)] : [stub(a.p, q), stub(q, v)]; };
        const sp = fan(pv, vp), sn = fan(nv, vn); const gapOK = (xs: Shape[], ys: Shape[]) => xs.every((x) => ys.every((y) => P.shapeGap(x, y) >= clr - 1e-4));
        if (!gapOK(sp, sn) || !gapOK(sp, [via(vn)]) || !gapOK(sn, [via(vp)])) continue;
        this.cur = cp; this.curSoft = false; if (!all.every((l) => this.clearOf(via(vp), l, pr.p.key, clrV)) || !sp.every((x) => this.clearOf(x, lv, pr.p.key, clr))) continue;
        this.cur = cn; if (!all.every((l) => this.clearOf(via(vn), l, pr.n.key, clrV)) || !sn.every((x) => this.clearOf(x, lv, pr.n.key, clr))) continue;
        // the vias stand in for that end's pads while the coupled run is laid
        const keepP = cp[end], keepN = cn[nEnd(end)];
        cp[end] = { p: vp, layers: run.slice(), shape: via(vp), cluster: keepP.cluster, grp: keepP.grp };
        cn[nEnd(end)] = { p: vn, layers: run.slice(), shape: via(vn), cluster: keepN.cluster, grp: keepN.grp };
        let r = ""; try { r = this.layPair(pr); } finally { cp[end] = keepP; cn[nEnd(end)] = keepN; }
        if (r === "the two ends are too close together for a coupled run" && run.length) {   // the vias are right by the other end's pads: two short straight tracks
          const l = run[0], tp = stub(vp, po.p), tn = stub(vn, no.p);
          this.cur = cp; const okP = P.shapeGap(tp, tn) >= clr - 1e-4 && P.shapeGap(tp, via(vn)) >= clr - 1e-4 && P.shapeGap(tn, via(vp)) >= clr - 1e-4 && this.clearOf(tp, l, pr.p.key, clr); this.cur = cn; const okN = okP && this.clearOf(tn, l, pr.n.key, clr);
          if (okN) {
            const set = (c: Conn, sh: Shape) => { const nodes: Node[] = [{ ...cell(sh.a[0], sh.a[1]), l }, { ...cell(sh.b[0], sh.b[1]), l }]; c.shapes = [{ net: c.net, layers: [l], shape: sh, clr: c.cls.clr }]; c.nodes = nodes; c.viaCells = []; c.stubs = []; c.feat = featuresOf(G, nodes, this.pref); c.landed = -1; c.zoneEnd = false; c.pair = true; c.rips = 99; c.why = undefined; this.place(c, 1); };
            set(cp, tp as any); set(cn, tn as any); const lp = Math.hypot(tp.a[0] - tp.b[0], tp.a[1] - tp.b[1]), ln = Math.hypot(tn.a[0] - tn.b[0], tn.a[1] - tn.b[1]);
            this.pairReports.set(cp.id + "/" + cn.id, { p: pr.p.key, n: pr.n.key, coupled: true, layer: G.layers[l], width: w, gap: +gap.toFixed(4), lengthP: +lp.toFixed(3), lengthN: +ln.toFixed(3), skew: +Math.abs(lp - ln).toFixed(3) }); r = "";
          }
        }
        if (r) { why = "its pads are not all on one layer, and from the via pair: " + r; continue; }
        // the run must keep clear of the other line's via and fan-out too
        const clash = cp.shapes.some((o) => P.shapeGap(o.shape, via(vn)) < clr - 1e-4 || (o.layers[0] === lv && !gapOK([o.shape], sn))) || cn.shapes.some((o) => P.shapeGap(o.shape, via(vp)) < clr - 1e-4 || (o.layers[0] === lv && !gapOK([o.shape], sp)));
        if (clash) { this.rip(cp); this.rip(cn); this.pairReports.delete(cp.id + "/" + cn.id); why = "its pads are not all on one layer, and the run would crowd the via pair"; continue; }
        const add = (c: Conn, sh: (Shape & { a: Pt; b: Pt })[], v: Pt, k: { ix: number; iy: number }) => { this.place(c, -1); let len = 0; for (const x of sh) { c.shapes.push({ net: c.net, layers: [lv], shape: x, clr: c.cls.clr }); len += Math.hypot(x.a[0] - x.b[0], x.a[1] - x.b[1]); } c.shapes.push({ net: c.net, layers: all.slice(), shape: via(v), clr: clrV }); c.viaCells = [k.iy * G.W + k.ix]; this.place(c, 1); return len; };
        const ap = add(cp, sp, vp, kp), an = add(cn, sn, vn, kn); const rep = this.pairReports.get(cp.id + "/" + cn.id);
        if (rep) { rep.lengthP = +((rep.lengthP || 0) + ap).toFixed(3); rep.lengthN = +((rep.lengthN || 0) + an).toFixed(3); rep.skew = +Math.abs(rep.lengthP - rep.lengthN).toFixed(3); (rep as any).vias = 2; }
        return "";
      }
    }
    return why;
  }
  /** The two tracks of a pair from its centre line: each a constant distance to one side, mitred at the turns, and
   *  fanned to its own pads at the ends — checked exactly against each other and against everything around.
   *  Returns the two polylines, or why they cannot be. */
  /** The width of each piece of one line of a pair: the coupled run at `w`, the two short fan-out pieces at its ends
   *  necked down where the chip's pins stand closer than two tracks and a gap (a USB pair into a 0.4 mm QFN). */
  private pairWidth(pr: Pair, t: Pt[], k: number, w: number, clr: number): number {
    if (k !== 0 && k !== t.length - 2) return w;
    const { cp, cn } = pr; const at = k === 0 ? [cp.a, pr.swap ? cn.b : cn.a] : [cp.b, pr.swap ? cn.a : cn.b];
    const pitch = Math.hypot(at[0].p[0] - at[1].p[0], at[0].p[1] - at[1].p[1]); const floor = Math.max(this.s.minTrackWidth || 0, 0.1);
    return Math.max(floor, Math.min(w, Math.floor((pitch - clr) * 1000 - 1e-6) / 1000));
  }
  private pairTracks(pr: Pair, c: Pt[], l: number, w: number, d: number, clr: number, sgn: number, lead: Lead[]): { tp: Pt[]; tn: Pt[] } | string {
    const P = this.P, { cp, cn } = pr; const Pa = cp.a, Pb = cp.b, Na = pr.swap ? cn.b : cn.a, Nb = pr.swap ? cn.a : cn.b;
    const dir = (i: number): Pt => { const x = c[i + 1][0] - c[i][0], y = c[i + 1][1] - c[i][1], h = Math.hypot(x, y); return [x / h, y / h]; };
    const off = (sg: number): Pt[] | null => {
      const out: Pt[] = [];
      for (let i = 0; i < c.length; i++) {
        const u0 = i > 0 ? dir(i - 1) : dir(0), u1 = i < c.length - 1 ? dir(i) : dir(c.length - 2); const n0: Pt = [-u0[1], u0[0]], n1: Pt = [-u1[1], u1[0]]; const k = 1 + n0[0] * n1[0] + n0[1] * n1[1]; if (k < 0.2) return null;
        out.push([r6(c[i][0] + sg * d * (n0[0] + n1[0]) / k), r6(c[i][1] + sg * d * (n0[1] + n1[1]) / k)]);
      }
      for (let i = 0; i + 1 < out.length; i++) { const u = dir(i); if ((out[i + 1][0] - out[i][0]) * u[0] + (out[i + 1][1] - out[i][1]) * u[1] < 0.02) return null; }   // a piece too short to carry the turn
      return out;
    };
    const segs = (t: Pt[]) => { const o: Shape[] = []; for (let i = 0; i + 1 < t.length; i++) if (Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]) > 1e-4) o.push({ t: "seg", a: t[i], b: t[i + 1], r: this.pairWidth(pr, t, i, w, clr) / 2 } as Shape); return o; };
    const op = off(sgn), on = off(-sgn); if (!op || !on) return "a turn is too tight for the pair";
    const out = (a: Anchor, ld: Lead): Pt => [r6(a.p[0] + ld.e[0] * ld.s), r6(a.p[1] + ld.e[1] * ld.s)];
    const tp = [Pa.p, out(Pa, lead[0]), ...op, out(Pb, lead[1]), Pb.p], tn = [Na.p, out(Na, lead[0]), ...on, out(Nb, lead[1]), Nb.p]; const sp = segs(tp), sn = segs(tn);
    if (sp.some((a) => sn.some((b) => P.shapeGap(a, b) < clr - 1e-4))) { if ((this.opts as any).debugPairs) { const bad: string[] = []; sp.forEach((a, i) => sn.forEach((b, j) => { const g = P.shapeGap(a, b); if (g < clr - 1e-4) bad.push(`${i}/${sp.length}-${j}/${sn.length}:${g.toFixed(3)}`); })); console.log("   clash", bad.join(" "), JSON.stringify(tp.slice(-4)), JSON.stringify(tn.slice(-4))); } return "the fan-out to the pads brings the two tracks too close"; }
    this.cur = Object.assign({}, cp); this.curSoft = false;
    if (!sp.every((sh) => this.clearOf(sh, l, pr.p.key, cp.cls.clr)) || !sn.every((sh) => this.clearOf(sh, l, pr.n.key, cn.cls.clr))) return "a piece of the pair would not keep its clearance";
    return { tp, tn };
  }
  private layPair(pr: Pair): string {
    const G = this.G, P = this.P, { cp, cn } = pr; const w = Math.min(cp.cls.width, cn.cls.width), clr = Math.max(cp.cls.clr, cn.cls.clr); const gap = Math.max(clr, this.opts.pairGap || 0, this.zGap.get(pr.p.key) || 0), d = (w + gap) / 2;
    const Pa = cp.a, Pb = cp.b, Na = pr.swap ? cn.b : cn.a, Nb = pr.swap ? cn.a : cn.b;
    const layers = G.layers.map((_, l) => l).filter((l) => G.routable[l] && [Pa, Pb, Na, Nb].every((a) => a.layers.includes(l)));
    if (!layers.length) return this.layPairVias(pr);
    const key = `pair/${w}/${gap}/${clr}` + (cp.cls.open === false ? "/q" : ""); let wide = G.classes.get(key);
    if (!wide) { wide = buildClass(G, key, 2 * w + gap, clr, cp.cls.viaD, cp.cls.viaDrill, cp.cls.kind, cp.cls.open !== false, !!cp.cls.feed); for (const o of this.conns) if (o.nodes) for (const sh of o.shapes) stampClass(G, wide, sh, 1, false); }
    const half = (a: Anchor) => { const sh = a.shape as any; return sh ? (sh.t === "circle" ? sh.r : Math.max(sh.w || 0, sh.h || 0) / 2 || sh.r || 0) : 0; };
    // Each end gathers the pair a little way off its pads, square to the line between them, on either side of it.
    const gather = (a: Anchor, b: Anchor, toward: Anchor): { g: Anchor; e: Pt; q: Pt; s: number }[] => {
      const mx = (a.p[0] + b.p[0]) / 2, my = (a.p[1] + b.p[1]) / 2; let ex = -(a.p[1] - b.p[1]), ey = a.p[0] - b.p[0]; const h = Math.hypot(ex, ey); ex /= h; ey /= h;
      // each track runs straight off its pad to just past the pad's end, turns in at 45° until the two are side by side (q), and from there they go on together to the gathering point
      const s1 = Math.max(half(a), half(b)) + clr * 0.7, jog = Math.max(0, h / 2 - d);
      // straight out first; then a little to either side, where something stands right in front of the pads
      const out: { g: Anchor; e: Pt; q: Pt; s: number }[] = [];
      const fwd = (toward.p[0] - mx) * ex + (toward.p[1] - my) * ey >= 0 ? 1 : -1;   // first the side that faces the other end
      for (const sh of [0, 0.4, -0.4, 0.8, -0.8]) for (const sg of [fwd, -fwd]) { const tq = s1 + jog + Math.abs(sh) + 0.05, t = tq + 2 * d + 0.1 + G.g; const ox = mx - ey * sh, oy = my + ex * sh; const p: Pt = [r6(ox + ex * t * sg), r6(oy + ey * t * sg)]; out.push({ g: { p, layers, shape: { t: "circle", x: p[0], y: p[1], r: G.g * 1.5 } as Shape, cluster: 0 }, e: [ex * sg, ey * sg] as Pt, q: [r6(ox + ex * tq * sg), r6(oy + ey * tq * sg)] as Pt, s: s1 }); }
      return out;
    };
    let why = "there is no room for the two tracks side by side", close = "";
    this.lift(pr.p, 1, wide); this.lift(pr.n, 1, wide); let laid: { l: number; nodes: Node[]; feat: Features; tp: Pt[]; tn: Pt[] } | null = null;
    // the pair leaves a gathering point away from its pads, never back over them
    const wall = (m: Uint16Array, at: { g: Anchor; e: Pt }, cell: Terminal, sign: number) => {
      const R = Math.max(1.5, Math.hypot(Pa.p[0] - Na.p[0], Pa.p[1] - Na.p[1])), n = Math.ceil(R / G.g), cx = cell.ix, cy = cell.iy;   // behind the cell the pair really starts from
      for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) { const ix = cx + dx, iy = cy + dy; if (ix < 0 || iy < 0 || ix >= G.W || iy >= G.H) continue; if ((dx * at.e[0] + dy * at.e[1]) * G.g < -G.g * 0.6) m[iy * G.W + ix] += sign; }
    };
    try {
      this.cur = Object.assign({}, cp, { cls: wide }); this.curSoft = false;
      // Two ends that face each other at close range (series resistors right behind a connector) need no search: the
      // pair goes straight across from where one end has gathered to where the other has.
      for (const l of layers) {
        if (laid) break; const ga = gather(Pa, Na, Pb)[0], gb = gather(Pb, Nb, Pa)[0]; const span = Math.hypot(gb.q[0] - ga.q[0], gb.q[1] - ga.q[1]); if (span < 0.1 || span > 6) continue;
        const cell = (q: Pt): Node => ({ ix: Math.round((q[0] - G.ox) / G.g), iy: Math.round((q[1] - G.oy) / G.g), l }); const nodes = [cell(ga.q), cell(gb.q)]; const lead: Lead[] = [{ e: ga.e, s: ga.s }, { e: gb.e, s: gb.s }];
        for (const L1 of [0.4, 0.3, 0.2]) {   // a short piece straight on at each end, so the two tracks stand square to their pads where they meet them
          if (laid) break; const a1: Pt = [r6(ga.q[0] + ga.e[0] * L1), r6(ga.q[1] + ga.e[1] * L1)], b1: Pt = [r6(gb.q[0] + gb.e[0] * L1), r6(gb.q[1] + gb.e[1] * L1)];
          const along = (b1[0] - a1[0]) * ga.e[0] + (b1[1] - a1[1]) * ga.e[1], across = Math.abs((b1[0] - a1[0]) * ga.e[1] - (b1[1] - a1[1]) * ga.e[0]);
          if (along < 0.02 || (a1[0] - b1[0]) * gb.e[0] + (a1[1] - b1[1]) * gb.e[1] < 0.02 || across > along * 1.2 + 0.02) { close = "the two ends are too close together for a coupled run"; continue; }   // no sideways dog-leg for the sake of a millimetre of pair
          const c: Pt[] = [ga.q, a1, b1, gb.q];
          for (const sgn of [1, -1]) { const r = this.pairTracks(pr, c, l, w, d, clr, sgn, lead); if (typeof r === "string") { why = r; if ((this.opts as any).debugPairs) console.log("  direct", L1, sgn, r); continue; } pr.laid = { c, l, w, d, clr, sgn, lead }; laid = { l, nodes, feat: featuresOf(G, nodes, this.pref), tp: r.tp, tn: r.tn }; break; }
        }
      }
      let tries = 0;
      search: for (const l of layers) for (const ga of gather(Pa, Na, Pb)) for (const gb of gather(Pb, Nb, Pa)) {
        if (laid) break search;
        this.cur = Object.assign({}, cp, { cls: wide }); this.curSoft = false;
        const rt = G.routable.map((_, i) => i === l); const src = this.access(ga.g, wide.full, rt), tgt = this.access(gb.g, wide.full, rt); if ((this.opts as any).debugPairs) console.log("combo", pr.p.key, JSON.stringify(ga.g.p), JSON.stringify(gb.g.p), !!src, !!tgt); if (!src || !tgt) continue;
        wall(wide.full[l], ga, src, 1); wall(wide.full[l], gb, tgt, 1); let res: ProbeResult | null = null;
        try { if (!wide.full[l][src.iy * G.W + src.ix] && !wide.full[l][tgt.iy * G.W + tgt.ix]) res = probe({ G, maps: wide.full, vmaps: wide.vfull, src, tgt, term: [], win: { x0: 0, y0: 0, x1: G.W - 1, y1: G.H - 1 }, pref: this.pref, W: this.W, allowVias: false, maxSteps: 6e6, routable: rt }); }
        finally { wall(wide.full[l], ga, src, -1); wall(wide.full[l], gb, tgt, -1); }
        if ((this.opts as any).debugPairs) console.log("  probe", !!res);
        if (!res) continue; if (++tries > 12) break search;
        const nodes = this.mitre(simplify(res.nodes), wide.full); let c: Pt[] = []; for (const n of nodes) { const q = this.mm(n); if (!c.length || Math.hypot(q[0] - c[c.length - 1][0], q[1] - c[c.length - 1][1]) > 1e-6) c.push(q); }
        if (c.length < 2) continue;
        if (Math.hypot(c[0][0] - ga.g.p[0], c[0][1] - ga.g.p[1]) > Math.hypot(c[c.length - 1][0] - ga.g.p[0], c[c.length - 1][1] - ga.g.p[1])) c = c.slice().reverse();
        // the lead-in runs exactly along the pads' axis into the gathering cell, wherever the grid put that cell
        const back = (p: Pt, e: Pt): Pt => [r6(p[0] - e[0] * (2 * d + 0.1 + G.g)), r6(p[1] - e[1] * (2 * d + 0.1 + G.g))];
        c = [back(c[0], ga.e), ...c, back(c[c.length - 1], gb.e)];
        for (const sgn of [1, -1]) {   // which track is whose: the way round in which the two fans do not cross
          const lead: Lead[] = [{ e: ga.e, s: ga.s }, { e: gb.e, s: gb.s }];
          const r = this.pairTracks(pr, c, l, w, d, clr, sgn, lead); if (typeof r === "string") { why = r; if ((this.opts as any).debugPairs) console.log("  fail", sgn, r, JSON.stringify(c)); continue; }
          const tp = r.tp, tn = r.tn; pr.laid = { c, l, w, d, clr, sgn, lead };
          laid = { l, nodes, feat: res.feat, tp, tn }; break search;
        }
      }
    } finally { this.lift(pr.n, -1, wide); this.lift(pr.p, -1, wide); }
    if (!laid) return close || why;
    const put = (c: Conn, t: Pt[]) => {
      c.shapes = []; for (let i = 0; i + 1 < t.length; i++) if (Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]) > 1e-4) c.shapes.push({ net: c.net, layers: [laid!.l], shape: { t: "seg", a: t[i], b: t[i + 1], r: this.pairWidth(pr, t, i, w, clr) / 2 } as Shape, clr: c.cls.clr });
      c.nodes = laid!.nodes; c.viaCells = []; c.stubs = []; c.feat = laid!.feat; c.landed = -1; c.zoneEnd = false; c.pair = true; c.rips = 99; c.why = undefined; this.place(c, 1);
      let len = 0; for (let i = 0; i + 1 < t.length; i++) len += Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]); return len;
    };
    const lp = put(cp, laid.tp), ln = put(cn, laid.tn);
    this.pairReports.set(cp.id + "/" + cn.id, { p: pr.p.key, n: pr.n.key, coupled: true, layer: G.layers[laid.l], width: w, gap: +gap.toFixed(4), lengthP: +lp.toFixed(3), lengthN: +ln.toFixed(3), skew: +Math.abs(lp - ln).toFixed(3) });
    return "";
  }
  // ------------------------------------------------------------------ length matching
  matchReports: MatchReport[] = [];
  /** A run of n serpentine humps on the piece a→b, swinging A to one side: square humps S wide and S apart with
   *  chamfered corners.  Each adds 2A − 2.343·ch to the length. */
  private humps(a: Pt, b: Pt, n: number, A: number, S: number, ch: number, side: number): Pt[] {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy * side, ny = ux * side;
    const at = (x: number, y: number): Pt => [r6(a[0] + ux * x + nx * y), r6(a[1] + uy * x + ny * y)]; const out: Pt[] = [a]; const s0 = (L - (2 * n - 1) * S) / 2;
    for (let k = 0; k < n; k++) { const x = s0 + 2 * k * S; out.push(at(x - ch, 0), at(x, ch), at(x, A - ch), at(x + ch, A), at(x + S - ch, A), at(x + S, A - ch), at(x + S, ch), at(x + S + ch, 0)); }
    out.push(b); return out;
  }
  /** For the last fraction of a millimetre: n shallow bumps with 45° flanks, each a high and r long on top.  Each
   *  adds 0.828·a. */
  private bumps(a: Pt, b: Pt, n: number, h: number, r: number, side: number): Pt[] {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy * side, ny = ux * side;
    const at = (x: number, y: number): Pt => [r6(a[0] + ux * x + nx * y), r6(a[1] + uy * x + ny * y)]; const out: Pt[] = [a]; const one = 2 * h + r, s0 = (L - n * one - (n - 1) * r) / 2;
    for (let k = 0; k < n; k++) { const x = s0 + k * (one + r); out.push(at(x, 0), at(x + h, h), at(x + h + r, h), at(x + one, 0)); }
    out.push(b); return out;
  }
  /** The serpentines to try on a straight piece L long for `left` mm more: deep square humps first, then more and
   *  shallower ones, and shallow bumps when what is missing is less than the smallest hump adds. */
  private meanders(a: Pt, b: Pt, L: number, left: number, tol: number, g: { S: number; ch: number; Amin: number; Amax: number; m: number; hmin: number }): { pts: Pt[]; gain: number }[] {
    const out: { pts: Pt[]; gain: number }[] = []; const kk = 2.343 * g.ch; const nmax = Math.floor(((L - 2 * g.m) / g.S + 1) / 2);
    for (const cap of [g.Amax, g.Amax / 2, g.Amax / 4, g.Amax / 8, g.Amin]) {
      if (cap < g.Amin - 1e-9 || nmax < 1) continue;
      let n = Math.min(nmax, Math.max(1, Math.ceil(left / (2 * cap - kk)))); let A = Math.min(cap, (left / n + kk) / 2);
      if (A < g.Amin) { A = g.Amin; if (n * (2 * A - kk) > left + tol) n = Math.floor((left + tol) / (2 * A - kk)); if (n < 1) continue; }
      for (const side of [1, -1]) out.push({ pts: this.humps(a, b, n, A, g.S, g.ch, side), gain: n * (2 * A - kk) });
    }
    if (left < 2 * g.Amin - kk + tol) for (const n of [1, 2, 3]) {
      const h = left / (0.8284 * n), r = Math.max(g.hmin * 2, 0.2); if (h < g.hmin || h > g.Amax || n * (2 * h + r) + (n - 1) * r + 2 * g.m > L) continue;
      for (const side of [1, -1]) out.push({ pts: this.bumps(a, b, n, h, r, side), gain: left });
    }
    return out;
  }
  private static lenOf(c: Conn): number { let len = 0; for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "seg") len += Math.hypot(sh.a[0] - sh.b[0], sh.a[1] - sh.b[1]); } return len; }
  /** Lengthen one track by `extra` with serpentines on its longest straight pieces; returns what is still missing. */
  private extend(c: Conn, extra: number, tol: number): number {
    const w = c.cls.width, clr = c.cls.clr, Amax = this.opts.maxAmplitude || 3; const ch = Math.max(0.1, w / 2), S = Math.max(w + 2 * clr, 3 * w, 2 * ch + 0.1), Amin = 2 * ch + 0.05, m = ch + 0.1;
    let left = extra;
    for (let round = 0; round < 6 && left > tol; round++) {
      const cand = c.shapes.map((o, i) => ({ o, i, L: (o.shape as any).t === "seg" ? Math.hypot((o.shape as any).a[0] - (o.shape as any).b[0], (o.shape as any).a[1] - (o.shape as any).b[1]) : 0 })).filter((x) => x.L >= S + 2 * m).sort((x, y) => y.L - x.L);
      let done = false;
      for (const { o, i, L } of cand) {
        const sh = o.shape as any;
        for (const cand2 of this.meanders(sh.a, sh.b, L, left, tol, { S, ch, Amin, Amax, m, hmin: Math.max(0.1, w / 2) })) {
          const pts = cand2.pts; const add: Obstacle[] = []; for (let k = 0; k + 1 < pts.length; k++) add.push({ net: c.net, layers: o.layers, shape: { t: "seg", a: pts[k], b: pts[k + 1], r: sh.r } as Shape, clr: o.clr });
          this.place(c, -1); const keep = c.shapes; c.shapes = []; this.cur = c; this.curSoft = false;
          const ok = add.every((x) => this.clearOf(x.shape, o.layers[0], c.net, clr));
          c.shapes = ok ? keep.slice(0, i).concat(add, keep.slice(i + 1)) : keep; this.place(c, 1);
          if (ok) { left -= cand2.gain; c.pair = true; done = true; break; }
        }
        if (done) break;
      }
      if (!done) break;
    }
    return left;
  }
  /** Lengthen a coupled pair: the serpentine is put on its centre line, so the two tracks swing together. */
  private extendPair(pr: Pair, extra: number, tol: number): number {
    const Ld = pr.laid!; const { cp, cn } = pr; const w = Ld.w, d = Ld.d, Wt = 2 * d + w, Amax = this.opts.maxAmplitude || 3;
    const ch = Math.max(0.15, 0.6 * d + 0.06), S = Math.max(Wt + 2 * Ld.clr, 2 * ch + d + 0.1), Amin = 2 * ch + d + 0.05, m = ch + d + 0.1; let left = extra;
    const total = () => (Router.lenOf(cp) + Router.lenOf(cn)) / 2;
    for (let round = 0; round < 6 && left > tol; round++) {
      const c = Ld.c; const cand: { i: number; L: number }[] = []; for (let i = 1; i + 2 < c.length; i++) { const L = Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]); if (L >= S + 2 * m) cand.push({ i, L }); }
      cand.sort((x, y) => y.L - x.L); let done = false;
      for (const { i, L } of cand) {
        for (const cand2 of this.meanders(c[i], c[i + 1], L, left, tol, { S, ch, Amin, Amax, m, hmin: 0.6 * d + 0.06 })) {
          const c2 = c.slice(0, i).concat(cand2.pts, c.slice(i + 2)); const before = total();
          this.place(cp, -1); this.place(cn, -1); const kp = cp.shapes, kn = cn.shapes; cp.shapes = []; cn.shapes = [];
          const r = this.pairTracks(pr, c2, Ld.l, w, d, Ld.clr, Ld.sgn, Ld.lead);
          if (typeof r === "string") { cp.shapes = kp; cn.shapes = kn; this.place(cp, 1); this.place(cn, 1); continue; }
          const set = (cc: Conn, t: Pt[]) => { for (let k = 0; k + 1 < t.length; k++) if (Math.hypot(t[k + 1][0] - t[k][0], t[k + 1][1] - t[k][1]) > 1e-4) cc.shapes.push({ net: cc.net, layers: [Ld.l], shape: { t: "seg", a: t[k], b: t[k + 1], r: this.pairWidth(pr, t, k, w, Ld.clr) / 2 } as Shape, clr: cc.cls.clr }); this.place(cc, 1); };
          set(cp, r.tp); set(cn, r.tn); Ld.c = c2; left -= total() - before; done = true; break;
        }
        if (done) break;
      }
      if (!done) break;
    }
    return left;
  }
  /** Bring the members of each matched group to one length, then take out what skew is left inside each pair. */
  tune(): void {
    const tolOf = (t?: number) => t !== undefined && t > 0 ? t : 0.25; const pairs = (this.pairList || []).filter((pr) => pr.cp.pair && pr.cn.pair && pr.laid && pr.cp.nodes && pr.cn.nodes);
    interface Member { nets: string[]; pr?: Pair; conns: Conn[] }
    const lenM = (mb: Member) => mb.pr ? (Router.lenOf(mb.pr.cp) + Router.lenOf(mb.pr.cn)) / 2 : mb.conns.reduce((a, c) => a + (c.nodes ? Router.lenOf(c) : 0), 0);
    const groups: { name: string; members: Member[]; tol: number; length?: number }[] = [];
    for (const g of this.opts.match || []) {
      const members: Member[] = []; const taken = new Set<string>();
      for (const pr of pairs) if (g.nets.includes(pr.p.key) && g.nets.includes(pr.n.key)) { members.push({ nets: [pr.p.key, pr.n.key], pr, conns: [pr.cp, pr.cn] }); taken.add(pr.p.key); taken.add(pr.n.key); }
      for (const k of g.nets) if (!taken.has(k)) { const net = this.nets.find((n) => n.key === k); if (net && net.conns.some((c) => c.nodes)) members.push({ nets: [k], conns: net.conns.filter((c) => c.nodes) }); }
      if (members.length) groups.push({ name: g.nets.join(", "), members, tol: tolOf(g.tolerance), length: g.length });
    }
    // the lanes of one bus (HDMI_D0…D2 and the clock, ETH_TX and ETH_RX): pairs that share the name in front of the lane
    const planned = new Set((this.opts.match || []).flatMap((g) => g.nets)); const bus = new Map<string, Member[]>();
    for (const pr of pairs) { if (planned.has(pr.p.key)) continue; const k = pairName(pr.p.key)!.base.replace(/~.*$/, "").replace(/[_\-]?(D|TX|RX|TD|RD|CLK|CK|LANE|L|MDI|DATA|TMDS)?_?\d*$/i, "").replace(/[_\-]+$/, ""); if (!k || /^\/?$/.test(k)) continue; const e = bus.get(k) || []; bus.set(k, e); e.push({ nets: [pr.p.key, pr.n.key], pr, conns: [pr.cp, pr.cn] }); }
    for (const [k, members] of bus) if (members.length > 1) groups.push({ name: k, members, tol: 0.25 });
    // DDR memory: each byte lane (DQ0–7 with its DM, DQ8–15 …) to the length of its strobe pair, and the address,
    // bank and command lines as one group to the length of the clock pair; a group per memory (the name in front)
    {
      const bare = (k: string) => k.replace(/^.*\//, ""); const memOf = new Map<string, { lanes: Map<number, Member[]>; cmd: Member[] }>(); const has = new Set<string>();
      const later: [string, Member][] = []; const mem = (pre: string) => { let m = memOf.get(pre); if (!m) memOf.set(pre, m = { lanes: new Map(), cmd: [] }); return m; };
      const lane = (pre: string, n: number) => { const m = mem(pre); let l = m.lanes.get(n); if (!l) m.lanes.set(n, l = []); return l; };
      for (const pr of pairs) { if (planned.has(pr.p.key)) continue; const b = bare(pairName(pr.p.key)!.base.replace(/~.*$/, "")); let q = /^(.*?)_?(?:L|U)?DQS_?(\d*)_?$/i.exec(b);
        if (q) { lane(q[1], q[2] ? +q[2] : /UDQS/i.test(b) ? 1 : 0).push({ nets: [pr.p.key, pr.n.key], pr, conns: [pr.cp, pr.cn] }); has.add(q[1]); continue; }
        q = /^(.*?)_?(?:CK|CLK|MEM_?CLK)_?\d?_?$/i.exec(b); if (q && /DDR|MEM|SDRAM|DRAM/i.test(pr.p.key + q[1]) || (q && memOf.has(q[1]))) { mem(q![1]).cmd.unshift({ nets: [pr.p.key, pr.n.key], pr, conns: [pr.cp, pr.cn] }); has.add(q![1]); } }
      for (const net of this.nets) { if (planned.has(net.key) || !net.conns.some((c) => c.nodes) || this.pairList?.some((pr) => pr.p === net || pr.n === net)) continue; const b = bare(net.key); const mb: Member = { nets: [net.key], conns: net.conns.filter((c) => c.nodes) };
        let q = /^(.*?)_?DQ_?(\d+)$/i.exec(b); if (q) { lane(q[1], Math.floor(+q[2] / 8)).push(mb); continue; }
        q = /^(.*?)_?(?:L|U)?DQM?_?(\d*)$/i.exec(b); if (q && /DM|DQM/i.test(b)) { lane(q[1], q[2] ? +q[2] : /UDM/i.test(b) ? 1 : 0).push(mb); continue; }
        q = /^(.*?)_?(A\d+|BA\d|RAS|CAS|WE|CS\d?|CKE\d?|ODT\d?|RESET)_?N?$/i.exec(b); if (q) later.push([q[1], mb]); }
      for (const [pre, mb] of later) if (memOf.has(pre)) mem(pre).cmd.push(mb);
      for (const [pre, m] of memOf) { if (!has.has(pre)) continue;
        for (const [n, members] of m.lanes) if (members.length > 1) groups.push({ name: `${pre || "DDR"} byte lane ${n}`, members, tol: 0.5 });
        if (m.cmd.length > 1) groups.push({ name: `${pre || "DDR"} address and command`, members: m.cmd, tol: 1 }); }
    }
    for (const g of groups) {
      const before = g.members.map(lenM); const target = g.length && g.length > 0 ? g.length : Math.max(...before);
      const rep: MatchReport = { group: g.name, target: +target.toFixed(3), tolerance: g.tol, members: [] }; this.matchReports.push(rep);
      g.members.forEach((mb, i) => {
        const need = target - before[i]; let left = need;
        if (need > g.tol) left = mb.pr ? this.extendPair(mb.pr, need, g.tol / 2) : this.extend(mb.conns.slice().sort((a, b) => Router.lenOf(b) - Router.lenOf(a))[0], need, g.tol / 2);
        const now = lenM(mb); const ok = Math.abs(target - now) <= g.tol + 1e-6;
        rep.members.push({ nets: mb.nets, before: +before[i].toFixed(3), length: +now.toFixed(3), matched: ok, note: ok ? undefined : need < 0 ? "longer than the length asked for" : `no room for ${left.toFixed(2)} mm more of serpentine beside its track` });
      });
    }
    const skewTol = this.opts.skewTolerance !== undefined ? this.opts.skewTolerance : 0.1;
    for (const pr of pairs) {
      const lp = Router.lenOf(pr.cp), ln = Router.lenOf(pr.cn); if (Math.abs(lp - ln) > skewTol) this.extend(lp < ln ? pr.cp : pr.cn, Math.abs(lp - ln), skewTol / 2);
      const rep = this.pairReports.get(pr.cp.id + "/" + pr.cn.id); if (rep) { rep.lengthP = +Router.lenOf(pr.cp).toFixed(3); rep.lengthN = +Router.lenOf(pr.cn).toFixed(3); rep.skew = +Math.abs(rep.lengthP - rep.lengthN).toFixed(3); }
    }
    this.oidx = null;
  }
  private viaCap = Infinity;
  /** The repair ladder's rescue (ladder.ts): vias allowed above a connection's limit, and no steering by the plan. */
  private extraVias = 0; private noSteer = false; private ladderRep: LadderReport | null = null;
  private cur: Conn | null = null; private curSoft = false; private oidx: Map<string, { o: Obstacle; bb: number[] }[]> | null = null;
  /** Exact: does a piece of track keep its clearance to the board's copper, holes and edges, and to this run's routes? */
  private clearOf(shape: Shape, layer: number, net: string, clr: number, why?: { net: string; gap: number; need: number }): boolean {
    const G = this.G, P = this.P, B = 2; const bbOf = (s: Shape): number[] => s.t === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : s.t === "seg" ? [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r] : null as any;
    this.index();
    const bb = bbOf(shape); const m = Math.max(clr, this.s.clearance, G.edgeClr) + 0.3; const seen = new Set<any>();
    for (let y = Math.floor((bb[1] - m) / B); y <= Math.floor((bb[3] + m) / B); y++) for (let x = Math.floor((bb[0] - m) / B); x <= Math.floor((bb[2] + m) / B); x++) for (const e of this.oidx!.get(x + "," + y) || []) {
      if (seen.has(e)) continue; seen.add(e); if (e.o.net && e.o.net === net) continue; if (!e.o.layers.includes(layer)) continue;
      const need = (e.o.edge ? G.edgeClr : Math.max(e.o.clr, clr)) - 5e-5; if (e.bb[0] > bb[2] + need || e.bb[2] < bb[0] - need || e.bb[1] > bb[3] + need || e.bb[3] < bb[1] - need) continue;
      const gap = P.shapeGap(e.o.shape, shape); if (gap < need) { if (why) { why.net = e.o.net; why.gap = gap; why.need = need + 5e-5; } return false; }
    }
    if (!this.curSoft) for (const c of this.conns) {
      if (!c.nodes || c.net === net) continue; const need = Math.max(c.cls.clr, clr) - 5e-5;
      for (const o of c.shapes) { if (!o.layers.includes(layer)) continue; const ob = bbOf(o.shape); if (ob[0] > bb[2] + need || ob[2] < bb[0] - need || ob[1] > bb[3] + need || ob[3] < bb[1] - need) continue; if (P.shapeGap(o.shape, shape) < need) return false; }
    }
    return true;
  }
  /** Islands of a net joined by the routes laid so far. */
  private components(net: NetInfo): number[] {
    const parent = Array.from({ length: net.clusters }, (_, i) => i); const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const c of net.conns) if (c.nodes) parent[find(c.a.cluster)] = find(c.b.cluster);
    return parent.map((_, i) => find(i));
  }
  private cellsOf(conn: Conn, out: Node[], owner: Map<number, number>): void {
    const G = this.G, nodes = conn.nodes!; if (conn.pair) return;   // a pair's tracks run beside these cells, and nothing tees into a pair
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue;
      const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy);
      for (let k = 0; k <= n; k++) { const ix = a.ix + sx * k, iy = a.iy + sy * k; out.push({ ix, iy, l: a.l }); owner.set(a.l * G.W * G.H + iy * G.W + ix, conn.id); }
    }
  }

  // ------------------------------------------------------------------ one connection
  /** Search a route for the connection in the given maps (the net's own copper is lifted while it runs). */
  find(conn: Conn, soft: boolean, collect?: Features[]): Found | null {
    const G = this.G, net = this.netOf(conn.net); this.lift(net, 1, conn.cls); this.cur = conn; this.curSoft = soft;
    try {
      const maps = soft ? conn.cls.fixed : conn.cls.full, vmaps = soft ? conn.cls.vfixed : conn.cls.vfull;
      const comp = this.components(net); const owner = new Map<number, number>();
      const cells = (cluster: number) => { const out: Node[] = []; if (collect) return out; for (const c of net.conns) if (c.nodes && c !== conn && comp[c.a.cluster] === comp[cluster]) this.cellsOf(c, out, owner); return out; };
      let ta = cells(conn.a.cluster), tb = cells(conn.b.cluster);
      if (conn.planeOnly !== undefined) { ta = []; tb = []; }   // a way down into a plane: only the plane itself is its goal
      const zoneAt = (cluster: number) => !collect && net.zoneCells && comp[cluster] === comp[net.zoneCluster];
      // the larger tree is the target, so the route may join it anywhere along its tracks
      let flip = conn.planeOnly === undefined && (ta.length > tb.length || (!!zoneAt(conn.a.cluster) && !zoneAt(conn.b.cluster))); if (flip) { const t = ta; ta = tb; tb = t; }
      const A = flip ? conn.b : conn.a, B = flip ? conn.a : conn.b;
      // A plan may confine the net to some layers.  Where an end has no copper on them (a surface pad), its own layer
      // stays open so the route can leave the pad, at a price per mm that sends it to the wanted layers quickly.
      const gd = net.guide; let rt = G.routable, extra: ((nodes: Node[]) => number) | undefined;
      if (gd.allowed && !collect) {
        const want = gd.allowed.map((v, l) => v && G.routable[l]); const open = want.slice(); let relaxed = false;
        if (want.some(Boolean)) {
          for (const e of [A, B]) if (!e.layers.some((l) => want[l])) for (const l of e.layers) if (G.routable[l] && !open[l]) { open[l] = true; relaxed = true; }
          rt = open;
          if (relaxed) extra = (nodes) => { let off = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l === b.l && !want[a.l]) off += Math.hypot(b.ix - a.ix, b.iy - a.iy) * G.g; } return off * 4 * this.W.length; };
        }
      }
      if (soft && !collect) {   // looking through this run's routes: prefer the way that disturbs the fewest of them
        const full = conn.cls.full, plan = extra;
        extra = (nodes) => { let hit = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy); const m = full[a.l]; for (let k = 0; k <= n; k++) if (m[(a.iy + sy * k) * G.W + a.ix + sx * k]) hit++; } return hit * G.g * 12 * this.W.length + (plan ? plan(nodes) : 0); };
      }
      if (!collect && this.rim && this.opts.edgeRuns !== true) {   // mm run along the board edge beyond a short approach to a pad there
        const rim = this.rim, before = extra;
        extra = (nodes) => { let run = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy); const step = Math.hypot(sx, sy) * G.g; for (let k = 0; k < n; k++) if (rim[(a.iy + sy * k) * G.W + a.ix + sx * k] && rim[(a.iy + sy * (k + 1)) * G.W + a.ix + sx * (k + 1)]) run += step; }
          return Math.max(0, run - RIM_FREE_MM) * RIM_COST * this.W.length + (before ? before(nodes) : 0); };
      }
      if (!collect && !soft && this.opts.bundle !== false && !isSupply(conn.net) && this.kindOf(conn.net) === "digital" && !/DDR|SDRAM|DRAM|(^|[\/_])DQ[SM]?_?\d/i.test(conn.net) && !(this.opts.match || []).some((g) => g.nets.includes(conn.net))) {   // plain signals only: fast, analog and RF lines keep their distance, and a line that is to be length-matched keeps room for its serpentine
        // Tracks keep together: every mm a signal runs out in the open, with nothing beside it within about half a
        // millimetre, costs a little, so the escapes of a fine-pitch chip leave side by side as one bus and its vias
        // sit in a row, the way a person draws them.  The copper they do not scatter over stays one piece of ground.
        const tight = this.tight; const full = conn.cls.full, before = extra, R = tight ? 1 : Math.max(2, Math.round(0.5 / G.g)), GW = G.W, GH = G.H;   // tight: the very next lane (a fan-out being combed)
        extra = (nodes) => { let alone = 0;
          for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy); const step = Math.hypot(sx, sy) * G.g; const m = full[a.l]; if (!m) continue;
            for (let k = 0; k < n; k++) { const x = a.ix + sx * k, y = a.iy + sy * k; let beside = false;
              for (let j = 1; j <= R && !beside; j++) { const x1 = x - sy * j, y1 = y + sx * j, x2 = x + sy * j, y2 = y - sx * j; if ((x1 >= 0 && y1 >= 0 && x1 < GW && y1 < GH && m[y1 * GW + x1]) || (x2 >= 0 && y2 >= 0 && x2 < GW && y2 < GH && m[y2 * GW + x2])) beside = true; }
              if (!beside) alone += step; } }
          return alone * (tight ? 4 : 1) * BUNDLE_COST * this.W.length + (before ? before(nodes) : 0); };
      }
      const mate = conn.partner && conn.partner.nodes && conn.partner.nodes.length > 1 ? conn.partner.nodes : null;
      if (mate && !collect) {   // the second line of a pair keeps beside the first: every mm farther than a pair pitch from it costs
        const reach = (2 * conn.cls.width + 2 * conn.cls.clr + 0.3) / G.g, before = extra;
        const near = (ix: number, iy: number, l: number) => { for (let i = 0; i + 1 < mate.length; i++) { const a = mate[i], b = mate[i + 1]; if (a.l !== l || b.l !== l) continue; const vx = b.ix - a.ix, vy = b.iy - a.iy, h = vx * vx + vy * vy; const t = h ? Math.max(0, Math.min(1, ((ix - a.ix) * vx + (iy - a.iy) * vy) / h)) : 0; if (Math.hypot(ix - a.ix - t * vx, iy - a.iy - t * vy) <= reach) return true; } return false; };
        extra = (nodes) => { let lone = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy); const step = Math.hypot(sx, sy) * G.g; for (let k = 0; k < n; k++) if (!near(a.ix + sx * k, a.iy + sy * k, a.l)) lone += step; } return lone * 3 * this.W.length + (before ? before(nodes) : 0); };
      }
      let used = 0; for (const c of net.conns) if (c.nodes && c !== conn && c.feat) used += c.feat.vias;
      const perConn = this.opts.maxViasPerConnection; let maxVias = Math.min(gd.maxVias - used, this.viaCap, perConn === undefined || perConn === null ? Infinity : Math.max(0, +perConn));
      if (this.extraVias && maxVias >= 1 && maxVias < Infinity) maxVias += this.extraVias;   // the ladder's rescue: one via above the limit (a limit of none stays none)
      const src = this.access(A, maps, rt), tgt = this.access(B, maps, rt); if (!src) return null;
      let term = tb; let zoneSet: Set<number> | null = null;
      if (zoneAt(B.cluster)) { zoneSet = new Set(); term = tb.slice(); let own = false; for (const z of net.zoneCells!) if ((conn.planeOnly === undefined || z.l === conn.planeOnly) && !maps[z.l][z.iy * G.W + z.ix]) { if (!rt[z.l]) { if (!own) { rt = rt.slice(); own = true; } rt[z.l] = true; }   // a plane layer takes no tracks, but a via may drop into the net's own pour on it
        term.push(z); zoneSet.add(z.l * G.W * G.H + z.iy * G.W + z.ix); } }
      if (!tgt && !term.length) return null;
      const x0 = Math.min(src.ix, tgt ? tgt.ix : src.ix), x1 = Math.max(src.ix, tgt ? tgt.ix : src.ix), y0 = Math.min(src.iy, tgt ? tgt.iy : src.iy), y1 = Math.max(src.iy, tgt ? tgt.iy : src.iy);
      const span = Math.max(x1 - x0, y1 - y0);
      const finish = (res: ProbeResult): Found => {
        res.nodes = this.mitre(simplify(res.nodes), maps);
        if (res.onTerm) { const e = res.nodes[res.nodes.length - 1]; const k = e.l * G.W * G.H + e.iy * G.W + e.ix; if (zoneSet && zoneSet.has(k) && !owner.has(k)) (res as any).zoneEnd = true; }
        return { res, owner, flip, esc: [src.esc, tgt ? tgt.esc : undefined] };
      };
      // A global plan steers the search of a connection its negotiation moved off the direct path (the rest are left
      // to the search alone): every mm outside the connection's corridor and every mm off the layer the plan put a tile
      // on costs extra (`outside`, `layerCost`).  With `mask` the search first looks inside the corridor only, and at
      // the whole board when nothing is found there.  Not a net with a pour (it may end anywhere in it), and not a
      // one-layer try of a connection the plan sends through a via.
      const cor0 = this.gplan && !collect && !net.zoneCells && !this.noSteer ? this.gplan.corridors.get(conn.id) : undefined, steerAs = cor0 ? this.planOpts().steer : "none", cor = cor0 && (steerAs === "all" || (steerAs === "moved" && cor0.moved)) ? cor0 : undefined;
      let steer = extra;
      if (cor && !(cor.vias > 0 && maxVias <= 0)) {
        const pl = this.gplan!, kk = pl.k, po = this.planOpts(); const lc = G.routable.filter(Boolean).length > 1 ? po.layerCost : 0, oc = po.outside, lay = cor.layer, tl = cor.tiles, before = extra;
        if (lc > 0 || oc > 0) steer = (nodes) => { let off = 0, out = 0; for (let i = 0; i + 1 < nodes.length; i++) { const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy); const step = Math.hypot(sx, sy) * G.g;
          for (let q = 0; q < n; q++) { const r = (((a.iy + sy * q) / kk) | 0) * pl.nx + (((a.ix + sx * q) / kk) | 0); if (!tl[r]) out += step; else { const want = lay[r]; if (want >= 0 && want !== a.l) off += step; } } }
          return (off * lc + out * oc) * this.W.length + (before ? before(nodes) : 0); };
        if (po.mask) {
          let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity; for (let r = 0; r < tl.length; r++) if (tl[r]) { const tx = r % pl.nx, ty = (r / pl.nx) | 0; if (tx < tx0) tx0 = tx; if (tx > tx1) tx1 = tx; if (ty < ty0) ty0 = ty; if (ty > ty1) ty1 = ty; }
          const win: Win = { x0: Math.max(0, Math.min(tx0 * kk, x0)), y0: Math.max(0, Math.min(ty0 * kk, y0)), x1: Math.min(G.W - 1, Math.max((tx1 + 1) * kk - 1, x1)), y1: Math.min(G.H - 1, Math.max((ty1 + 1) * kk - 1, y1)) };
          const res = probe({ G, maps, vmaps, src, tgt, term, win, pref: this.pref, W: this.W, allowVias: gd.allowVias && maxVias > 0, maxSteps: 6e6, routable: rt, maxVias: maxVias === Infinity ? undefined : maxVias, extra: steer, block: this.corridorMask(cor, [A.p, B.p], po.open, win) });
          if (res) { this.planStat.inside++; return finish(res); }
          this.planStat.outside++;
        }
      }
      const margins = [Math.max(14, Math.round(span * 0.35)), Math.max(50, Math.round(span * 1.2)), Math.max(G.W, G.H)];
      for (let i = 0; i < margins.length; i++) {
        const m = margins[i]; const win: Win = { x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m), x1: Math.min(G.W - 1, x1 + m), y1: Math.min(G.H - 1, y1 + m) };
        const res = probe({ G, maps, vmaps, src, tgt, term, win, pref: this.pref, W: this.W, allowVias: gd.allowVias && maxVias > 0, maxSteps: 6e6, collect, routable: rt, maxVias: maxVias === Infinity ? undefined : maxVias, extra: steer });
        if (res) { if (steer !== extra) { const n = res.nodes; let inside = true; for (const x of n) if (!cor!.tiles[((x.iy / this.gplan!.k) | 0) * this.gplan!.nx + ((x.ix / this.gplan!.k) | 0)]) { inside = false; break; } this.planStat[inside ? "inside" : "outside"]++; } return finish(res); }
        if (win.x0 === 0 && win.y0 === 0 && win.x1 === G.W - 1 && win.y1 === G.H - 1) break;
      }
      return null;
    } finally { this.lift(net, -1, conn.cls); }
  }
  // ------------------------------------------------------------------ global plan (globalplan.ts)
  private gplan: PlanResult | null = null; private planRef: RuleClass | null = null; private planBlk: Uint8Array | null = null; private planStat = { inside: 0, outside: 0 };
  private planOpts(): { tile: number; iters: number; layerCost: number; outside: number; mask: boolean; vias: boolean; open: number; steer: "moved" | "all" | "none"; order: boolean; rip: boolean } {
    const o = this.opts.plan ?? PLAN; const q = typeof o === "object" ? o : {};
    return { tile: q.tile || 0, iters: q.iters || 16, layerCost: q.layerCost ?? 0.5, outside: q.outside ?? 0.5, mask: !!q.mask, vias: !!q.vias, open: q.open ?? 1, steer: q.steer || "moved", order: q.order !== false, rip: q.rip !== false };
  }
  /** How many rounds of the plan's negotiation fought over the connection (0: the plan never had to move it). */
  private contested(c: Conn): number { const cor = this.gplan && this.gplan.corridors.get(c.id); return cor && this.planOpts().rip ? cor.contest : 0; }
  /** The smallest centre distance between two pads of one part with three pads or more (Infinity when there is none). */
  private minPadPitch(): number {
    let best = Infinity;
    for (const it of this.doc.items.values()) if (it.kind === "footprint") {
      const ps: { x: number; y: number }[] = this.P.padsOf(it); if (ps.length < 3) continue;
      const pts = ps.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const dx = pts[j][0] - pts[i][0]; if (dx >= best) break; const d = Math.hypot(dx, pts[j][1] - pts[i][1]); if (d > 1e-6 && d < best) best = d; }
    }
    return best;
  }
  /** Plan every connection still to be laid on the tile graph: the plan sets the order and the routes taken up first,
   *  and the corridors of the connections it moved steer find(). */
  private planGlobal(): void {
    const G = this.G, po = this.planOpts(); const conns = this.conns.filter((c) => !c.nodes && !c.moot && c.planeOnly === undefined && !c.pairOnly);
    if (!conns.length) return;
    const count = new Map<RuleClass, number>(); for (const c of conns) count.set(c.cls, (count.get(c.cls) || 0) + 1);
    let ref = conns[0].cls; for (const [cls, n] of count) if (n > count.get(ref)!) ref = cls;
    const end = (a: Anchor) => ({ p: a.p, layers: a.layers, box: a.shape && !a.plane ? bboxOf(a.shape) : undefined }); this.planRef = ref;
    this.gplan = globalPlan({ G, maps: ref.fixed, vmaps: ref.vfixed, pitch: ref.width + ref.clr, viaPitch: ref.viaD + ref.clr, need: ref.clr + ref.width / 2, pref: this.pref, viaMm: this.W.via / Math.max(1e-6, this.W.length), minPitch: this.minPadPitch(), tile: po.tile || undefined, iters: po.iters },
      conns.map((c) => ({ id: c.id, net: c.net, a: end(c.a), b: end(c.b), demand: c.cls.width + c.cls.clr })));
  }
  private planReport(): RouteResult["plan"] {
    const pl = this.gplan; if (!pl) return undefined; const r3 = (v: number) => +v.toFixed(3);
    let viaConns = 0; for (const c of pl.corridors.values()) if (c.vias > 0) viaConns++;
    return { tile: r3(pl.T), tiles: [pl.nx, pl.ny], conns: pl.corridors.size, iterations: pl.iterations, overflowFirst: r3(pl.overflowFirst), overflow: r3(pl.overflow), crossings: pl.crossings, relayered: pl.relayered, moved: pl.moved, contested: pl.contested, viaConns, ms: pl.ms, inside: this.planStat.inside, outside: this.planStat.outside };
  }
  /** The grid cells a search inside the corridor may not enter, outside its tiles except near the ends (a shared
   *  buffer, written only inside the search window: the search reads nothing beyond it). */
  private corridorMask(cor: Corridor, ends: Pt[], open: number, win: Win): Uint8Array {
    const G = this.G, pl = this.gplan!, k = pl.k; const m = this.planBlk || (this.planBlk = new Uint8Array(G.W * G.H));
    for (let iy = win.y0; iy <= win.y1; iy++) m.fill(1, iy * G.W + win.x0, iy * G.W + win.x1 + 1);
    for (let r = 0; r < cor.tiles.length; r++) if (cor.tiles[r]) { const tx = r % pl.nx, ty = (r / pl.nx) | 0; for (let iy = ty * k; iy < Math.min(G.H, (ty + 1) * k); iy++) m.fill(0, iy * G.W + tx * k, iy * G.W + Math.min(G.W, (tx + 1) * k)); }
    const R = Math.ceil(open / G.g);
    for (const p of ends) { const cx = Math.round((p[0] - G.ox) / G.g), cy = Math.round((p[1] - G.oy) / G.g); for (let iy = Math.max(0, cy - R); iy <= Math.min(G.H - 1, cy + R); iy++) m.fill(0, iy * G.W + Math.max(0, cx - R), iy * G.W + Math.min(G.W, cx + R + 1)); }
    return m;
  }
  /** Chamfer the 90° corners the search was forced into, as far as the neighbouring copper allows. */
  private mitre(nodes: Node[], maps: Uint16Array[]): Node[] {
    const G = this.G; const maxCells = Math.max(1, Math.round(this.W.mitre / G.g)); const out: Node[] = [nodes[0]];
    const run = (a: Node, b: Node) => Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy));
    const corner = (i: number) => { if (i <= 0 || i >= nodes.length - 1) return 0; const a = nodes[i - 1], b = nodes[i], c = nodes[i + 1]; if (a.l !== b.l || b.l !== c.l) return 0; let d = Math.abs(dirOf(b.ix - a.ix, b.iy - a.iy) - dirOf(c.ix - b.ix, c.iy - b.iy)); d = Math.min(d, 8 - d); return d; };
    for (let i = 1; i < nodes.length; i++) {
      const b = nodes[i];
      if (corner(i) === 2) {
        const a = out[out.length - 1], c = nodes[i + 1]; const la = run(a, b), lc = run(b, c);
        const ia = [Math.sign(b.ix - a.ix), Math.sign(b.iy - a.iy)], oc = [Math.sign(c.ix - b.ix), Math.sign(c.iy - b.iy)];
        const endA = corner(i - 1) === 0 && out.length === 1, endC = i + 1 === nodes.length - 1;
        let m = Math.min(maxCells, endA ? la : la >> 1, endC ? lc : lc >> 1); let done = false;
        for (; m >= 1 && !done; m--) {
          const p1 = { ix: b.ix - ia[0] * m, iy: b.iy - ia[1] * m, l: b.l }, p2 = { ix: b.ix + oc[0] * m, iy: b.iy + oc[1] * m, l: b.l };
          const sx = Math.sign(p2.ix - p1.ix), sy = Math.sign(p2.iy - p1.iy), n = run(p1, p2); let ok = true;
          for (let k = 1; k < n && ok; k++) if (maps[b.l][(p1.iy + sy * k) * G.W + p1.ix + sx * k]) ok = false;
          if (ok) { if (p1.ix !== a.ix || p1.iy !== a.iy) out.push(p1); out.push(p2); done = true; if (p2.ix === c.ix && p2.iy === c.iy) i++; }
        }
        if (done) continue;
      }
      out.push(b);
    }
    return simplify(out);
  }
  /**
   * No square corners (the person's rule): wherever two tracks of a net meet end to end on a layer at 90° or
   * sharper, cut the corner with a 45° piece, as long as it keeps every clearance.  The grid search already mitres
   * what it can (mitre()); this catches the rest: bends it was squeezed into, and the bends between a pad's stub and
   * the route.  Antenna and RF nets keep their corners, those are drawn on purpose.  What cannot be cut even by a
   * hair is left for review_design to report.
   */
  unsquare(): void {
    type End = { c: Conn; o: Obstacle; at: "a" | "b" };
    const live = this.conns.filter((c) => c.nodes && this.kindOf(c.net) !== "rf"); if (!live.length) return;
    const P = this.P; const kf = (l: number, net: string, p: Pt) => `${l}\n${net}\n${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    // the board's own copper of each net: a bend on a pad or via is hidden under it, and a track already on the board is not ours to move
    const fixedEnds = new Set<string>(); const cover = new Map<string, Shape[]>();
    for (const [net, list] of this.G.obstacles) if (net) for (const ob of list) {
      if (ob.pad || ob.shape.t === "circle") for (const l of ob.layers) { const k = l + "\n" + net; let e = cover.get(k); if (!e) cover.set(k, e = []); e.push(ob.shape); }
      else if (ob.shape.t === "seg" || ob.shape.t === "path") for (const l of ob.layers) { for (const q of ob.shape.t === "seg" ? [ob.shape.a, ob.shape.b] : ob.shape.pts) fixedEnds.add(kf(l, net, q)); const k = l + "\n" + net; let e = cover.get(k); if (!e) cover.set(k, e = []); e.push({ ...ob.shape, r: 0 } as Shape); }
      else for (const l of ob.layers) { const k = l + "\n" + net; let e = cover.get(k); if (!e) cover.set(k, e = []); e.push(ob.shape); }
    }
    for (const c of live) this.place(c, -1);
    try {
      for (let round = 0; round < 4; round++) {
        const ends = new Map<string, End[]>(); const all: Conn[] = this.conns.filter((c) => c.nodes);
        for (const c of all) for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "circle") { for (const l of o.layers) { const k = l + "\n" + c.net; let e = cover.get(k); if (!e) cover.set(k, e = []); if (!e.includes(sh)) e.push(sh); } continue; } if (sh.t !== "seg") continue;
          for (const at of ["a", "b"] as const) { const k = kf(o.layers[0], c.net, sh[at]); let l = ends.get(k); if (!l) ends.set(k, l = []); l.push({ c, o, at }); } }
        const degree = (k: string) => (ends.get(k) || []).length + (fixedEnds.has(k) ? 1 : 0);
        const touched = new Set<Obstacle>(); let cut = 0;
        for (const [k, list] of ends) {
          if (list.length !== 2 || fixedEnds.has(k)) continue; const [e1, e2] = list; const c = e1.c; if (this.kindOf(c.net) === "rf" || touched.has(e1.o) || touched.has(e2.o)) continue;
          const s1 = e1.o.shape as any, s2 = e2.o.shape as any; const v: Pt = s1[e1.at]; const o1: Pt = s1[e1.at === "a" ? "b" : "a"], o2: Pt = s2[e2.at === "a" ? "b" : "a"];
          if (cornerAngle(v, o1, o2) > SQUARE_MAX) continue; const l = e1.o.layers[0];
          if ((cover.get(l + "\n" + c.net) || []).some((sh) => pointGap(sh, v[0], v[1]) <= 1e-6)) continue;
          // another route of the net that tees in here, onto the middle of one of these two: cutting would leave it hanging
          if (all.some((d) => d.net === c.net && d.shapes.some((o) => o !== e1.o && o !== e2.o && o.layers[0] === l && o.shape.t === "seg" && pointGap({ ...o.shape, r: 0 } as Shape, v[0], v[1]) <= 1e-4))) continue;
          const L1 = Math.hypot(o1[0] - v[0], o1[1] - v[1]), L2 = Math.hypot(o2[0] - v[0], o2[1] - v[1]);
          const cap = (L: number, o: Pt) => degree(kf(l, c.net, o)) === 2 ? L / 2 : L - 0.02;   // the far end may be a bend of its own, which needs room too
          const most = Math.min(cap(L1, o1), cap(L2, o2)); if (most <= 0.01) continue;
          const u1: Pt = [(o1[0] - v[0]) / L1, (o1[1] - v[1]) / L1], u2: Pt = [(o2[0] - v[0]) / L2, (o2[1] - v[1]) / L2]; const w = Math.max(s1.r, s2.r); const clr = Math.max(e1.o.clr, e2.o.clr);
          for (const d of [Math.min(1.0, 4 * w), 3 * w, 2 * w, 1.5 * w, w, 0.75 * w, 0.5 * w, 0.3 * w, 0.02].filter((x) => x <= most + 1e-9)) {
            const p1: Pt = [r6(v[0] + u1[0] * d), r6(v[1] + u1[1] * d)], p2: Pt = [r6(v[0] + u2[0] * d), r6(v[1] + u2[1] * d)];
            const piece: Shape = { t: "seg", a: p1, b: p2, r: w };
            this.cur = null; this.curSoft = false; if (!this.clearOf(piece, l, c.net, clr)) continue;
            s1[e1.at] = p1; s2[e2.at] = p2; const ob: Obstacle = { net: c.net, layers: [l], shape: piece, clr }; c.shapes.push(ob);
            touched.add(e1.o); touched.add(e2.o); touched.add(ob); cut++; this.stat.cornersCut = (this.stat.cornersCut || 0) + 1; break;
          }
        }
        if (!cut) break;
      }
    } finally { for (const c of live) this.place(c, 1); }
  }
  /** Lay a found route: its copper becomes an obstacle for every other net. */
  commit(conn: Conn, found: Found): void {
    const G = this.G, { res, flip } = found; const nodes = res.nodes; const w = conn.cls.width; const all = G.layers.map((_, i) => i);
    const shapes: Obstacle[] = [], viaCells: number[] = []; const clr = conn.cls.clr; const net = this.netOf(conn.net);
    // thru cells are only known while the net is lifted
    // Only a plated hole of a pad or of copper already on the board saves a via.  A via of another connection of this
    // net does not: that connection may be ripped and laid elsewhere later, which would leave this one changing layer in thin air.
    const holes = new Set<number>(); for (const o of G.obstacles.get(conn.net) || []) if (o.thru) holes.add(Math.round((o.thru[1] - G.oy) / G.g) * G.W + Math.round((o.thru[0] - G.ox) / G.g));
    this.lift(net, 1, conn.cls);
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1];
      if (a.l !== b.l) { const gi = a.iy * G.W + a.ix; if ((!G.thru[gi] || !holes.has(gi)) && !viaCells.includes(gi)) { viaCells.push(gi); const p = this.mm(a); shapes.push({ net: conn.net, layers: all, shape: { t: "circle", x: p[0], y: p[1], r: conn.cls.viaD / 2 }, clr: Math.max(clr, (G.holeClr || 0) + HOLE_SLACK - (conn.cls.viaD - conn.cls.viaDrill) / 2) }); } }
      else shapes.push({ net: conn.net, layers: [a.l], shape: { t: "seg", a: this.mm(a), b: this.mm(b), r: w / 2 }, clr });
    }
    this.lift(net, -1, conn.cls);
    conn.nodes = nodes; conn.shapes = shapes; conn.viaCells = viaCells; conn.stubs = []; conn.feat = featuresOf(G, nodes, this.pref); conn.zoneEnd = !!(res as any).zoneEnd;
    const A = flip ? conn.b : conn.a, B = flip ? conn.a : conn.b; const first = nodes[0], last = nodes[nodes.length - 1];
    // the stub from a pad's centre to the first grid node necks down to the pad's own width: a wide supply track drawn
    // from the middle of a narrow pad would reach past the pad towards its neighbour (Ledify U6: 0.08 mm from SW)
    const piece = (from: Pt, to: Pt, l: number, sw = w) => { if (Math.hypot(to[0] - from[0], to[1] - from[1]) > 1e-4) { conn.stubs.push([from, to, l]); conn.shapes.push({ net: conn.net, layers: [l], shape: { t: "seg", a: from, b: to, r: sw / 2 }, clr }); } };
    const stub = (anchor: Anchor, n: Node, esc?: Pt) => { const p = this.mm(n); const sw = anchor.narrow ? Math.min(w, anchor.narrow) : w; if (esc) { piece(anchor.p, esc, n.l, sw); piece(esc, p, n.l, sw); } else piece(anchor.p, p, n.l, sw); };
    const esc = found.esc || []; stub(A, first, esc[0]); if (!res.onTerm) stub(B, last, esc[1]);
    conn.landed = -1;
    if (res.onTerm) { const o = found.owner.get(last.l * G.W * G.H + last.iy * G.W + last.ix); if (o !== undefined) conn.landed = o; }
    this.place(conn, 1);
  }
  /** Take a laid route (and every route that joined it mid-track) off the board again. */
  rip(conn: Conn, out: Conn[] = []): Conn[] {
    if (!conn.nodes) return out;
    this.place(conn, -1); conn.nodes = null; conn.shapes = []; conn.viaCells = []; conn.stubs = []; conn.pair = false; out.push(conn);
    if (conn.ends) { conn.a = conn.ends[0]; conn.b = conn.ends[1]; conn.ends = undefined; }
    for (const c of this.conns) if (c.nodes && c.landed === conn.id) this.rip(c, out);
    return out;
  }
  /** Routes of other nets laid in this run that a candidate route would run into. */
  private blockers(conn: Conn, res: ProbeResult): Conn[] {
    const G = this.G, P = this.P; const w = conn.cls.width; const mine: { l: number[]; s: Shape; bb: number[] }[] = []; const nodes = res.nodes;
    const bb = (s: Shape) => s.t === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r];
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1]; let s: Shape, l: number[];
      if (a.l !== b.l) { const p = this.mm(a); s = { t: "circle", x: p[0], y: p[1], r: conn.cls.viaD / 2 }; l = G.layers.map((_, k) => k); } else { s = { t: "seg", a: this.mm(a), b: this.mm(b), r: w / 2 }; l = [a.l]; }
      mine.push({ l, s, bb: bb(s) });
    }
    const out: Conn[] = [];
    for (const o of this.conns) {
      if (!o.nodes || o.net === conn.net) continue; const need = Math.max(conn.cls.clr, o.cls.clr) + G.margin + G.g * 1.5; let hit = false;
      for (const sh of o.shapes) { const ob = bb(sh.shape); for (const m of mine) { if (ob[0] > m.bb[2] + need || ob[2] < m.bb[0] - need || ob[1] > m.bb[3] + need || ob[3] < m.bb[1] - need) continue; if (!sh.layers.some((x) => m.l.includes(x))) continue; if (P.shapeGap(sh.shape, m.s) < need) { hit = true; break; } } if (hit) break; }
      if (hit) out.push(o);
    }
    return out;
  }
  /** What taking a laid route up and laying it again costs, in mm of detour (Copper's rip price): 4 mm, times its
   *  width over the narrowest, eight times for a critical net, less for a route that already wanders, and more each
   *  time taking it up did not pay.  A route the global plan had to fight for costs PLAN_RIP of that: it is taken up
   *  first. */
  private ripHist = new Map<number, number>(); private wmin = 0;
  private ripPrice(o: Conn): number {
    if (!this.wmin) { let w = Infinity; for (const c of this.conns) w = Math.min(w, c.cls.width); this.wmin = Math.max(0.05, isFinite(w) ? w : 0.2); }
    const crit = isCritical(o.net, this.kindOf(o.net)) || this.netOf(o.net).guide.rank < Infinity;
    const wander = Math.max(1, (o.feat ? o.feat.length : o.len) / Math.max(o.len, 0.1));
    return CUT_RIP_MM * Math.max(1, o.cls.width / this.wmin) * (crit ? 8 : 1) * (this.contested(o) ? PLAN_RIP : 1) / wander + (this.ripHist.get(o.id) || 0);
  }
  /** The routes of other nets to take up so that `conn` gets through: the minimum cut (ripcut.ts).  `wall`: routes
   *  that may not come up.  null when there is no way even through every route that may. */
  cutFor(conn: Conn, wall: (o: Conn) => boolean = () => false): Conn[] | null {
    const G = this.G, net = this.netOf(conn.net); this.lift(net, 1, conn.cls);
    try {
      const maps = conn.cls.fixed, vmaps = conn.cls.vfixed; const comp = this.components(net);
      if (comp[conn.a.cluster] === comp[conn.b.cluster]) return null;
      const gd = net.guide; let rt = G.routable.slice();
      if (gd.allowed && gd.allowed.some((v, l) => v && G.routable[l])) { rt = gd.allowed.map((v, l) => v && G.routable[l]); for (const e of [conn.a, conn.b]) if (!e.layers.some((l) => rt[l])) for (const l of e.layers) if (G.routable[l]) rt[l] = true; }
      const ends = (an: Anchor): Node[] => {
        const out: Node[] = []; const t = this.access(an, maps, rt); if (t) for (const l of t.layers) out.push({ ix: t.ix, iy: t.iy, l });
        const owner = new Map<number, number>(); for (const o of net.conns) if (o.nodes && o !== conn && comp[o.a.cluster] === comp[an.cluster]) this.cellsOf(o, out, owner);
        if (net.zoneCells && comp[an.cluster] === comp[net.zoneCluster]) for (const z of net.zoneCells) if (!maps[z.l][z.iy * G.W + z.ix]) { out.push(z); rt[z.l] = true; }
        return out;
      };
      const src = ends(conn.a), dst = ends(conn.b); if (!src.length || !dst.length) return null;
      const byId = new Map<number, Conn>(); const routes: { id: number; shapes: Obstacle[]; price: number }[] = [];
      for (const o of this.conns) if (o.nodes && o.net !== conn.net) { byId.set(o.id, o); routes.push({ id: o.id, shapes: o.shapes, price: wall(o) ? Infinity : this.ripPrice(o) }); }
      if (!routes.length) return null;
      const cls = conn.cls; const slack = G.g * 0.5;
      const grow = (o: Obstacle) => growFor(G, cls, o) + domainGap(G, cls, o) + slack, vgrow = (o: Obstacle) => growVia(G, cls, o) + domainGap(G, cls, o) + slack;
      const cx = [conn.a.p, conn.b.p].map((p) => Math.round((p[0] - G.ox) / G.g)), cy = [conn.a.p, conn.b.p].map((p) => Math.round((p[1] - G.oy) / G.g));
      const span = Math.max(Math.abs(cx[0] - cx[1]), Math.abs(cy[0] - cy[1]));
      const perConn = this.opts.maxViasPerConnection; const allowVias = this.allowVias && gd.allowVias && gd.maxVias > 0 && !(perConn !== undefined && perConn !== null && +perConn <= 0) && rt.filter(Boolean).length > 1;
      for (const m of [Math.max(40, Math.round(span * 0.5)), Math.max(G.W, G.H)]) {
        const win: Win = { x0: Math.max(0, Math.min(...cx) - m), y0: Math.max(0, Math.min(...cy) - m), x1: Math.min(G.W - 1, Math.max(...cx) + m), y1: Math.min(G.H - 1, Math.max(...cy) + m) };
        const cut = minCut({ G, maps, vmaps, routable: rt, allowVias, viaMm: this.W.via / Math.max(1e-6, this.W.length), src, dst, win, routes, grow, vgrow });
        if (cut) return cut.victims.map((id) => byId.get(id)!).filter(Boolean);
        if (win.x0 === 0 && win.y0 === 0 && win.x1 === G.W - 1 && win.y1 === G.H - 1) break;
      }
      return null;
    } finally { this.lift(net, -1, conn.cls); }
  }
  /** Is every cell of a route free in the full map (after its blockers were ripped)? */
  private fits(conn: Conn, res: ProbeResult): boolean {
    const G = this.G, net = this.netOf(conn.net); this.lift(net, 1, conn.cls);
    try {
      const maps = conn.cls.full, nodes = res.nodes;
      for (let i = 0; i + 1 < nodes.length; i++) {
        const a = nodes[i], b = nodes[i + 1];
        if (a.l !== b.l) { if (!G.thru[a.iy * G.W + a.ix] && !viaFits(G, conn.cls.vfull, a.iy * G.W + a.ix)) return false; continue; }
        const n = Math.max(Math.abs(b.ix - a.ix), Math.abs(b.iy - a.iy)), sx = Math.sign(b.ix - a.ix), sy = Math.sign(b.iy - a.iy);
        for (let k = 0; k <= n; k++) if (maps[a.l][(a.iy + sy * k) * G.W + a.ix + sx * k]) return false;
      }
      return true;
    } finally { this.lift(net, -1, conn.cls); }
  }

  // ------------------------------------------------------------------ the run
  *run(): Generator<Progress, RouteResult> {
    const t0 = Date.now(); const conns = this.conns; const passes = Math.max(1, this.opts.passes || 3); const ripUp = this.opts.ripUp !== false;
    const gOf = new Map(this.nets.map((n) => [n.key, n.guide])); const cmp = (x: number, y: number) => x === y ? 0 : x < y ? -1 : 1;
    // Short hops first (decoupling, crystals).  Then a fine-pitch chip is fanned out, the longest connection first:
    // its pins leave side by side, and the one that travels furthest must turn away first for the others to nest
    // inside it.  Everything else follows, shortest first.
    // The order a person routes in: differential pairs first (layPairs, before this queue, so they take the clean
    // direct path), then the short connections inside each block and the escapes from fine-pitch chips, then power,
    // then the remaining signals.
    // The critical nets go in before all of that, the way a person starts a board: after the coupled pairs come the
    // other USB data stubs, the RF feed and the crystal (short, on one layer, no via), then power.  Only then does
    // the bulk of the signals fill in round them.  Laid the other way round, the USB line and the antenna feed get
    // what is left: a detour and two vias.
    const critical = (c: Conn) => isCritical(c.net, this.kindOf(c.net));
    // Then every cluster is wired inside itself (a chip to its own capacitors, crystal, pull-ups, inductor: short,
    // on the parts' layer), cluster by cluster, before any track runs from one cluster to another: the way a person
    // plans a group's routing first and only then joins the groups up.
    const inGroup = new Map<number, string>(); for (const c of conns) { const g = this.opts.groupsFirst === false ? "" : this.groupFor(c); if (g && c.len <= GROUP_REACH * 2) inGroup.set(c.id, g); }
    const first = new Set<number>(); for (const c of conns) if (critical(c) || gOf.get(c.net)!.rank < Infinity) first.add(c.id);
    const tier = (c: Conn) => this.opts.criticalFirst !== false ? (critical(c) ? -3 : inGroup.has(c.id) ? -2 : isSupply(c.net) && !this.netOf(c.net).zoneCells ? -1 : c.len < 3 ? 0 : Math.min(c.a.narrow || Infinity, c.b.narrow || Infinity) <= 0.35 ? 1 : isSupply(c.net) ? 2 : 3) : inGroup.has(c.id) ? -3 : critical(c) ? -2 : isSupply(c.net) && !this.netOf(c.net).zoneCells ? -1 : c.len < 3 ? 0 : Math.min(c.a.narrow || Infinity, c.b.narrow || Infinity) <= 0.35 ? 1 : isSupply(c.net) ? 2 : 3;
    // A global plan (globalplan.ts) orders each tier further: the connections its negotiation had to fight for go
    // before the ones it never had to move, the most fought over first (Copper: the most constrained corridor first).
    const planned = (this.opts.plan ?? PLAN) !== false; if (planned) this.planGlobal();
    const byPlan = planned && this.planOpts().order, fought = (c: Conn) => { const cor = byPlan && this.gplan ? this.gplan.corridors.get(c.id) : undefined; return cor ? cor.contest : 0; };
    const order = conns.slice().sort((a, b) => cmp(gOf.get(a.net)!.rank, gOf.get(b.net)!.rank) || gOf.get(b.net)!.priority - gOf.get(a.net)!.priority || tier(a) - tier(b) || (inGroup.has(a.id) && tier(a) === tier(b) && inGroup.has(b.id) ? (inGroup.get(a.id)! < inGroup.get(b.id)! ? -1 : inGroup.get(a.id)! > inGroup.get(b.id)! ? 1 : 0) : 0) || fought(b) - fought(a) || (tier(a) === 1 ? b.len - a.len : a.len - b.len) || (a.net < b.net ? -1 : a.net > b.net ? 1 : a.id - b.id));
    let best: { score: number; snap: (Pick<Conn, "cls" | "pair" | "nodes" | "shapes" | "viaCells" | "landed" | "feat" | "stubs" | "zoneEnd">)[] } | null = null; let failedLast = new Set<number>(); let pass = 0;
    const RC = (this.opts as any).connRips || 4, RB = (this.opts as any).blockerRips || 3;
    // The budget is work done (search steps), not the clock: the same board then routes the same way on a fast machine,
    // a slow one and a busy server.  STEPS_PER_MS is what an ordinary machine does; the clock only stops a run that
    // takes four times its allowance.
    const w0 = work.steps; const budget = this.opts.timeMs ? this.opts.timeMs * STEPS_PER_MS : 0;
    const timeUp = () => this.stopped || (!!budget && (work.steps - w0 > budget || Date.now() - t0 > 4 * this.opts.timeMs!));
    const later = new Set<number>();   // connections found to need a layer change: in the next pass they go first and may take it at once
    if (planned && this.gplan && this.planOpts().vias) for (const [id, cor] of this.gplan.corridors) if (cor.vias > 0) later.add(id);
    for (; pass < passes; pass++) {
      for (const c of conns) if (c.nodes) this.rip(c);
      for (const c of conns) c.rips = 0;
      this.layPairs();
      // later passes take what failed last time first, but never ahead of the critical nets: those go first in every pass
      const queue = pass === 0 ? order.slice() : order.filter((c) => first.has(c.id)).concat(order.filter((c) => !first.has(c.id) && failedLast.has(c.id)), order.filter((c) => !first.has(c.id) && !failedLast.has(c.id)));
      const failed = new Set<number>(); let done = 0;
      while (queue.length) {
        if (timeUp()) { for (const c of queue) { failed.add(c.id); if (!c.nodes) c.why = "budget"; } break; }
        const c = queue.shift()!; if (c.nodes) continue; c.why = undefined;
        // One layer first: a signal is laid without a via while that can be done, taking routes in its way out and
        // laying them again (they get the same chance).  Only what cannot be made on one layer comes back at the end
        // of the queue and may change layer.  Laid the other way round, an early track takes the direct line and every
        // later one that has to cross it pays two vias.
        const flat = this.opts.planarFirst !== false && !later.has(c.id) && !isSupply(c.net) && !this.netOf(c.net).zoneCells && this.netOf(c.net).guide.allowVias && !this.netOf(c.net).guide.allowed;   // a plan that names the net's layers stands
        if (flat) this.viaCap = 0;
        try {
        // the two lines of a differential pair run together or not at all: never one on its own path
        if (c.pairOnly && this.opts.splitPairs !== true) { c.why = "pair: " + c.pairOnly; failed.add(c.id); done++; continue; }
        let found = this.find(c, false);
        if (!found && ripUp && c.rips < RC) {
          const soft = this.find(c, true);
          if (!soft) this.stat.noSoft++;
          if (soft) {
            const bl = this.blockers(c, soft.res);
            // a route the global plan had to fight for may be taken up once more than the others (PLAN_RIPS)
            const mayRip = (b: Conn) => b.rips < RB + (this.contested(b) ? PLAN_RIPS : 0) && !first.has(b.id);
            this.stat[!bl.length ? "noBlockers" : bl.length > 14 ? "tooMany" : bl.every(mayRip) ? "ripped" : "ripLimit"]++;
            if (bl.length && bl.length <= 14 && bl.every(mayRip)) {   // a critical net keeps the path it was given: nothing laid later takes it up
              const ripped: Conn[] = []; for (const b of bl) { b.rips++; this.rip(b, ripped); }
              c.rips++;
              if (this.fits(c, soft.res)) { found = soft; for (const r of ripped) { failed.delete(r.id); queue.unshift(r); } }
              else { found = this.find(c, false); for (const r of ripped) { failed.delete(r.id); queue.unshift(r); } }
            }
          }
        }
        // one layer at any price is not what a person does: a flat route that wanders far round the board (a loop
        // round the edge boxes in everything inside it and cuts the pour) gives way to one that changes layer
        if (found && flat && found.res.feat.length > FLAT_DETOUR * c.len + FLAT_SLACK_MM) found = null;
        // a critical net does not wait for the end of the queue: what it cannot have on one layer it takes now, with
        // a layer change, while the board is still empty round it
        if (!found && flat && (first.has(c.id))) { this.viaCap = Infinity; found = this.find(c, false); }
        if (!found && flat) { later.add(c.id); queue.push(c); continue; }
        if (found) { this.commit(c, found); failed.delete(c.id); } else failed.add(c.id);
        } finally { this.viaCap = Infinity; }
        done++;
        yield { done: Math.min(done, conns.length), total: conns.length, routed: conns.filter((x) => x.nodes).length, pass, net: c.net };
      }
      const routed = conns.filter((x) => x.nodes); const cost = routed.reduce((s, c) => s + costOf(c.feat!, this.W), 0);
      const score = routed.length * 1e6 - cost;
      if (!best || score > best.score) best = { score, snap: conns.map((c) => ({ cls: c.cls, pair: c.pair, nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd })) };
      failedLast = failed;
      if (!failed.size || timeUp()) { pass++; break; }
    }
    if (best) {   // the maps follow the routes that are kept, so the board can still be questioned afterwards
      for (const c of conns) if (c.nodes) this.place(c, -1);
      conns.forEach((c, i) => Object.assign(c, best!.snap[i]));
      for (const c of conns) if (c.nodes) this.place(c, 1);
    }
    if (this.opts.zones !== false && !this.stopped) this.stitch(timeUp);
    if (ripUp && !this.stopped) { this.repair(timeUp); if (this.opts.zones !== false) this.stitch(timeUp); }
    if (this.opts.fewerVias !== false && !this.stopped) this.fewerVias(timeUp);
    if (this.opts.planeShortcuts !== false && !this.stopped) {
      const before = this.stat.planeShortcuts || 0; this.planeShortcuts(timeUp);
      // track taken up into a plane leaves room: what is still open gets another go at it
      if (ripUp && (this.stat.planeShortcuts || 0) > before && conns.some((c) => !c.nodes && !c.moot && c.why !== "budget")) this.repair(timeUp);
    }
    this.widen();
    if (this.opts.zones !== false && !this.stopped) this.stitch(timeUp);   // what the last two steps moved may have cut a pour again
    if (ripUp && this.opts.zones !== false && !this.stopped && conns.some((c) => !c.nodes && !c.moot && c.stitch)) { this.repair(timeUp); this.stitch(timeUp); }   // a cut-off pad still not joined: let it push others aside
    if (this.opts.matchLengths !== false && !this.stopped) this.tune();
    // a serpentine laid by tune() can close a loop round a ground pad and cut it off the pour: join it up again
    if (this.opts.zones !== false && !this.stopped && this.opts.matchLengths !== false) this.stitch(timeUp);
    this.unsquare();
    this.validate();
    if (this.opts.fence !== false && !this.stopped) this.fence();
    if (this.opts.explain !== false) this.explain();
    this.ms = Date.now() - t0; this.passes = pass;
    // `process` exists only under node (the router's tests); the browser build has no node types
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env && env.KC_ROUTER_WORK) console.error('router work', work.steps - w0, 'steps in', this.ms, 'ms', JSON.stringify(this.stat), 'open', conns.filter((c) => !c.nodes && !c.moot).map((c) => c.net + (c.why ? '(' + c.why + ')' : '')).join(' '));
    return this.result();
  }

  /**
   * What the passes left open, one connection at a time: take out the routes in its way, lay it, lay those again
   * around it.  Kept only when nothing else is lost, so every step is a gain.
   */
  repair(timeUp: () => boolean): void {
    const conns = this.conns; type Snap = Pick<Conn, "cls" | "nodes" | "shapes" | "viaCells" | "landed" | "feat" | "stubs" | "zoneEnd">;
    const snapOf = (): Snap[] => conns.map((c) => ({ cls: c.cls, nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd }));
    const back = (snap: Snap[]) => { for (const c of conns) if (c.nodes !== snap[c.id].nodes && c.nodes) this.place(c, -1); conns.forEach((c, i) => { if (c.nodes !== snap[i].nodes) { Object.assign(c, snap[i]); if (c.nodes) this.place(c, 1); } }); };
    const lay = (c: Conn): boolean => { if (c.pairOnly && this.opts.splitPairs !== true) return false; const f = this.find(c, false); if (f) this.commit(c, f); return !!f; };
    // lay c whatever it takes: routes in its way come out and are laid again the same way, a few levels deep;
    // a route laid in this attempt is never taken out again
    const force = (c: Conn, depth: number, keep: Set<Conn>): boolean => {
      if (c.pairOnly && this.opts.splitPairs !== true) return false;   // one line of a pair is never forced through alone
      if (lay(c)) { keep.add(c); return true; } if (depth <= 0 || timeUp()) return false;
      const soft = this.find(c, true); if (!soft) return false; const bl = this.blockers(c, soft.res); if (!bl.length || bl.length > 12 || bl.some((b) => keep.has(b) || b.pair)) return false;
      const ripped: Conn[] = []; for (const b of bl) this.rip(b, ripped); if (ripped.some((r) => keep.has(r))) return false;
      if (this.fits(c, soft.res)) this.commit(c, soft); else if (!lay(c)) return false; keep.add(c);
      ripped.sort((a, b) => this.contested(b) - this.contested(a) || a.len - b.len); for (const r of ripped) if (!r.nodes && !force(r, depth - 1, keep)) return false;
      return true;
    };
    // The min-cut variant (ripcut.ts, after Copper's repair): take up only the cheapest set of routes in the way,
    // lay c, lay them again (each may in turn take up its own cut, one level less deep).  A set that did not pay is
    // not tried again for c, its routes cost a little more from then on, and those that could not be laid again
    // are walls on the next try (at most three tries).
    const tabu = new Set<string>();
    const cutForce = (c: Conn, depth: number, keep: Set<Conn>): boolean => {
      if (c.pairOnly && this.opts.splitPairs !== true) return false;
      if (lay(c)) { keep.add(c); return true; } if (depth <= 0 || timeUp()) return false;
      const hard = new Set<number>();
      for (let attempt = 0; attempt < CUT_TRIES && !timeUp(); attempt++) {
        const cut = this.cutFor(c, (o) => keep.has(o) || !!o.pair || hard.has(o.id)); this.stat.cuts = (this.stat.cuts || 0) + 1;
        if (!cut || !cut.length) { this.stat.noCut = (this.stat.noCut || 0) + 1; return false; }
        const key = c.id + ":" + cut.map((o) => o.id).join(",");
        if (tabu.has(key)) { for (const o of cut) hard.add(o.id); continue; }
        tabu.add(key);
        const snap = snapOf(); const ripped: Conn[] = []; for (const b of cut) this.rip(b, ripped);
        let blamed: Conn[] = cut; let ok = lay(c);
        if (ok) {
          keep.add(c); ripped.sort((a, b) => a.len - b.len || a.id - b.id);
          for (const r of ripped) if (!r.nodes && !cutForce(r, depth - 1, keep)) { ok = false; blamed = [r]; break; }
        }
        if (ok) { this.stat.cutRipped = (this.stat.cutRipped || 0) + ripped.length; return true; }
        back(snap); keep.delete(c);
        for (const o of cut) this.ripHist.set(o.id, (this.ripHist.get(o.id) || 0) + CUT_HISTORY_MM);
        for (const o of blamed) hard.add(o.id);
      }
      return false;
    };
    const mincut = (this.opts.ripup ?? RIPUP) !== "near";   // the ladder's min-cut rung is this one
    const forceAny = (c: Conn, depth: number, keep: Set<Conn>): boolean => {
      if (!mincut) return force(c, depth, keep);
      if (CUT_ORDER === "near-first") { const s = snapOf(); if (force(c, depth, keep)) return true; back(s); return !timeUp() && cutForce(c, Math.min(depth, CUT_DEPTH), new Set()); }
      return cutForce(c, Math.min(depth, CUT_DEPTH), keep) || (CUT_ORDER === "cut-first" && !timeUp() && force(c, depth, new Set()));
    };
    if ((this.opts.ripup ?? RIPUP) === "ladder") {
      if (!conns.some((c) => !c.nodes && c.why !== "budget")) return;
      for (let round = 0; round < 2 && !timeUp(); round++) if (!this.ladder(timeUp, snapOf, back, lay, (c) => forceAny(c, 3, new Set()))) break;
    } else for (let round = 0; round < 3; round++) {
      const open = conns.filter((c) => !c.nodes && c.why !== "budget"); if (!open.length) return; let gained = false;
      for (const c of open) {
        if (timeUp()) return; if (c.nodes) continue; const snap = snapOf(); const n0 = snap.filter((x) => x.nodes).length;
        if (forceAny(c, 3, new Set()) && conns.filter((x) => x.nodes).length > n0) gained = true; else back(snap);
      }
      if (!gained) break;
    }
    // A pin boxed in by its neighbours in a fine-pitch row (each took the lane that suited it, and the one laid last
    // found none left): the row's routes near it come out together and are laid again in pin order, from one end of
    // the row and then from the other.  The route next to the obstacle goes first and takes the lane against it, and
    // each one after it nests beside the last, the way a person combs a fan-out.
    const fineEnd = (o: Conn, at?: Pt) => { const es = [o.a, o.b].filter((x) => x.narrow && x.narrow <= 0.35); if (!es.length) return null; if (at) es.sort((p, q) => Math.hypot(p.p[0] - at[0], p.p[1] - at[1]) - Math.hypot(q.p[0] - at[0], q.p[1] - at[1])); return es[0]; };
    for (const c of conns) {
      if (c.nodes || c.why === "budget" || timeUp() || c.pair) continue;
      const e = fineEnd(c); if (!e) continue;
      const near = conns.filter((o) => { if (o === c || !o.nodes || o.pair) return false; const x = fineEnd(o, e.p); return !!x && Math.hypot(x.p[0] - e.p[0], x.p[1] - e.p[1]) <= 2.6; });
      let sx = 0, sy = 0; for (const o of near) { const x = fineEnd(o, e.p)!; sx = Math.max(sx, Math.abs(x.p[0] - e.p[0])); sy = Math.max(sy, Math.abs(x.p[1] - e.p[1])); }
      const ax = sx >= sy ? 0 : 1;   // the row runs along this axis; pads round the corner of the package are another row
      const row = near.filter((o) => Math.abs(fineEnd(o, e.p)!.p[1 - ax] - e.p[1 - ax]) < 0.3);
      if (!row.length) continue;
      // signals in pin order; the supplies after them (a supply pin's via fits around the signal lanes, not the other way round)
      const key = (o: Conn) => { const x = fineEnd(o, e.p); return !x || Math.abs(x.p[1 - ax] - e.p[1 - ax]) >= 0.3 ? Infinity : x.p[ax]; };
      const late = (o: Conn) => key(o) === Infinity ? 2 : isSupply(o.net) ? 1 : 0;
      const snap = snapOf(); const n0 = snap.filter((x) => x.nodes).length;
      for (const dir of [1, -1]) {
        const ripped: Conn[] = []; for (const b of row) if (b.nodes) this.rip(b, ripped);
        const all = [c, ...ripped.filter((r) => r !== c)].sort((p, q) => late(p) - late(q) || (late(p) === 2 ? 0 : dir * (key(p) - key(q))) || p.id - q.id);
        let good = true; this.tight = true; try { for (const r of all) if (!r.nodes && !lay(r)) { good = false; if ((globalThis as any).process?.env?.KC_ROUTER_WORK) console.error('comb', c.net, dir, 'row', all.map((x) => x.net + '@' + key(x)).join(' '), 'failed at', r.net); break; } } finally { this.tight = false; }
        if (good && conns.filter((x) => x.nodes).length > n0) { this.stat.combed = (this.stat.combed || 0) + 1; break; }
        back(snap);
      }
    }
    // Last resort for what is still open: the narrowest track the board allows gets through gaps the class width
    // does not.  Narrower than the net class asks for, never narrower than the design rules permit.
    const floor = Math.max(this.s.minTrackWidth || 0, 0.1);
    for (const c of conns) {
      if (c.nodes || c.why === "budget" || timeUp() || c.pair) continue;
      const wide = c.cls;
      for (const relax of wide.kind ? [false, true] : [false]) {   // last of all, without the gap its signal domain asks for
        let thin: RuleClass; this.relax = relax; try { thin = this.classFor(c.net, Math.min(floor, wide.width), 0, this.opts.smallVias !== false); } finally { this.relax = false; } if (thin === wide) continue;
        c.cls = thin; const snap = snapOf(); const n0 = snap.filter((x) => x.nodes).length;
        if (forceAny(c, 3, new Set()) && conns.filter((x) => x.nodes).length > n0) { if (relax) this.relaxed.add(c.net); break; }
        c.cls = wide; back(snap);
      }
    }
  }
  // ------------------------------------------------------------------ the repair ladder (ladder.ts, after Copper's repair.py)
  private ladderRun: Ladder<unknown> | null = null; private booked: [number, number, number, number, number][] = [];
  private replanUndo: { cors: Map<number, Corridor | undefined>; book: [number, number, number, number, number][] } | null = null;
  /** One run of the ladder over what is open; true when it laid something.  The transactions are repair()'s
   *  snapshots; `cut` is the min-cut rip as ripup "mincut" does it. */
  private ladder<S>(timeUp: () => boolean, snapOf: () => S, back: (s: S) => void, lay: (c: Conn) => boolean, cut: (c: Conn) => boolean): boolean {
    const conns = this.conns; const alone = (c: Conn) => !!c.pair || (!!c.pairOnly && this.opts.splitPairs !== true);
    const open = () => conns.filter((c) => !c.nodes && !c.moot).sort((a, b) => a.len - b.len || a.id - b.id).map((c) => c.id);
    const host = {
      open, routed: (id: number) => !!conns[id].nodes, timeUp, snap: snapOf as () => unknown, back: back as (s: unknown) => void,
      rescue: (id: number, rung: RescueRung) => { const c = conns[id]; return !alone(c) && c.why !== "budget" && this.rescueOne(c, rung, lay); },
      mincut: (id: number) => { const c = conns[id]; return !alone(c) && c.why !== "budget" && cut(c); },
      contesting: (id: number) => { const c = conns[id]; return alone(c) || c.why === "budget" ? [] : this.contesting(c); },
      rip: (ids: number[]) => { const out: Conn[] = []; for (const id of ids) if (conns[id].nodes) this.rip(conns[id], out); return out.map((c) => c.id); },
      lay: (id: number) => !alone(conns[id]) && lay(conns[id]),
      replan: this.gplan ? (ids: number[]) => this.replan(ids.map((id) => conns[id]).filter((c) => !alone(c) && c.why !== "budget")) : undefined,
      replanned: (keep: boolean) => this.replanned(keep),
    };
    if (!this.ladderRun) this.ladderRun = new Ladder<unknown>(host); else this.ladderRun.h = host;
    const n = this.ladderRun.run(); this.ladderRep = this.ladderRun.rep; return n > 0;
  }
  /** Copper's rescue(): one rung for one open connection, which disturbs nobody.  True when it was laid. */
  private rescueOne(c: Conn, rung: RescueRung, lay: (c: Conn) => boolean): boolean {
    if (c.nodes) return true;
    const loose = (f: () => boolean, extra: number): boolean => { this.noSteer = true; this.extraVias = extra; try { return f(); } finally { this.noSteer = false; this.extraVias = 0; } };
    if (rung === "via") return loose(() => lay(c), 1);
    if (rung === "half") return loose(() => this.fineLay(c), 0);
    if (rung === "neck") {
      const wide = c.cls, floor = Math.max(this.s.minTrackWidth || 0, 0.1); if (wide.width <= floor + 1e-9) return false;
      const thin = this.classFor(c.net, Math.min(floor, wide.width), 0, this.opts.smallVias !== false); if (thin === wide) return false;
      c.cls = thin; const ok = loose(() => lay(c) || this.fineLay(c), 1); if (!ok) c.cls = wide; else this.stat.necked = (this.stat.necked || 0) + 1;
      return ok;
    }
    return this.unescape(c, () => loose(() => lay(c), 1));
  }
  /** Copper's "other fan-out side" (fanout.re_escape): an end of the connection that starts from an escape laid
   *  before routing gives it up and leaves its pad by itself (access() tries both ways along the pad), when nothing
   *  else is routed from that escape.  Undone when the connection still cannot be laid. */
  private unescape(c: Conn, layIt: () => boolean): boolean {
    const G = this.G;
    for (const end of [c.a, c.b]) {
      const i = this.laid.findIndex((x) => x.anchors.includes(end)); if (i < 0) continue; const L = this.laid[i];
      if (this.conns.some((o) => o !== c && o.nodes && [o.a, o.b, ...(o.ends || [])].some((a) => L.anchors.includes(a)))) continue;
      const cur = L.anchors.map((a) => ({ p: a.p, layers: a.layers, shape: a.shape, narrow: a.narrow, axis: a.axis }));
      const swap = (sign: number) => {
        const list = G.obstacles.get(L.e.net) || []; G.obstacles.set(L.e.net, sign < 0 ? list.filter((o) => !L.obs.includes(o)) : list.concat(L.obs));
        for (const cl of G.classes.values()) for (const o of L.obs) stampClass(G, cl, o, sign, true);
        this.escapeObs = sign < 0 ? this.escapeObs.filter((o) => !L.obs.includes(o)) : this.escapeObs.concat(L.obs);
        L.anchors.forEach((a, k) => Object.assign(a, sign < 0 ? L.orig[k] : cur[k]));
        if (sign < 0) this.laid.splice(i, 1); else this.laid.splice(i, 0, L); this.oidx = null;
      };
      swap(-1);
      if (layIt()) { this.stat.unescaped = (this.stat.unescaped || 0) + 1; return true; }
      swap(1);
    }
    return false;
  }
  /** Where the connection fails: the middle of the stretch of its soft route (through this run's routes) that runs
   *  into other routes (Copper's fail record 'where'), and the routes it runs into.  The middle of its ends when it
   *  has no soft route. */
  private whereOf(c: Conn): { p: Pt; blockers: Conn[] } {
    const mid: Pt = [(c.a.p[0] + c.b.p[0]) / 2, (c.a.p[1] + c.b.p[1]) / 2];
    const soft = this.find(c, true); if (!soft) return { p: mid, blockers: [] };
    const bl = this.blockers(c, soft.res).filter((o) => !o.pair); if (!bl.length) return { p: mid, blockers: [] };
    const P = this.P, nodes = soft.res.nodes, r = c.cls.width / 2; let sx = 0, sy = 0, n = 0;
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1]; if (a.l !== b.l) continue; const pa = this.mm(a), pb = this.mm(b); const k = Math.max(1, Math.ceil(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / 0.25));
      for (let j = 0; j <= k; j++) {
        const p: Pt = [pa[0] + (pb[0] - pa[0]) * j / k, pa[1] + (pb[1] - pa[1]) * j / k]; const dot = { t: "circle", x: p[0], y: p[1], r };
        if (bl.some((o) => o.shapes.some((sh) => sh.layers.includes(a.l) && P.shapeGap(sh.shape, dot) < Math.max(c.cls.clr, o.cls.clr)))) { sx += p[0]; sy += p[1]; n++; }
      }
    }
    return { p: n ? [sx / n, sy / n] : mid, blockers: bl };
  }
  /** Copper's _cluster(): the connections that fight for the channel where `c` fails, inside a 12 x 12 mm box round
   *  it, nearest first in three ranks: other open connections; the routes in its way (its soft route's blockers and
   *  its minimum cut); routes taken up twice already.  Pairs and critical nets stay out of it. */
  private contesting(c: Conn): number[] {
    const { p, blockers } = this.whereOf(c); const half = CLUSTER_HALF;
    const named = new Set(blockers.map((o) => o.id)); const cut = this.cutFor(c, (o) => !!o.pair); if (cut) for (const o of cut) named.add(o.id);
    const inBox = (q: Pt) => Math.abs(q[0] - p[0]) <= half && Math.abs(q[1] - p[1]) <= half;
    const cands: [number, number, number][] = [];
    for (const o of this.conns) {
      if (o === c || o.moot || o.pair || o.partner || o.pairOnly || o.why === "budget") continue;
      let prio: number, pts: Pt[];
      if (!o.nodes) { prio = 0; pts = [o.a.p, o.b.p]; }
      else {
        if (isCritical(o.net, this.kindOf(o.net)) || this.netOf(o.net).guide.rank < Infinity) continue;
        if (named.has(o.id)) prio = 1; else if (o.rips >= 2 || (this.ripHist.get(o.id) || 0) > 0) prio = 2; else continue;
        pts = []; for (const sh of o.shapes) { const s = sh.shape as any; if (s.t !== "seg") { if (s.t === "circle") pts.push([s.x, s.y]); continue; } const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L2)) : 0; pts.push([s.a[0] + t * dx, s.a[1] + t * dy]); }
      }
      let d = Infinity; for (const q of pts) if (inBox(q)) d = Math.min(d, Math.hypot(q[0] - p[0], q[1] - p[1]));
      if (d < Infinity) cands.push([prio, Math.round(d * 1e6) / 1e6, o.id]);
    }
    cands.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    return cands.slice(0, CLUSTER_MAX - 1).map((x) => x[2]);
  }
  private planConnOf(c: Conn): PlanConn {
    const end = (a: Anchor) => ({ p: a.p, layers: a.layers, box: a.shape && !a.plane ? bboxOf(a.shape) : undefined });
    return { id: c.id, net: c.net, a: end(c.a), b: end(c.b), demand: c.cls.width + c.cls.clr };
  }
  /** Copper's _feedback(): book away the capacity of the tile borders where the open connections fail (on the
   *  layers their corridors put there), plan again for them and the routed connections whose corridors cross those
   *  borders (at most FEEDBACK_MAX_CONNS), steer all of them by their new corridors, and take the routed ones up.
   *  Returns what to lay again, or null. */
  private replan(failed: Conn[]): number[] | null {
    const pl = this.gplan, ref = this.planRef; if (!pl || !ref) return null; const G = this.G, k = pl.k, nx = pl.nx, ny = pl.ny;
    const book: [number, number, number, number, number][] = []; const pairs: [number, number][] = []; const affected: Conn[] = [];
    for (const c of failed) {
      const cor = pl.corridors.get(c.id); if (!cor) continue; const { p } = this.whereOf(c);
      const tx = Math.min(nx - 1, Math.max(0, Math.floor((p[0] - G.ox) / G.g / k))), ty = Math.min(ny - 1, Math.max(0, Math.floor((p[1] - G.oy) / G.g / k))), t = ty * nx + tx;
      const layers = cor.layer[t] >= 0 ? [cor.layer[t]] : G.routable.map((r, l) => r ? l : -1).filter((l) => l >= 0); let any = false;
      for (const [ex, ey, side, bx, by] of [[tx, ty, 0, tx + 1, ty], [tx - 1, ty, 0, tx - 1, ty], [tx, ty, 1, tx, ty + 1], [tx, ty - 1, 1, tx, ty - 1]]) {
        if (bx < 0 || by < 0 || bx >= nx || by >= ny || ex < 0 || ey < 0 || !cor.tiles[by * nx + bx]) continue;
        for (const l of layers) book.push([l, ex, ey, side, c.cls.width + c.cls.clr]); pairs.push([t, by * nx + bx]); any = true;
      }
      if (any) affected.push(c);
    }
    this.stat.replans = (this.stat.replans || 0) + 1; if (!book.length) return null;
    this.stat.replanBooked = (this.stat.replanBooked || 0) + book.length;
    const have = new Set(affected.map((c) => c.id));
    for (const o of this.conns.slice().sort((a, b) => a.len - b.len || a.id - b.id)) {
      if (affected.length >= FEEDBACK_MAX_CONNS) break;
      if (have.has(o.id) || !o.nodes || o.moot || o.pair || o.partner || o.pairOnly || isCritical(o.net, this.kindOf(o.net)) || this.netOf(o.net).guide.rank < Infinity) continue;
      const cor = pl.corridors.get(o.id); if (cor && pairs.some(([a, b]) => cor.tiles[a] && cor.tiles[b])) { affected.push(o); have.add(o.id); }
    }
    const fixed: { conn: PlanConn; path: number[] }[] = []; for (const [id, cor] of pl.corridors) if (!have.has(id) && this.conns[id]) fixed.push({ conn: this.planConnOf(this.conns[id]), path: cor.path });
    const po = this.planOpts();
    const res = globalPlan({ G, maps: ref.fixed, vmaps: ref.vfixed, pitch: ref.width + ref.clr, viaPitch: ref.viaD + ref.clr, need: ref.clr + ref.width / 2, pref: this.pref, viaMm: this.W.via / Math.max(1e-6, this.W.length), tile: pl.T, iters: po.iters, book: this.booked.concat(book), fixed },
      affected.map((c) => this.planConnOf(c)));
    if (res.k !== pl.k || res.nx !== nx || res.ny !== ny) return null;
    this.stat.replanConns = (this.stat.replanConns || 0) + affected.length;
    const cors = new Map<number, Corridor | undefined>(); for (const c of affected) cors.set(c.id, pl.corridors.get(c.id));
    for (const [id, cor] of res.corridors) pl.corridors.set(id, Object.assign({}, cor, { moved: true }));   // steered by its new corridor
    this.replanUndo = { cors, book };
    const out: Conn[] = []; for (const c of affected) if (c.nodes) this.rip(c, out);
    const ids = new Set(affected.map((c) => c.id)); for (const c of out) ids.add(c.id);
    return Array.from(ids).map((id) => this.conns[id]).sort((a, b) => a.len - b.len || a.id - b.id).map((c) => c.id);
  }
  private replanned(keep: boolean): void {
    const u = this.replanUndo, pl = this.gplan; this.replanUndo = null; if (!u || !pl) return;
    if (keep) { this.booked.push(...u.book); return; }
    for (const [id, cor] of u.cors) if (cor) pl.corridors.set(id, cor); else pl.corridors.delete(id);
  }
  /** Copper's rescue at half the window pitch: the connection alone, searched on a lattice of half the grid's pitch
   *  over a window round its ends, where the board's copper and this run's routes are rasterised again; every piece
   *  of the result is then checked exactly against the copper round it.  Vias only on cells of the main grid (so the
   *  rest of the router can name them), and the route's grid nodes are its nodes rounded onto the main grid (used for
   *  tees and lengths; the copper itself is exact). */
  private fineLay(conn: Conn): boolean {
    const G = this.G, net = this.netOf(conn.net), cls = conn.cls, gd = net.guide, h = G.g / 2; if (conn.planeOnly !== undefined) return false;
    const comp = this.components(net); if (comp[conn.a.cluster] === comp[conn.b.cluster]) return false;
    const span = Math.max(Math.abs(conn.a.p[0] - conn.b.p[0]), Math.abs(conn.a.p[1] - conn.b.p[1])), m = Math.max(2, 0.3 * span);
    const ix0 = Math.max(0, Math.floor((Math.min(conn.a.p[0], conn.b.p[0]) - m - G.ox) / G.g)), ix1 = Math.min(G.W - 1, Math.ceil((Math.max(conn.a.p[0], conn.b.p[0]) + m - G.ox) / G.g));
    const iy0 = Math.max(0, Math.floor((Math.min(conn.a.p[1], conn.b.p[1]) - m - G.oy) / G.g)), iy1 = Math.min(G.H - 1, Math.ceil((Math.max(conn.a.p[1], conn.b.p[1]) + m - G.oy) / G.g));
    const W2 = 2 * (ix1 - ix0) + 1, H2 = 2 * (iy1 - iy0) + 1, n2 = W2 * H2; if (W2 < 3 || H2 < 3 || n2 > FINE_CELLS) return false;
    const ox = G.ox + ix0 * G.g, oy = G.oy + iy0 * G.g;
    // a mask of the main grid seen from the fine one: a fine cell between main cells takes all of them (`any`: any of
    // them set, else every one of them), so what the main grid keeps out stays out
    const sample = (src: ArrayLike<number> | null | undefined, any = true): Uint8Array | null => {
      if (!src) return null; const out = new Uint8Array(n2);
      for (let fy = 0; fy < H2; fy++) { const ya = iy0 + (fy >> 1), yb = iy0 + ((fy + 1) >> 1); for (let fx = 0; fx < W2; fx++) { const xa = ix0 + (fx >> 1), xb = ix0 + ((fx + 1) >> 1);
        const v = [src[ya * G.W + xa], src[ya * G.W + xb], src[yb * G.W + xa], src[yb * G.W + xb]]; out[fy * W2 + fx] = (any ? v.some((x) => x) : v.every((x) => x)) ? 1 : 0; } }
      return out;
    };
    const noVia = new Uint16Array(n2); const nv = sample(G.noVia)!; for (let fy = 0; fy < H2; fy++) for (let fx = 0; fx < W2; fx++) { const i = fy * W2 + fx; noVia[i] = nv[i] || (fx & 1) || (fy & 1) ? 1 : 0; }
    for (const b of gd.viaAvoid) for (let fy = Math.max(0, 2 * (b[1] - iy0)); fy <= Math.min(H2 - 1, 2 * (b[3] - iy0)); fy++) for (let fx = Math.max(0, 2 * (b[0] - ix0)); fx <= Math.min(W2 - 1, 2 * (b[2] - ix0)); fx++) noVia[fy * W2 + fx] = 1;
    // the copper of every other net near the window: the board's, the escapes and this run's routes
    const reach = cls.clr + cls.viaD + 2, wx0 = ox - reach, wy0 = oy - reach, wx1 = ox + (W2 - 1) * h + reach, wy1 = oy + (H2 - 1) * h + reach;
    const obs = new Map<string, Obstacle[]>(); const put = (o: Obstacle) => { const bb = bboxOf(o.shape); if (bb[0] > wx1 || bb[2] < wx0 || bb[1] > wy1 || bb[3] < wy0) return; let l = obs.get(o.net); if (!l) obs.set(o.net, l = []); l.push(o); };
    for (const [k, list] of G.obstacles) if (k !== conn.net) for (const o of list) put(o);
    for (const o of this.conns) if (o.nodes && o.net !== conn.net) for (const sh of o.shapes) put(sh);
    const rmin = this.s.clearance + this.s.trackWidth / 2;
    const G2: Grid = { g: h, ox, oy, W: W2, H: H2, layers: G.layers, routable: G.routable, noVia, thru: new Uint8Array(n2), outside: sample(G.outside), keep: G.keep.map((k) => sample(k)),
      quiet: sample(G.quiet) || undefined, clear: sample(G.clear) || undefined, edgeClr: G.edgeClr, holeClr: G.holeClr, margin: h * h / (4 * Math.max(rmin, 0.05)) + 0.002, obstacles: obs, classes: new Map(), weights: G.weights,
      kinds: G.kinds, sep: G.sep, nearPad: sample(G.nearPad, false) || undefined, layerCost: G.layerCost };
    const holes = new Set<number>();   // the net's own plated holes: changing layer there is free and lays no via
    for (const o of G.obstacles.get(conn.net) || []) if (o.thru) { const fx = Math.round((o.thru[0] - ox) / h), fy = Math.round((o.thru[1] - oy) / h); if (fx >= 0 && fy >= 0 && fx < W2 && fy < H2) { G2.thru[fy * W2 + fx] = 1; holes.add(fy * W2 + fx); } }
    const c2 = buildClass(G2, cls.key, cls.width, cls.clr, cls.viaD, cls.viaDrill, cls.kind, cls.open !== false, !!cls.feed);
    for (const b of gd.avoid) for (const maps of [c2.full, c2.fixed, c2.vfull, c2.vfixed]) for (const mp of maps) for (let fy = Math.max(0, 2 * (b[1] - iy0)); fy <= Math.min(H2 - 1, 2 * (b[3] - iy0)); fy++) for (let fx = Math.max(0, 2 * (b[0] - ix0)); fx <= Math.min(W2 - 1, 2 * (b[2] - ix0)); fx++) mp[fy * W2 + fx]++;
    const maps = c2.full;
    let rt = G.routable.slice();
    if (gd.allowed) { const want = gd.allowed.map((v, l) => v && G.routable[l]); if (want.some(Boolean)) { rt = want.slice(); for (const e of [conn.a, conn.b]) if (!e.layers.some((l) => want[l])) for (const l of e.layers) if (G.routable[l]) rt[l] = true; } }
    // the net's trees on each side (a route may end on one, a tee), and its pour
    const owner = new Map<number, number>();
    const tree = (cluster: number): Node[] => { const out: Node[] = []; for (const o of net.conns) if (o.nodes && o !== conn && comp[o.a.cluster] === comp[cluster]) { const cs: Node[] = []; this.cellsOf(o, cs, new Map()); for (const nd of cs) { const fx = 2 * (nd.ix - ix0), fy = 2 * (nd.iy - iy0); if (fx < 0 || fy < 0 || fx >= W2 || fy >= H2) continue; out.push({ ix: fx, iy: fy, l: nd.l }); owner.set(nd.l * n2 + fy * W2 + fx, o.id); } } return out; };
    let ta = tree(conn.a.cluster), tb = tree(conn.b.cluster);
    const zoneAt = (cluster: number) => !!net.zoneCells && comp[cluster] === comp[net.zoneCluster];
    const flip = ta.length > tb.length || (zoneAt(conn.a.cluster) && !zoneAt(conn.b.cluster)); if (flip) { const t = ta; ta = tb; tb = t; }
    const A = flip ? conn.b : conn.a, B = flip ? conn.a : conn.b;
    const access = (a: Anchor): Terminal | null => {
      const cx = (a.p[0] - ox) / h, cy = (a.p[1] - oy) / h; const ls = a.layers.filter((l) => rt[l]); if (!ls.length) return null; const R = a.shape ? Math.min(12, Math.ceil(1 / h)) : 0;
      let best: Terminal | null = null, bd = Infinity;
      for (let iy = Math.round(cy) - R; iy <= Math.round(cy) + R; iy++) for (let ix = Math.round(cx) - R; ix <= Math.round(cx) + R; ix++) {
        if (ix < 0 || iy < 0 || ix >= W2 || iy >= H2) continue; const d = Math.hypot(ix - cx, iy - cy); if (d >= bd) continue;
        if (R && d > 0.71 && pointGap(a.shape, ox + ix * h, oy + iy * h) > 0) continue;
        const free = ls.filter((l) => !maps[l][iy * W2 + ix]); if (!free.length) continue; bd = d; best = { ix, iy, layers: free };
      }
      return best;
    };
    const src = access(A), tgt = access(B); if (!src) return false;
    const term = tb.slice(); const zoneSet = new Set<number>();
    if (zoneAt(B.cluster)) for (const z of net.zoneCells!) { const fx = 2 * (z.ix - ix0), fy = 2 * (z.iy - iy0); if (fx < 0 || fy < 0 || fx >= W2 || fy >= H2 || maps[z.l][fy * W2 + fx]) continue; if (!rt[z.l]) { rt = rt.slice(); rt[z.l] = true; } term.push({ ix: fx, iy: fy, l: z.l }); zoneSet.add(z.l * n2 + fy * W2 + fx); }
    if (!tgt && !term.length) return false;
    let used = 0; for (const o of net.conns) if (o.nodes && o !== conn && o.feat) used += o.feat.vias;
    const perConn = this.opts.maxViasPerConnection; let maxVias = Math.min(gd.maxVias - used, this.viaCap, perConn === undefined || perConn === null ? Infinity : Math.max(0, +perConn));
    if (this.extraVias && maxVias >= 1 && maxVias < Infinity) maxVias += this.extraVias;
    const res = probe({ G: G2, maps, vmaps: c2.vfull, src, tgt, term, win: { x0: 0, y0: 0, x1: W2 - 1, y1: H2 - 1 }, pref: this.pref, W: this.W, allowVias: gd.allowVias && maxVias > 0, maxSteps: 8e6, routable: rt, maxVias: maxVias === Infinity ? undefined : maxVias });
    if (!res) return false;
    const nodes = simplify(res.nodes); const mm = (n: Node): Pt => [r6(ox + n.ix * h), r6(oy + n.iy * h)];
    const w = cls.width, clr = cls.clr, all = G.layers.map((_, i) => i); const shapes: Obstacle[] = [], viaCells: number[] = [], stubs: [Pt, Pt, number][] = [];
    const vclr = Math.max(clr, (G.holeClr || 0) + HOLE_SLACK - (cls.viaD - cls.viaDrill) / 2);
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1];
      if (a.l !== b.l) { const fi = a.iy * W2 + a.ix; if (holes.has(fi)) continue; if ((a.ix & 1) || (a.iy & 1)) return false; const gi = (iy0 + a.iy / 2) * G.W + ix0 + a.ix / 2; if (viaCells.includes(gi)) continue; viaCells.push(gi); const p = mm(a); shapes.push({ net: conn.net, layers: all, shape: { t: "circle", x: p[0], y: p[1], r: cls.viaD / 2 }, clr: vclr }); }
      else shapes.push({ net: conn.net, layers: [a.l], shape: { t: "seg", a: mm(a), b: mm(b), r: w / 2 }, clr });
    }
    const piece = (from: Pt, to: Pt, l: number, sw: number) => { if (Math.hypot(to[0] - from[0], to[1] - from[1]) > 1e-4) { stubs.push([from, to, l]); shapes.push({ net: conn.net, layers: [l], shape: { t: "seg", a: from, b: to, r: sw / 2 }, clr }); } };
    const first = nodes[0], last = nodes[nodes.length - 1];
    piece(A.p, mm(first), first.l, A.narrow ? Math.min(w, A.narrow) : w); if (!res.onTerm) piece(B.p, mm(last), last.l, B.narrow ? Math.min(w, B.narrow) : w);
    // every piece exactly against everything round it (the fine maps are a raster too)
    this.cur = conn; this.curSoft = false;
    for (const o of shapes) for (const l of o.layers) if (!this.clearOf(o.shape, l, conn.net, o.clr)) return false;
    const key = last.l * n2 + last.iy * W2 + last.ix;
    let main = nodes.map((n) => ({ ix: ix0 + (n.ix >> 1), iy: iy0 + (n.iy >> 1), l: n.l })); main = simplify(main); if (main.length < 2) main = [main[0], main[0]];
    conn.nodes = main; conn.shapes = shapes; conn.viaCells = viaCells; conn.stubs = stubs; conn.feat = featuresOf(G2, nodes, this.pref);
    conn.zoneEnd = res.onTerm && zoneSet.has(key) && !owner.has(key); conn.landed = res.onTerm ? owner.get(key) ?? -1 : -1;
    this.place(conn, 1); this.stat.fine = (this.stat.fine || 0) + 1;
    return true;
  }
  /** Once everything is laid there is often room that was not there (or not known to be free) when a route chose to
   *  change layers.  Each route with vias is tried again on the finished board with none, then with fewer; it is
   *  only replaced when that works and does not send it on a long way round. */
  fewerVias(timeUp: () => boolean): void {
    const conns = this.conns; const todo = conns.filter((c) => c.nodes && c.viaCells.length && !c.zoneEnd).sort((a, b) => b.viaCells.length - a.viaCells.length);
    for (const c of todo) {
      if (timeUp()) break; if (!c.nodes || this.netOf(c.net).guide.allowed || conns.some((o) => o.nodes && o.landed === c.id)) continue;   // a plan that names the net's layers stands
      const old = { nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd, ends: c.ends, a: c.a, b: c.b };
      const n = old.viaCells.length, len = old.feat ? old.feat.length : c.len; this.rip(c); let done = false;
      for (const cap of n > 2 ? [0, n - 2] : [0]) {
        this.viaCap = cap; let found: Found | null = null; try { found = this.find(c, false); } finally { this.viaCap = Infinity; }
        if (found && found.res.feat.vias < n && found.res.feat.length <= len * 2.5 + 4) { this.commit(c, found); this.stat.viasSaved = (this.stat.viasSaved || 0) + n - c.viaCells.length; done = true; break; }
      }
      if (!done) { Object.assign(c, old); this.place(c, 1); }
    }
  }
  /** A supply track that runs a long way between two pads of a net that has an inner plane is taken up again when
   *  each pad can drop into the plane through a via beside it, as the owner's boards do (Ember's +3.3V: 79 mm of track
   *  by hand where the router laid 194).  Done after every connection is routed, so it only ever frees room. */
  planeShortcuts(timeUp: () => boolean): void {
    const G = this.G, LONG = 4; const dbg = (...m: unknown[]) => { const g = globalThis as { KC_PS_DEBUG?: unknown; process?: { env?: Record<string, string | undefined> } }; if (g.KC_PS_DEBUG || g.process?.env?.KC_PS_DEBUG) console.error("ps", ...m); };
    type Old = Pick<Conn, "nodes" | "shapes" | "viaCells" | "landed" | "feat" | "stubs" | "zoneEnd" | "ends" | "a" | "b" | "why">;
    const save = (c: Conn): Old => ({ nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd, ends: c.ends, a: c.a, b: c.b, why: c.why });
    const lenOf = (c: Conn) => c.feat ? c.feat.length : c.len;
    for (const net of this.nets) {
      if (!net.drop || timeUp()) continue; const drop = net.drop;
      const order = net.conns.filter((c) => c.nodes && !c.stitch).sort((a, b) => lenOf(b) - lenOf(a));
      for (const c of order) {
        if (timeUp()) break; if (!c.nodes || c.moot || c.pair || c.partner || c.a.plane || c.b.plane) continue;
        const len = lenOf(c); if (len < LONG) continue; const da = drop(c.a), db = drop(c.b); if (!da || !db) { dbg(c.net, this.padName(c.a.p), this.padName(c.b.p), "no drop", !!da, !!db); continue; }
        const pl = da.layers[0]; if (!net.pour || !net.pour.mask[pl] || net.zoneCluster < 0) continue;
        // the track and every branch that lands on it come up together; the branches are laid again afterwards
        const tree: Conn[] = []; const walk = (x: Conn) => { tree.push(x); for (const o of this.conns) if (o.nodes && o.landed === x.id && !tree.includes(o)) walk(o); }; walk(c);
        if (tree.some((x) => x.pair || x.partner)) continue;
        const olds = tree.map(save); const before = tree.reduce((t, x) => t + lenOf(x), 0);
        // a way down must really reach the plane through its one via: a track of the net on the pad's layer may hang on
        // a top pour that never fills that far
        this.rip(c); const made: Conn[] = []; let ok = true; let after = 0;
        const downAt = (n: Node, f: { res: { feat: Features } }) => n.l === pl && f.res.feat.vias === 1;
        for (const [a, d] of [[olds[0].ends ? olds[0].ends[0] : olds[0].a, da], [olds[0].ends ? olds[0].ends[1] : olds[0].b, db]] as [Anchor, Anchor][]) {
          const h = this.adhoc(c.net, a, d); h.id = this.conns.length; h.cls = c.cls; h.a.cluster = a.cluster; h.b.cluster = net.zoneCluster; h.planeOnly = pl;   // the plane only, through one via: a pour or a track of the net on the pad's own layer may hang on a fill that never reaches it
          const f = this.find(h, false);   // pad to plane: the plane is the net's poured island
          // a way down that runs along the plane's own layer would cut the plane: only the via may touch it.  And it must
          const onPlane = f ? f.res.nodes.reduce((t, n, i, ns) => t + (i && n.l === pl && ns[i - 1].l === pl ? Math.hypot(n.ix - ns[i - 1].ix, n.iy - ns[i - 1].iy) * G.g : 0), 0) : 0;
          if (!f || onPlane > 0.3 || f.res.feat.vias > 1 || !downAt(f.res.nodes[f.res.nodes.length - 1], f)) { dbg(c.net, this.padName(a.p), "fail", !!f, onPlane, f && f.res.feat.vias); ok = false; break; }
          this.conns.push(h); net.conns.push(h); this.commit(h, f); made.push(h); after += lenOf(h);
        }
        if (ok) for (const x of tree.slice(1).sort((p, q) => p.len - q.len)) {
          if (x.nodes) { after += lenOf(x); continue; }
          const f = this.find(x, false); if (!f) { dbg(c.net, this.padName(x.a.p), "branch failed"); ok = false; break; } this.commit(x, f); after += lenOf(x);
        }
        dbg(c.net, this.padName(c.a.p), this.padName(c.b.p), "tree", tree.length, "ok", ok, after.toFixed(1), before.toFixed(1));
        if (ok && after < before * 0.6) {
          // the vias must land in the plane's main body as it will really fill, not in a piece cut off by other copper
          const st = this.pourState(net); if (!st || made.some((h) => st.connRoot(h) !== st.main)) { dbg(c.net, "via in a cut-off piece of the plane"); ok = false; }
        }
        if (ok && after < before * 0.6) { c.moot = true; this.stat.planeShortcuts = (this.stat.planeShortcuts || 0) + 1; continue; }
        // put everything back as it was
        for (const x of tree) if (x.nodes) this.rip(x); for (const h of made) if (h.nodes) this.rip(h);
        for (const h of made) { this.conns.splice(this.conns.indexOf(h), 1); net.conns.splice(net.conns.indexOf(h), 1); }
        tree.forEach((x, k) => { if (x.nodes) this.rip(x); Object.assign(x, olds[k]); }); for (const x of tree) this.place(x, 1);
      }
    }
  }
  // ------------------------------------------------------------------ copper pours
  /** How a net's pour really falls once it is filled: the pour is cut into pieces by the other nets' copper, and a pad
   *  or a track end that sits in a piece is joined only to what else sits in that piece.  Returns which of the net's
   *  original islands end up joined (through pour pieces and this run's tracks), and the pieces of the main body. */
  private pourState(net: NetInfo): { root: (g: number) => number; main: number; cells: Node[]; connRoot: (c: Conn) => number } | null {
    const G = this.G, W = G.W, H = G.H, pour = net.pour!; const nc = net.cls;
    const key = `pour/${pour.width}/${pour.clr}`; let cls = G.classes.get(key);
    if (!cls) { cls = buildClass(G, key, pour.width, pour.clr, nc.viaD, nc.viaDrill); for (const o of this.conns) if (o.nodes) for (const sh of o.shapes) stampClass(G, cls, sh, 1, false); }
    const label: (Int32Array | null)[] = pour.mask.map(() => null); let pieces = 0;
    this.lift(net, 1, cls);
    try {
      for (let l = 0; l < pour.mask.length; l++) {
        const mask = pour.mask[l]; if (!mask) continue; const free = cls.full[l]; const lab = label[l] = new Int32Array(W * H); const stack: number[] = [];
        for (let i0 = 0; i0 < W * H; i0++) {
          if (!mask[i0] || free[i0] || lab[i0]) continue; lab[i0] = ++pieces; stack.push(i0);
          while (stack.length) { const i = stack.pop()!; const x = i % W;
            for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < W * H && mask[j] && !free[j] && !lab[j]) { lab[j] = pieces; stack.push(j); } }
        }
      }
    } finally { this.lift(net, -1, cls); }
    const anchors = net.anchors || []; let ng = 0; for (const a of anchors) ng = Math.max(ng, (a.grp || 0) + 1);
    const routed = net.conns.filter((c) => c.nodes); const parent = Array.from({ length: ng + pieces + 1 + routed.length }, (_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }; const join = (a: number, b: number) => { parent[find(a)] = find(b); };
    const at = (l: number, ix: number, iy: number) => { const lab = label[l]; return lab && ix >= 0 && iy >= 0 && ix < W && iy < H ? lab[iy * W + ix] : 0; };
    for (const a of anchors) {   // a pad joins the piece its copper lies in
      const sh = a.shape as any; const r = sh ? (sh.t === "circle" ? sh.r : Math.min(sh.w || 0, sh.h || 0) / 2 || sh.r || 0) : 0; const n = Math.max(0, Math.floor(r / G.g));
      const cx = Math.round((a.p[0] - G.ox) / G.g), cy = Math.round((a.p[1] - G.oy) / G.g);
      for (const l of a.layers) for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) { if (dx * dx + dy * dy > n * n) continue; const id = at(l, cx + dx, cy + dy); if (id) join(a.grp || 0, ng + id); }
    }
    const node = new Map<Conn, number>(); routed.forEach((c, i) => node.set(c, ng + pieces + 1 + i)); const owner = new Map<number, number>();
    for (const c of routed) {
      const me = node.get(c)!; const first = this.mm(c.nodes![0]), last = this.mm(c.nodes![c.nodes!.length - 1]);
      for (const e of c.ends || [c.a, c.b]) if (c.stubs.some((st) => st[0] === e.p) || [first, last].some((q) => Math.hypot(q[0] - e.p[0], q[1] - e.p[1]) < 1e-3)) join(me, e.grp || 0);
      if (c.landed >= 0 && node.has(this.conns[c.landed])) join(me, node.get(this.conns[c.landed])!);
      const cells: Node[] = []; this.cellsOf(c, cells, owner); for (const n of c.nodes!) cells.push(n);
      for (const n of cells) { const id = at(n.l, n.ix, n.iy); if (id) join(me, ng + id); }
      for (const gi of c.viaCells) for (let l = 0; l < label.length; l++) { const id = at(l, gi % W, (gi / W) | 0); if (id) join(me, ng + id); }
    }
    const count = new Map<number, number>(); const hasPiece = new Set<number>(); for (let i = 1; i <= pieces; i++) hasPiece.add(find(ng + i));
    for (const a of anchors) { const r = find(a.grp || 0); count.set(r, (count.get(r) || 0) + 1); }
    let main = -1; for (const [r, n] of count) if (hasPiece.has(r) && (main < 0 || n > count.get(main)!)) main = r;
    if (main < 0) return null;
    const cells: Node[] = []; for (let l = 0; l < label.length; l++) { const lab = label[l]; if (!lab) continue; for (let i = 0; i < W * H; i++) if (lab[i] && find(ng + lab[i]) === main) cells.push({ ix: i % W, iy: (i / W) | 0, l }); }
    return { root: (g) => find(g), main, cells, connRoot: (c) => node.has(c) ? find(node.get(c)!) : -1 };
  }
  /** Tracks cut a pour into pieces.  Whatever the pour was counted on to join but that ends up in a cut-off piece is
   *  joined to the main body with a track of its own; a route that ended in a cut-off piece is taken out again. */
  stitch(timeUp: () => boolean): void {
    if ((this.opts as any).stitch === false) return;
    for (const net of this.nets) {
      if (!net.pour || !net.anchors) continue;
      for (let round = 0; round < 4 && !timeUp(); round++) {
        let st = this.pourState(net); if (!st) break;
        let dead = false; for (const c of net.conns) if (c.nodes && c.zoneEnd && st.connRoot(c) !== st.main) { this.rip(c); dead = true; this.stat.deadEnds = (this.stat.deadEnds || 0) + 1; }
        if (dead) { st = this.pourState(net); if (!st) break; }
        // the islands as they really are
        const idx = new Map<number, number>(); const of = (a: Anchor) => { const r = st!.root(a.grp || 0); let i = idx.get(r); if (i === undefined) idx.set(r, i = idx.size); return i; };
        of(net.anchors.find((a) => st!.root(a.grp || 0) === st!.main)!);
        for (const a of net.anchors) a.cluster = of(a);
        net.clusters = idx.size; net.zoneCluster = 0; net.zoneCells = st.cells;
        for (const c of net.conns) if (c.nodes && c.a.cluster !== c.b.cluster) {   // it joined something other than the pad it set out for
          if (!c.ends) c.ends = [c.a, c.b]; const r = st.connRoot(c); if (st.root(c.a.grp || 0) === r) c.b = c.a; else c.a = c.b;
        }
        if (idx.size < 2) break;
        let gained = false;
        for (let k = 1; k < idx.size && !timeUp(); k++) {
          const comp = this.components(net); if (comp[k] === comp[0]) continue;
          let c = net.conns.find((x) => !x.nodes && ((x.a.cluster === k) !== (x.b.cluster === k)));
          if (!c) {
            let best: [number, Anchor, Anchor] | null = null;
            for (const a of net.anchors) if (a.cluster === k) for (const b of net.anchors) if (comp[b.cluster] === comp[0]) { const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); if (!best || d < best[0]) best = [d, a, b]; }
            if (!best) continue;
            c = { id: this.conns.length, net: net.key, cls: this.classFor(net.key, Math.min(this.roomAt(best[1], net.key), this.roomAt(best[2], net.key))), a: best[1], b: best[2], len: best[0], nodes: null, shapes: [], viaCells: [], landed: -1, rips: 0, feat: null, stubs: [], zoneEnd: false, stitch: true };
            this.conns.push(c); net.conns.push(c);
          }
          c.why = undefined; const found = this.find(c, false); if (found) { this.commit(c, found); gained = true; this.stat.stitched = (this.stat.stitched || 0) + 1; } else this.stat.stitchFailed = (this.stat.stitchFailed || 0) + 1;
        }
        // a connection that was never laid but whose ends are joined after all (through the pour, or another track) is settled
        const comp = this.components(net); for (const c of net.conns) c.moot = !c.nodes && comp[c.a.cluster] === comp[c.b.cluster];
        if (!gained) break;
      }
      // A drop into the pour that no longer joins anything (its pad has since been tied to the main body another way,
      // or it ended in a piece nothing else is in) is a stub: take out each one the net stays whole without.
      const loose = () => { const st = this.pourState(net); if (!st) return Infinity; let n = 0; for (const a of net.anchors!) if (st.root(a.grp || 0) !== st.main) n++; return n; };
      let base = -1;
      for (const c of net.conns) {
        if (timeUp()) break; if (!c.nodes || !c.zoneEnd || this.conns.some((o) => o.nodes && o.landed === c.id)) continue; if (base < 0) base = loose();
        const old = { nodes: c.nodes, shapes: c.shapes, viaCells: c.viaCells, landed: c.landed, feat: c.feat, stubs: c.stubs, zoneEnd: c.zoneEnd, ends: c.ends, a: c.a, b: c.b };
        this.rip(c);
        if (loose() > base) { Object.assign(c, old); this.place(c, 1); } else { c.moot = true; this.stat.stubsRemoved = (this.stat.stubsRemoved || 0) + 1; }
      }
    }
  }
  /** Supply tracks are routed at the class width, so they never cost a connection, and then fattened piece by
   *  piece wherever the exact clearances leave the room — wide along the run, necked down at tight pads. */
  widen(): void {
    for (const c of this.conns) {
      if (!c.nodes) continue; const want = this.powerWidth(c.net) || this.signalWidth(c); if (!(want > c.cls.width + 1e-6)) continue;
      this.place(c, -1); this.cur = c; this.curSoft = false;
      for (const o of c.shapes) {
        const sh = o.shape as any; if (sh.t !== "seg") continue; const r0 = sh.r;
        for (const w of [want, (want + c.cls.width) / 2]) { sh.r = w / 2; if (this.clearOf(sh, o.layers[0], c.net, c.cls.clr)) break; sh.r = r0; }
      }
      this.place(c, 1);
    }
  }
  /** The exact check: every new track and via against the real shapes, at the real clearances.  Offenders are dropped. */
  validate(): void {
    const G = this.G, P = this.P; const B = 2; const idx = new Map<string, { o: Obstacle; bb: number[]; conn: number }[]>();
    const bbOf = (s: Shape): number[] => { if (s.t === "circle") return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r]; if (s.t === "seg") return [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const pts: Pt[] = s.pts || [[s.x - Math.hypot(s.w, s.h) / 2, s.y - Math.hypot(s.w, s.h) / 2], [s.x + Math.hypot(s.w, s.h) / 2, s.y + Math.hypot(s.w, s.h) / 2]]; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } const o = s.r || 0; return [x0 - o, y0 - o, x1 + o, y1 + o]; };
    const add = (o: Obstacle, conn: number) => { const bb = bbOf(o.shape); const e = { o, bb, conn }; for (let y = Math.floor(bb[1] / B); y <= Math.floor(bb[3] / B); y++) for (let x = Math.floor(bb[0] / B); x <= Math.floor(bb[2] / B); x++) { const k = x + "," + y; let l = idx.get(k); if (!l) idx.set(k, l = []); l.push(e); } };
    for (const list of G.obstacles.values()) for (const o of list) { if (o.shape.t === "path" && o.shape.pts.length > 2) { for (let i = 0; i + 1 < o.shape.pts.length; i++) add({ net: o.net, layers: o.layers, clr: o.clr, edge: o.edge, shape: { t: "seg", a: o.shape.pts[i], b: o.shape.pts[i + 1], r: o.shape.r || 0 } }, -1); } else add(o, -1); }
    const bad = new Set<number>(); const maxClr = Math.max(G.edgeClr, ...Array.from(G.classes.values()).map((c) => c.clr), this.s.clearance);
    for (const c of this.conns) {
      if (!c.nodes) continue;
      for (const o of c.shapes) {
        const bb = bbOf(o.shape); const seen = new Set<any>();
        for (let y = Math.floor((bb[1] - maxClr) / B); y <= Math.floor((bb[3] + maxClr) / B) && !bad.has(c.id); y++) for (let x = Math.floor((bb[0] - maxClr) / B); x <= Math.floor((bb[2] + maxClr) / B) && !bad.has(c.id); x++) {
          for (const e of idx.get(x + "," + y) || []) {
            if (seen.has(e) || e.conn === c.id) continue; seen.add(e);
            if (e.o.net && e.o.net === o.net) continue; if (!e.o.layers.some((l) => o.layers.includes(l))) continue;
            const need = (e.o.edge ? G.edgeClr : Math.max(e.o.clr, o.clr)) - 1e-4;
            if (e.bb[0] > bb[2] + need || e.bb[2] < bb[0] - need || e.bb[1] > bb[3] + need || e.bb[3] < bb[1] - need) continue;
            const gap = P.shapeGap(e.o.shape, o.shape); if (gap < need) { if ((globalThis as { KC_PS_DEBUG?: unknown }).KC_PS_DEBUG) console.error("drop", c.net, this.padName(c.a.p), this.padName(c.b.p), "vs", e.o.net, gap.toFixed(3), need.toFixed(3), JSON.stringify(o.shape), JSON.stringify(e.o.shape).slice(0, 240)); bad.add(c.id); c.why = "rule"; this.ruleHit.set(c.id, e.o.net); this.dropped.push({ net: c.net, other: e.o.net, gap, need, shape: o.shape, against: e.o.shape, stub: c.stubs.some((st) => st[0] === o.shape.a) }); break; }
          }
        }
        if (bad.has(c.id)) break;
      }
      if (!bad.has(c.id)) for (const o of c.shapes) add(o, c.id);
    }
    const kill = (id: number) => { const c = this.conns[id]; if (!c.nodes) return; this.place(c, -1); c.nodes = null; c.shapes = []; c.viaCells = []; c.stubs = []; if (!c.why) c.why = "rule"; for (const d of this.conns) if (d.nodes && d.landed === id) kill(d.id); };
    for (const id of bad) kill(id);
  }

  fenceVias: { p: Pt; net: string; cls: RuleClass; obj: any }[] = []; fenceReports: FenceReport[] = [];
  /** Ground vias beside high-frequency tracks and their layer changes.  Each one sits in the ground pour on at least
   *  two layers (else it would join nothing), keeps every clearance in the exact check, and stays a hole's width from
   *  the other ground vias. */
  fence(): void {
    const G = this.G, W = G.W, o = this.opts.fence; const fo = typeof o === "object" && o ? o : {}; const spacing = Math.max(0.6, fo.spacing || 2);
    const named = new Set(fo.nets || []); const wantFence = (n: string) => named.has(n) || this.kindOf(n) === "rf";
    const wantRet = (n: string) => fo.returnVias !== false && (wantFence(n) || this.kindOf(n) === "fast");
    const nets = new Map<string, Conn[]>(); for (const c of this.conns) if (c.nodes && (wantFence(c.net) || (wantRet(c.net) && c.viaCells.length))) { const l = nets.get(c.net) || []; nets.set(c.net, l); l.push(c); }
    if (!nets.size) return;
    const cover = (n: NetInfo) => n.pour!.mask.reduce((t, m) => t + (m ? 1 : 0), 0);
    const gnd = this.nets.filter((n) => n.pour && /(^|\/)[ADP]?(GND|VSS)\w*$/i.test(n.key) && cover(n) >= 2).sort((a, b) => cover(b) - cover(a))[0];
    if (!gnd) { for (const n of nets.keys()) this.fenceReports.push({ net: n, ground: "", fence: 0, returns: 0, spacing, note: "the board has no ground pour on two layers for the vias to join" }); return; }
    const pour = gnd.pour!, cls = gnd.cls; const pkey = `pour/${pour.width}/${pour.clr}`; let pcls = G.classes.get(pkey);
    if (!pcls) { pcls = buildClass(G, pkey, pour.width, pour.clr, cls.viaD, cls.viaDrill); for (const c of this.conns) if (c.nodes) for (const sh of c.shapes) stampClass(G, pcls, sh, 1, false); }
    const holes: Pt[] = []; for (const ob of G.obstacles.get(gnd.key) || []) if (ob.thru) holes.push(ob.thru); for (const c of gnd.conns) if (c.nodes) for (const gi of c.viaCells) holes.push(this.mm({ ix: gi % W, iy: (gi / W) | 0 }));
    const apart = cls.viaD + 0.25; const r = cls.viaD / 2; const all = G.layers.map((_, i) => i);
    this.lift(gnd, 1, cls); this.lift(gnd, 1, pcls); this.cur = null as any; this.curSoft = false;
    const tryAt = (x: number, y: number): boolean => {
      const ix = Math.round((x - G.ox) / G.g), iy = Math.round((y - G.oy) / G.g); if (ix < 1 || iy < 1 || ix >= W - 1 || iy >= G.H - 1) return false; const gi = iy * W + ix;
      if (!viaFits(G, cls.vfull, gi)) return false; let n = 0; for (let l = 0; l < pour.mask.length; l++) { const m = pour.mask[l]; if (m && m[gi] && !pcls!.full[l][gi]) n++; } if (n < 2) return false;
      const p = this.mm({ ix, iy }); if (holes.some((h) => Math.hypot(h[0] - p[0], h[1] - p[1]) < apart)) return false;
      const shape: Shape = { t: "circle", x: p[0], y: p[1], r }; for (const l of all) if (!this.clearOf(shape, l, gnd.key, cls.clr)) return false;
      holes.push(p); this.fenceVias.push({ p, net: gnd.key, cls, obj: gnd.obj }); const ob: Obstacle = { net: gnd.key, layers: all, shape, clr: cls.clr }; this.fenceShapes.push(ob); return true;
    };
    try {
      for (const [net, conns] of nets) {
        const rep: FenceReport = { net, ground: gnd.key, fence: 0, returns: 0, spacing }; this.fenceReports.push(rep); let wanted = 0;
        const clr = Math.max(conns[0].cls.clr, cls.clr, pour.clr);
        if (wantFence(net)) for (const c of conns) {
          let carry = spacing / 2;
          for (const sh of c.shapes) { const g = sh.shape as any; if (g.t !== "seg") continue; const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], len = Math.hypot(dx, dy); if (len < 1e-6) continue;
            const ux = dx / len, uy = dy / len; const off = g.r + clr + r + G.g;
            for (let t = carry; t <= len; t += spacing) { for (const sgn of [1, -1]) { wanted++; const bx = g.a[0] + ux * t, by = g.a[1] + uy * t;
              for (const [dt, extra] of [[0, 0], [0, G.g * 2], [spacing / 4, 0], [-spacing / 4, 0], [0, G.g * 4]] as Pt[]) if (tryAt(bx + ux * dt - uy * sgn * (off + extra), by + uy * dt + ux * sgn * (off + extra))) { rep.fence++; break; } } }
            carry = (carry - len) % spacing; if (carry < 0) carry += spacing; }
        }
        if (wantRet(net)) for (const c of conns) for (const gi of c.viaCells) {
          const v = this.mm({ ix: gi % W, iy: (gi / W) | 0 }); const d0 = c.cls.viaD / 2 + clr + r + G.g; let done = false;
          for (const d of [d0, d0 + 2 * G.g, d0 + 0.4, d0 + 0.8]) { for (let k = 0; k < 8 && !done; k++) { const a = k * Math.PI / 4; if (tryAt(v[0] + Math.cos(a) * d, v[1] + Math.sin(a) * d)) done = true; } if (done) break; }
          if (done) rep.returns++; else rep.note = "no room in the ground pour beside " + (rep.note ? "some layer changes" : "a layer change");
        }
        if (wantFence(net) && rep.fence < wanted) rep.note = (rep.note ? rep.note + "; " : "") + `${wanted - rep.fence} of ${wanted} fence positions had no room or no ground pour on two layers`;
      }
    } finally { this.lift(gnd, -1, pcls); this.lift(gnd, -1, cls); }
    for (const c of G.classes.values()) for (const ob of this.fenceShapes) stampClass(G, c, ob, 1, false);
  }
  fenceShapes: Obstacle[] = [];
  ruleHit = new Map<number, string>(); reports = new Map<number, Partial<ConnReport>>();
  /** Why each connection that is still open failed: what is in its way, or that there is no way at all. */
  explain(): void {
    for (const c of this.conns) {
      if (c.nodes || c.moot) continue; const rep: Partial<ConnReport> = {}; this.reports.set(c.id, rep);
      if (c.why === "budget") { rep.reason = "budget"; rep.detail = "the run stopped before this connection was tried"; continue; }
      if (c.pairOnly && this.opts.splitPairs !== true) { rep.reason = "blocked"; rep.detail = `a differential pair is only laid as one coupled run, and ${c.pairOnly}: make room along its path (move or turn the parts in the way), or route it by hand`; continue; }
      if (c.why === "rule") { rep.reason = "rule"; const o = this.ruleHit.get(c.id); rep.blockedBy = { nets: o ? [o] : [], items: [] }; rep.detail = "the route found did not keep its clearance in the exact check"; continue; }
      const net = this.netOf(c.net); let ends: boolean[] = []; const gd = net.guide;
      this.lift(net, 1, c.cls); this.cur = c; this.curSoft = true; try { ends = [c.a, c.b].map((e) => !!this.access(e, c.cls.fixed)); } finally { this.lift(net, -1, c.cls); }
      const soft = this.find(c, true);
      if (!soft && (!ends[0] || !ends[1])) {   // is it the rules themselves that close the pad in?
        const e = !ends[0] ? c.a : c.b; const why = { net: "", gap: 0, need: 0 }; let shut = !!e.axis;
        if (e.axis) for (const sgn of [1, -1]) for (const l of e.layers) if (this.G.routable[l]) { this.cur = c; this.curSoft = true; if (this.clearOf({ t: "seg", a: e.p, b: [e.p[0] + e.axis[0] * 0.3 * sgn, e.p[1] + e.axis[1] * 0.3 * sgn], r: c.cls.width / 2 }, l, c.net, c.cls.clr, why)) shut = false; }
        if (shut && why.need) { rep.reason = "rule"; rep.blockedBy = { nets: why.net ? [why.net] : [], items: [] }; rep.detail = `a ${c.cls.width} mm track cannot leave ${this.padName(e.p)}: it would pass ${why.gap.toFixed(3)} mm from ${why.net || "its neighbour"} where ${why.need.toFixed(3)} mm is required — relax that clearance or the minimum track width`; continue; }
      }
      if (!soft) { rep.reason = "no-room"; rep.detail = !ends[0] || !ends[1] ? `no free way out of ${this.padName(!ends[0] ? c.a.p : c.b.p)}` : "no path past the copper, holes, keep-outs and edges already on the board" + (gd.allowed || gd.avoid.length || gd.maxVias < Infinity || !gd.allowVias ? " within the plan's limits for this net" : ""); continue; }
      const bl = this.blockers(c, soft.res); rep.reason = "blocked"; rep.blockedBy = { nets: Array.from(new Set(bl.map((b) => b.net))), items: [] };
      rep.detail = bl.length ? "routes laid earlier in this run are in the way" : "too tight for a track of this width between the routes laid earlier";
    }
  }
  private groupReport(): RouteResult["groups"] {
    let inside = 0, insideRouted = 0, insideVias = 0;
    for (const c of this.conns) { if (c.moot && !c.nodes) continue; if (!this.groupFor(c) || c.len > GROUP_REACH * 2) continue; inside++; if (c.nodes) { insideRouted++; insideVias += c.viaCells.length; } }
    const critical = Array.from(new Set(this.conns.filter((c) => isCritical(c.net, this.kindOf(c.net)) || this.netOf(c.net).guide.rank < Infinity).map((c) => c.net)));
    const members: Record<string, string[]> = {}; for (const [ref, g] of this.groupOf) (members[g] || (members[g] = [])).push(ref);
    for (const g of Object.keys(members)) if (members[g].length < 2) delete members[g];
    return { clusters: Object.keys(members).length, inside, insideRouted, insideVias, critical, members };
  }
  private refPads: Map<string, Pt> | null = null;
  /** The way a pad faces out of its part: along its own axis, away from the middle of the part's pads. */
  private outward(a: Anchor): Pt | null {
    if (!a.axis) return null;
    if (!this.refPads) { const sum = new Map<string, number[]>(); for (const [k, v] of this.padNames) { const r = v.replace(/\.[^.]*$/, ""); const [x, y] = k.split(",").map(Number); const t = sum.get(r) || [0, 0, 0]; t[0] += x; t[1] += y; t[2]++; sum.set(r, t); } this.refPads = new Map([...sum].map(([r, t]) => [r, [t[0] / t[2], t[1] / t[2]] as Pt])); }
    const ref = (this.padNames.get(a.p[0].toFixed(3) + "," + a.p[1].toFixed(3)) || "").replace(/\.[^.]*$/, ""); const c = this.refPads.get(ref); if (!c) return null;
    const s = (a.p[0] - c[0]) * a.axis[0] + (a.p[1] - c[1]) * a.axis[1]; if (Math.abs(s) < 0.05) return null;
    return s > 0 ? a.axis : [-a.axis[0], -a.axis[1]];
  }
  private padName(p: Pt): string { return this.padNames.get(p[0].toFixed(3) + "," + p[1].toFixed(3)) || `(${r6(p[0])}, ${r6(p[1])})`; }
  private domainReport(): DomainReport | undefined {
    if (!this.domains) return undefined; const kinds: Record<string, NetKind> = {};
    for (const n of this.G.obstacles.keys()) if (n) { const k = this.kindOf(n); if (k !== "digital" && k !== "supply") kinds[n] = k; }
    return { kinds, quiet: this.sepGaps.quiet, noisy: this.sepGaps.noisy, relaxed: Array.from(this.relaxed) };
  }
  ms = 0; passes = 0;
  result(): RouteResult {
    const ms = this.ms, passes = this.passes;
    const { P, doc, G } = this; const items: RouteItem[] = []; let segments = 0, vias = 0, length = 0, zoneEnds = 0; const failed: RouteResult["failed"] = [];
    const span = [G.layers[0], G.layers[G.layers.length - 1]];
    const connections: ConnReport[] = []; const end = (p: Pt) => { const pad = this.padNames.get(p[0].toFixed(3) + "," + p[1].toFixed(3)); return pad ? { x: r6(p[0]), y: r6(p[1]), pad } : { x: r6(p[0]), y: r6(p[1]) }; };
    const viaSeen = new Set<string>();   // two connections of a net may each hold a via at the same spot: one is laid
    for (const c of this.conns) {
      if (c.moot && !c.nodes) continue;
      const ea = c.ends ? c.ends[0] : c.a, eb = c.ends ? c.ends[1] : c.b; const rep: ConnReport = { net: c.net, from: end(ea.p), to: end(eb.p), routed: !!c.nodes, length: 0, vias: 0, bends: 0, layers: [], detourRatio: 0 }; connections.push(rep);
      if (!c.nodes) {
        failed.push({ net: c.net, a: ea.p, b: eb.p }); Object.assign(rep, this.reports.get(c.id) || {});
        const bx = this.fanReport && this.fanReport.boxed.find((b) => b.pad === rep.from.pad || b.pad === rep.to.pad);   // the fan-out found no way out of the pin
        if (bx) rep.detail = `${bx.pad} is boxed in: ${bx.reason}${bx.blockedBy.length ? " (" + bx.blockedBy.join(", ") + ")" : ""}` + (rep.detail ? "; " + rep.detail : "");
        continue;
      }
      { let len = 0; const ls = new Set<number>(); for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "seg") { len += Math.hypot(sh.a[0] - sh.b[0], sh.a[1] - sh.b[1]); ls.add(o.layers[0]); } }
        rep.length = +len.toFixed(3); rep.vias = c.viaCells.length; rep.bends = c.feat ? c.feat.b45 + c.feat.b90 : 0; rep.layers = Array.from(ls).sort().map((l) => G.layers[l]); rep.detourRatio = c.len > 1e-6 ? +(len / c.len).toFixed(2) : 1; }
      const net = this.netOf(c.net).obj; if (c.zoneEnd) zoneEnds++;
      const seg = (a: Pt, b: Pt, l: number, w: number) => { if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) return; items.push({ kind: "segment", node: P.segmentNode(doc, a, b, w, G.layers[l], net), net, netName: c.net, conn: c.id }); segments++; length += Math.hypot(a[0] - b[0], a[1] - b[1]); };
      for (const o of c.shapes) { const sh = o.shape as any; if (sh.t === "seg") seg(sh.a, sh.b, o.layers[0], +(sh.r * 2).toFixed(4)); }   // stubs and runs, each at its own width
      for (const gi of c.viaCells) { const vk = c.net + "\n" + gi; if (viaSeen.has(vk)) continue; viaSeen.add(vk); const p = this.mm({ ix: gi % G.W, iy: (gi / G.W) | 0 }); items.push({ kind: "via", node: P.viaNode(doc, p[0], p[1], c.cls.viaD, c.cls.viaDrill, net, span), net, netName: c.net, conn: c.id }); vias++; }
    }
    // an escape is laid with the first route that starts from it; one nothing was routed from stays off the board
    let used = 0;
    for (const { e, anchors, obs } of this.laid) {
      const c = this.conns.find((c) => c.nodes && [c.a, c.b, ...(c.ends || [])].some((a) => anchors.includes(a))); if (!c) continue; used++; const net = this.netOf(e.net).obj;
      for (const o of obs) { const sh = o.shape as any; if (sh.t === "seg") { items.push({ kind: "segment", node: P.segmentNode(doc, sh.a, sh.b, +(sh.r * 2).toFixed(4), G.layers[o.layers[0]], net), net, netName: e.net, conn: c.id }); segments++; length += Math.hypot(sh.a[0] - sh.b[0], sh.a[1] - sh.b[1]); }
        else { items.push({ kind: "via", node: P.viaNode(doc, sh.x, sh.y, +(sh.r * 2).toFixed(4), c.cls.viaDrill, net, span), net, netName: e.net, conn: c.id }); vias++; } }
    }
    if (this.fanReport) this.fanReport.used = used;
    for (const v of this.fenceVias) { items.push({ kind: "via", node: P.viaNode(doc, v.p[0], v.p[1], v.cls.viaD, v.cls.viaDrill, v.obj, span), net: v.obj, netName: v.net, conn: -1 }); vias++; }
    const total = this.conns.filter((c) => c.nodes || !c.moot).length;
    return { items, total, routed: total - failed.length, failed, segments, vias, length, ms, passes, zoneEnds, zoneCovered: this.zoneCovered,
      grid: { pitch: G.g, w: G.W, h: G.H, layers: G.layers.filter((_, i) => G.routable[i]) }, nets: this.nets.length, connections, pairs: Array.from(this.pairReports.values()), impedance: this.zReports, matched: this.matchReports, domains: this.domainReport(), fences: this.fenceReports, groups: this.groupReport(), fanout: (this.fanReport ? Object.assign({}, this.fanReport, this.fanNote) : this.fanNote) as RouteResult["fanout"], plan: this.planReport(), ladder: this.ladderRep || ((this.opts.ripup ?? RIPUP) === "ladder" ? emptyLadder() : undefined) };
  }
}

/** A footprint's reference designator. */
export function refOf(K: any, node: any): string {
  const p = K.kids(node, "property").find((q: any) => K.str(q[1]) === "Reference"); if (p) return K.str(p[2]);
  const t = K.kids(node, "fp_text").find((q: any) => K.str(q[1]) === "reference"); return t ? K.str(t[2]) : "";
}
/** The direction a pad's long side runs in, on the board. */
function padAxis(pad: any): Pt {
  const r = (pad.rot || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); const lx = pad.w >= pad.h ? 1 : 0, ly = pad.w >= pad.h ? 0 : 1;
  return [lx * c + ly * s, -lx * s + ly * c];
}
function pointInPolyPts(pts: Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside; }
  return inside;
}
/** Drop repeated points and the middle point of straight runs. */
export function simplify(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    const a = out[out.length - 1]; if (a && a.ix === n.ix && a.iy === n.iy && a.l === n.l) continue;
    const b = out[out.length - 2];
    if (a && b && a.l === n.l && b.l === a.l && dirOf(a.ix - b.ix, a.iy - b.iy) === dirOf(n.ix - a.ix, n.iy - a.iy) && (a.ix !== b.ix || a.iy !== b.iy)) { out[out.length - 1] = n; continue; }
    out.push(n);
  }
  return out;
}
export { DX, DY };

/** Route a board, with escapes the way Copper's engine gates a stage (engine.py: keep-best): first without any, then,
 *  when that leaves pins of fine-pitch rows open and escapes are asked for, again with Copper's fan-out (fanout.py) of
 *  only those rows.  The second run is kept only when it is strictly better: fewer open connections, then fewer vias,
 *  then less track (Copper's second opinion and via-frugal ladder compare the same way); otherwise the first stands,
 *  so a board that routes cleanly without escapes comes out exactly as it would with them off.  `onRouter` hears of
 *  each Router as it starts (the editor stops the one running). */
export function* routeRuns(K: any, P: any, doc: any, settings: any, opts: RouteOptions = {}, onRouter?: (r: Router) => void): Generator<Progress, { router: Router; result: RouteResult }> {
  const run = function* (o: RouteOptions) { const r = new Router(K, P, doc, settings, o); if (onRouter) onRouter(r); const result: RouteResult = yield* r.run(); return { router: r, result }; };
  const want = opts.escapes ?? ESCAPES;
  if (want === false || opts.escapeRows) return yield* run(opts);
  const first = yield* run(Object.assign({}, opts, { escapes: false }));
  const rows = first.router.boxedRows(); if (!rows.length || first.router.stopped) return first;
  const second = yield* run(Object.assign({}, opts, { escapes: want, escapeRows: rows }));
  const key = (r: RouteResult) => [r.failed.length, r.vias, Math.round(r.length * 1000)];
  const a = key(first.result), b = key(second.result); const better = b[0] !== a[0] ? b[0] < a[0] : b[1] !== a[1] ? b[1] < a[1] : b[2] < a[2];
  const kept = better ? second : first; const note = { kept: better, open: [a[0], b[0]] as [number, number] };
  // the first run laid no escape: it reports the second's, as tried and not kept
  kept.router.fanNote = better ? note : Object.assign({}, second.result.fanout, { used: 0 }, note); kept.result.fanout = (kept.router.fanReport ? Object.assign({}, kept.router.fanReport, kept.router.fanNote) : kept.router.fanNote) as RouteResult["fanout"];
  return kept;
}

/** Route a board in one go (the editor drives routeRuns() in slices instead, to stay responsive). */
export function route(K: any, P: any, doc: any, settings: any, opts?: RouteOptions): RouteResult {
  const it = routeRuns(K, P, doc, settings, opts); let s = it.next(); while (!s.done) s = it.next(); return s.value.result;
}
