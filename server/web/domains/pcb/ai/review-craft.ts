// review-craft.ts — the layout review's workshop rules: what a careful hand does on every board, measured from the copper.
//
// review.ts holds the layout checklist and review-physics.ts the electrical rules of the standard references.  This
// file adds the habits that practising designers repeat board after board, taken from the board walk-throughs and
// routing videos of Phil's Lab (Philip Salmony); server/docs/pcb-design-rules.md lists each video by title:
//   tracks.minimum     signal tracks are not drawn at the fabricator's minimum where there is room for more
//   crosstalk.victims  a reset, crystal, reference or analog line does not run tight beside a clock or switch node
//   vias.slot          a row of vias whose clearance holes merge cuts a slot in the plane under it
//   bypass.order       the supply reaches a chip's pin through its capacitor, not the other way round
//   pads.entry         a track leaves a fine-pitch pad through its end, never sideways towards the next pin
//   power.return       a supply via has a ground via beside it
//   planes.signals     no signal is routed on a ground plane layer
//   bus.transitions    the lines of one bus change layer the same number of times
//   vias.aspect        a via's hole is not deeper than ten times its width
// Each finding names the parts and nets and the call that fixes it.  Where the owner's standing rules differ from the
// videos (via size, tight fan-out, everything on the top side), the owner's rules hold and nothing here contradicts them.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { netKind, pairName } from "../router/route";
import { isMotionSensor } from "../router/place";

type Level = "error" | "warning" | "note";
type Add = (rule: string, level: Level, message: string, items?: string[]) => void;
type Box = [number, number, number, number];
type Pt = [number, number];

/** The numbers the checks use, in millimetres. */
export const CRAFT_LIMITS = {
  thin: 0.15,          // a signal track narrower than this is at the fabricator's minimum
  thinNear: 2.0,       // ... which is fine this close to a fine-pitch pad, where nothing wider fits
  thinLength: 5,       // ... and reported once a net has this much of it in the open board
  finePad: 0.35,       // a pad this narrow belongs to a fine-pitch part
  victimGap: 2,        // a victim keeps this many track widths (edge to edge) from an aggressor: the 3W rule
  victimRun: 5,        // ... over any run longer than this
  victimPad: 1.5,      // ... except this close to its own pads
  slotSliver: 0.15,    // plane copper narrower than this between two clearance holes does not survive
  slotCount: 4,        // this many vias in a merged row
  slotLength: 4,       // ... over this length make a slot worth reporting
  clusterSpan: 6,      // a net whose pads all lie within this is inside one cluster
  capReach: 4,         // a bypass capacitor serves a supply pin this close
  pinVia: 1.2,         // a supply via this close to the pin feeds the pin first
  pairVia: 2.5,        // a supply via has a ground via within this
  aspect: 10,          // board thickness over drill: deeper holes plate badly and cost more
};

export const CRAFT_RULES: { id: string; what: string }[] = [
  { id: "tracks.minimum", what: "Signal tracks are wider than the fabricator's minimum wherever there is room: 0.2 to 0.3 mm, necked down only at fine-pitch pads" },
  { id: "crosstalk.victims", what: "Reset, crystal, reference and analog lines keep three track widths from clocks, fast lines and switch nodes" },
  { id: "vias.slot", what: "Vias are spaced so that plane copper passes between their clearance holes: a merged row is a slot in the ground" },
  { id: "cluster.inside", what: "The connections inside a cluster (a chip and the small parts that serve it) are short, on one layer and have no via: a cluster is routed inside itself first" },
  { id: "bypass.order", what: "A supply reaches the chip's pin through its bypass capacitor: via, capacitor, pin" },
  { id: "pads.entry", what: "A track leaves a fine-pitch pad through the pad's end, in line with it" },
  { id: "power.return", what: "A supply via has a ground via beside it, so the loop through the planes is small" },
  { id: "planes.signals", what: "No signal is routed on a ground plane layer" },
  { id: "bus.transitions", what: "The lines of one bus use the same layers and the same number of vias, so only their track lengths need matching" },
  { id: "vias.aspect", what: "A via's drill is at least a tenth of the board's thickness" },
];
export const CRAFT_MANUAL = [
  "Parts were placed in order of how critical they are (decoupling, crystal, converter, RF, connectors, then the rest), and routed in the same order with supplies and the ground pour last.",
  "The Gerbers were read layer by layer before ordering: slivers, voids in the planes, thermal reliefs, silkscreen over pads.",
  "Every footprint that is not from a checked library was compared with the datasheet's land pattern.",
  "A series termination resistor sits at the driver (its value is the track's impedance less the driver's output impedance); a parallel one sits at the end of the line, after the last load, on a stub of a few millimetres.",
  "A current-sense resistor is measured four-wire: the two sense tracks leave from the inside of its pads as a pair, apart from the tracks that carry the current.",
  "A header that carries fast signals has a ground pin beside every signal pin; I2C lines are not routed as a pair, and a bus with several devices runs through them in a chain, not as a star of stubs.",
];
export const CRAFT_SOURCE = "Layout practice: Phil's Lab (Philip Salmony), board walk-through and PCB routing videos, listed by title in server/docs/pcb-design-rules.md.";

const GROUND = /^(?:[ADP]?GND\w*|GNDREF|VSS\w*|EARTH|0V)$/i;
const VICTIM = /^(?:N?RE?SE?T\w*|\w*_N?RE?SE?T|N?RST\w*|\w*_N?RST\w*|X(?:TAL)?_?(?:IN|OUT|I|O)\w*|OSC_?(?:IN|OUT)\w*|\w*VREF\w*)$/i;
const bare = (n: string) => n.replace(/^\/(.*\/)?/, "");
const isGnd = (n: string) => !!n && GROUND.test(bare(n));
const r2 = (v: number) => Math.round(v * 100) / 100;
const at = (x: number, y: number) => `(${r2(x)}, ${r2(y)})`;
const few = (l: string[], n = 8) => (l.length > n ? l.slice(0, n).concat(`and ${l.length - n} more`) : l);
const on = (c: any, layer: string) => (c.layers instanceof Set ? c.layers.has(layer) : Array.isArray(c.layers) ? c.layers.includes(layer) : false);
const layersOf = (c: any): string[] => (c.layers instanceof Set ? Array.from(c.layers) : Array.isArray(c.layers) ? c.layers : []);
const ptsOf = (t: any): Pt[] => (t.shape.t === "seg" ? [t.shape.a, t.shape.b] : t.shape.pts || []);
const widthOf = (t: any) => t.width || (t.shape.r ? t.shape.r * 2 : 0.2);
const inBox = (b: Box, x: number, y: number, m = 0) => x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;
function walk(t: any, step: number, fn: (x: number, y: number, d: number) => void) {
  const pts = ptsOf(t);
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.round(L / step)); for (let j = 0; j < n; j++) { const q = (j + 0.5) / n; fn(a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q, L / n); } }
}

interface Pad { number: string; x: number; y: number; net: string; box: Box; type: string; fp: Fp; c: any }
interface Fp { ref: string; value: string; lib: string; pads: Pad[] }

export function reviewCraft(doc: any, P: any, k: any, settings: any, add: Add): void {
  // motion sensors (IMU, accelerometer, gyro, magnetometer): axes the board's, so the firmware needs no remapping
  {
    const items: string[] = []; const turns = new Set<string>();
    for (const it of doc.items.values() as Iterable<any>) {
      if (it.kind !== "footprint" || !isMotionSensor(k, it.node)) continue; const ref = it.ref || "?";
      const at = k.kid(it.node, "at"); const rot = at && at.length > 3 ? ((Math.round(k.num(at[3], 0)) % 360) + 360) % 360 : 0;
      const lay = k.kid(it.node, "layer"); const back = !!lay && k.str(lay[1]) === "B.Cu"; turns.add(`${rot}${back ? "b" : ""}`);
      if (rot % 90) items.push(`${ref} stands at ${rot}°, not square to the board: its axes are mixed in the firmware`);
      else if (rot || back) items.push(`${ref} at ${rot}°${back ? " on the back" : ""}: its X, Y${back ? " and Z" : ""} are not the board's (0° on the top side makes them so)`);
      const p1 = k.kids(it.node, "pad").find((q: any) => k.str(q[1]) === "1"); const pa = p1 ? k.kid(p1, "at") : null;
      if (pa) { const x = k.num(pa[1], 0), y = k.num(pa[2], 0); if (!(x < 0 && y < 0)) items.push(`${ref}: pin 1 is not at the top left of its footprint, so the footprint is drawn turned against most datasheets' top view; check the axis drawing in the datasheet and set the turn that matches it`); }
    }
    if (turns.size > 1) items.push(`the motion sensors stand at different turns (${Array.from(turns).join(", ")}): turn them all the same way`);
    if (items.length) add("motion.orientation", "warning", "A motion sensor's axes should be the board's own, so firmware reads X, Y and Z without remapping: every accelerometer, gyro, IMU and magnetometer square to the board at 0° on the top side (board.move(ref, rotation=0)).", items);
  }
  const copper: string[] = doc.copper && doc.copper.length ? doc.copper.slice() : ["F.Cu", "B.Cu"];
  const conds: any[] = P.conductors(doc); const NT = P.netTable(doc);
  const byId = new Map<string, Fp>(); const groundLayers = new Set<string>();
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.kind === "footprint") byId.set(it.id, { ref: it.ref || "?", value: it.value || "", lib: it.lib || "", pads: [] });
    else if (it.kind === "zone" && !k.kid(it.node, "keepout")) {
      const n = it.node; const nn = k.kid(n, "net_name"); const net = NT.key(P.netOf(n)) || (nn ? k.str(nn[1]) : ""); if (!isGnd(net)) continue;
      const ls = k.kid(n, "layers") || k.kid(n, "layer"); for (const l of ls ? ls.slice(1).map((x: any) => k.str(x)) : []) for (const q of l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : l === "*.Cu" ? copper : [l]) groundLayers.add(q);
    }
  }
  const pads: Pad[] = [], tracks: any[] = [], vias: any[] = []; const stitches: Pt[] = [];
  for (const c of conds) {
    if (c.kind === "pad") { const f = byId.get(c.item.id); if (!f) continue; const p: Pad = { number: c.pad.number, x: c.pad.x, y: c.pad.y, net: c.net || "", box: c.bbox, type: c.pad.type, fp: f, c }; f.pads.push(p); pads.push(p); if (isGnd(p.net) && p.type === "thru_hole") stitches.push([p.x, p.y]); }
    else if (c.kind === "segment" || c.kind === "arc") { if (c.net) tracks.push(c); }
    else if (c.kind === "via") { vias.push(c); if (isGnd(c.net)) stitches.push([c.shape.x, c.shape.y]); }
  }
  const nets = new Set<string>(); for (const p of pads) if (p.net) nets.add(p.net);
  const pairs = new Map<string, number>(); for (const n of nets) { const pn = pairName(n); if (pn) pairs.set(pn.base, (pairs.get(pn.base) || 0) + 1); }
  const kinds = new Map<string, string>(); const kindOf = (n: string) => { let v = kinds.get(n); if (v === undefined) { const pn = pairName(n); v = isGnd(n) ? "supply" : netKind(n, (pn && pairs.get(pn.base) === 2) || undefined); kinds.set(n, v as string); } return v as string; };
  const fine = pads.filter((p) => p.type === "smd" && p.fp.pads.length >= 8 && Math.min(p.box[2] - p.box[0], p.box[3] - p.box[1]) <= CRAFT_LIMITS.finePad + 1e-6);
  const clr = Math.max(0.15, (settings && settings.clearance) || 0.2);

  // ---- tracks.minimum: thin track out in the open board
  {
    const thin = new Map<string, { mm: number; w: number }>();
    for (const t of tracks) {
      const w = widthOf(t); if (w >= CRAFT_LIMITS.thin - 1e-6 || kindOf(t.net) === "rf") continue;
      const near = fine.filter((p) => inBox(p.box, (t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2, Math.max(t.bbox[2] - t.bbox[0], t.bbox[3] - t.bbox[1]) + CRAFT_LIMITS.thinNear));
      walk(t, 0.5, (x, y, d) => { if (near.some((p) => inBox(p.box, x, y, CRAFT_LIMITS.thinNear))) return; const e = thin.get(t.net) || { mm: 0, w }; thin.set(t.net, e); e.mm += d; e.w = Math.min(e.w, w); });
    }
    const items = Array.from(thin.entries()).filter(([, e]) => e.mm >= CRAFT_LIMITS.thinLength).sort((a, b) => b[1].mm - a[1].mm).map(([n, e]) => `${bare(n)}: ${r2(e.mm)} mm at ${r2(e.w)} mm`);
    if (items.length) add("tracks.minimum", "warning", `These tracks run at the fabricator's minimum width well away from any fine-pitch pad. A track at the minimum is the first to be etched open and gains nothing: use 0.2 mm or more for signals and neck down only where a pad row needs it (board.route(widths={net: 0.2}) or the net class width).`, few(items));
  }

  // ---- crosstalk.victims: a quiet line tight beside a loud one
  {
    const loud = tracks.filter((t) => { const kd = kindOf(t.net); return kd === "fast" || kd === "switching"; });
    const run = new Map<string, { mm: number; gap: number; x: number; y: number }>();
    if (loud.length) for (const t of tracks) {
      const kd = kindOf(t.net); const victim = kd === "analog" || VICTIM.test(bare(t.net)); if (!victim || kd === "fast" || kd === "switching") continue;
      const w = widthOf(t), need = CRAFT_LIMITS.victimGap * w, reach = need + 1; const lay = layersOf(t)[0];
      const cand = loud.filter((q) => q.net !== t.net && on(q, lay) && !(kd === "analog" && kindOf(q.net) === "switching") && q.bbox[0] < t.bbox[2] + reach && q.bbox[2] > t.bbox[0] - reach && q.bbox[1] < t.bbox[3] + reach && q.bbox[3] > t.bbox[1] - reach);
      if (!cand.length) continue; const own = pads.filter((p) => p.net === t.net);
      walk(t, 0.5, (x, y, d) => {
        if (own.some((p) => inBox(p.box, x, y, CRAFT_LIMITS.victimPad))) return;
        for (const q of cand) { const gap = P.shapeGap({ t: "circle", x, y, r: 0 }, q.shape) - w / 2; if (gap >= need) continue; const key = `${t.net}\u0000${q.net}`; const e = run.get(key) || { mm: 0, gap, x, y }; run.set(key, e); e.mm += d; if (gap < e.gap) { e.gap = gap; e.x = x; e.y = y; } }
      });
    }
    const items = Array.from(run.entries()).filter(([, e]) => e.mm >= CRAFT_LIMITS.victimRun).map(([key, e]) => { const [v, a] = key.split("\u0000"); return `${bare(v)} beside ${bare(a)}: ${r2(e.mm)} mm, ${r2(Math.max(0, e.gap))} mm apart near ${at(e.x, e.y)}`; });
    if (items.length) add("crosstalk.victims", "warning", "A reset, crystal, reference or analog line runs tight beside a clock, a fast line or a switch node. Edges couple into the quiet line over a parallel run: keep three track widths between them (centre to centre) or put them on different sides of a ground track that is stitched at both ends (board.route(kinds={net: \"analog\"}) keeps a net apart; net_options {net: {\"avoid\": [box]}} keeps it out of an area).", few(items));
  }

  // ---- vias.slot: a row of vias whose clearance holes merge
  if (groundLayers.size) {
    const vs = vias.filter((v) => v.net && !isGnd(v.net)); const parent = vs.map((_, i) => i); const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) { const a = vs[i].shape, b = vs[j].shape; if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + 2 * clr + CRAFT_LIMITS.slotSliver - 1e-6) parent[find(i)] = find(j); }
    const groups = new Map<number, any[]>(); vs.forEach((v, i) => { const g = find(i); const e = groups.get(g) || []; groups.set(g, e); e.push(v); });
    const items: string[] = [];
    for (const g of groups.values()) {
      if (g.length < CRAFT_LIMITS.slotCount) continue; let best = 0, a = g[0], b = g[0];
      for (const p of g) for (const q of g) { const d = Math.hypot(p.shape.x - q.shape.x, p.shape.y - q.shape.y); if (d > best) { best = d; a = p; b = q; } }
      if (best >= CRAFT_LIMITS.slotLength) items.push(`${g.length} vias from ${at(a.shape.x, a.shape.y)} to ${at(b.shape.x, b.shape.y)}: a ${r2(best)} mm slot`);
    }
    if (items.length) add("vias.slot", "warning", `These vias stand so close that their clearance holes in the ground plane join into one slot, and every signal that crosses it loses its return path. Leave ${r2(2 * clr + CRAFT_LIMITS.slotSliver)} mm of copper-to-copper room between neighbouring vias, or stagger the row in two lines, so plane copper passes between them; then fill and look at the plane layer.`, few(items));
  }

  // ---- cluster.inside: a net that lives wholly inside one cluster (a chip pin and the small parts on it, all surface
  // pads within a few millimetres) is wired there, on the parts' layer: no via, no wandering
  {
    const byNet = new Map<string, Pad[]>(); for (const p of pads) if (p.net && !isGnd(p.net)) { const l = byNet.get(p.net); if (l) l.push(p); else byNet.set(p.net, [p]); }
    const items: string[] = [];
    for (const [net, ps] of byNet) {
      if (ps.length < 2 || ps.length > 4 || ps.some((p) => p.type !== "smd") || !ps.some((p) => p.fp.pads.length >= 5) || !ps.some((p) => p.fp.pads.length < 5)) continue;
      let span = 0; for (const p of ps) for (const q of ps) span = Math.max(span, Math.hypot(p.x - q.x, p.y - q.y)); if (span > CRAFT_LIMITS.clusterSpan) continue;
      const nv = vias.filter((v) => v.net === net).length; let len = 0; for (const t of tracks) if (t.net === net && t.shape && t.shape.t === "seg") len += Math.hypot(t.shape.b[0] - t.shape.a[0], t.shape.b[1] - t.shape.a[1]);
      const chip = ps.find((p) => p.fp.pads.length >= 5)!;
      if (nv) items.push(`${bare(net)} at ${chip.fp.ref}: ${nv} via${nv === 1 ? "" : "s"} on a net whose pads lie within ${r2(span)} mm`);
      else if (len > 2.5 * span + 3) items.push(`${bare(net)} at ${chip.fp.ref}: ${r2(len)} mm of track for pads ${r2(span)} mm apart`);
    }
    if (items.length) add("cluster.inside", "warning", "A cluster is one chip and the parts that serve it, and it is routed inside itself first: every connection between two of its parts is short, on the parts' own layer and has no via. These are not, which means the cluster is built wrong rather than routed wrong: turn or move the small part so its pad faces the pin it serves with its other end pointing outward (board.seat(ref), board.place_bypass(chip)), then lay the net again (board.unroute(net), board.route(nets=[net])).", few(items));
  }

  // ---- bypass.order: the supply reaches the pin through the capacitor
  {
    const items: string[] = [];
    for (const f of byId.values()) {
      if (!/^C\d/i.test(f.ref) || f.pads.length !== 2) continue; const g = f.pads.find((p) => isGnd(p.net)), s = f.pads.find((p) => p.net && !isGnd(p.net)); if (!g || !s) continue;
      let pin: Pad | null = null, dp = CRAFT_LIMITS.capReach; for (const p of pads) { if (p.net !== s.net || p.fp === f || p.fp.pads.length < 8 || p.type !== "smd") continue; const d = Math.hypot(p.x - s.x, p.y - s.y); if (d < dp) { dp = d; pin = p; } }
      if (!pin) continue; let vp = Infinity, vc = Infinity; for (const v of vias) { if (v.net !== s.net) continue; vp = Math.min(vp, Math.hypot(v.shape.x - pin.x, v.shape.y - pin.y)); vc = Math.min(vc, Math.hypot(v.shape.x - s.x, v.shape.y - s.y)); }
      if (vp < CRAFT_LIMITS.pinVia && vp < dp * 0.7 && vc > vp + 0.5) items.push(`${f.ref} at ${pin.fp.ref} pin ${pin.number} (${bare(s.net)}): the via is ${r2(vp)} mm from the pin and ${r2(vc)} mm from the capacitor`);
    }
    if (items.length) add("bypass.order", "warning", "The supply via lands at the chip's pin and the capacitor hangs on a stub beyond it, so the pin sees the plane's noise before the capacitor can act. Bring the supply to the capacitor's pad first and run a short, pad-wide track from there to the pin: via, capacitor, pin (board.via(net, at) beside the capacitor, then board.track).", few(items));
  }

  // ---- pads.entry: out through the end of a fine-pitch pad
  {
    const bad = new Map<string, Set<string>>();
    for (const p of fine) {
      const w = p.box[2] - p.box[0], h = p.box[3] - p.box[1]; if (Math.max(w, h) < 1.8 * Math.min(w, h)) continue; const horiz = w > h; const lay = layersOf(p.c);
      for (const t of tracks) {
        if (t.net !== p.net || !lay.some((l) => on(t, l)) || t.bbox[0] > p.box[2] || t.bbox[2] < p.box[0] || t.bbox[1] > p.box[3] || t.bbox[3] < p.box[1]) continue;
        const pts = ptsOf(t); if (pts.length < 2) continue;
        for (const [a, b] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]] as [Pt, Pt][]) {
          if (!inBox(p.box, a[0], a[1]) || inBox(p.box, b[0], b[1])) continue; const dx = b[0] - a[0], dy = b[1] - a[1];
          const tx = Math.abs(dx) < 1e-9 ? Infinity : (dx > 0 ? p.box[2] - a[0] : a[0] - p.box[0]) / Math.abs(dx), ty = Math.abs(dy) < 1e-9 ? Infinity : (dy > 0 ? p.box[3] - a[1] : a[1] - p.box[1]) / Math.abs(dy);
          if (!(horiz ? ty < tx - 1e-9 : tx < ty - 1e-9)) continue;
          // sideways only matters towards a neighbour: the last pin of a row may turn away from the row at once
          const sx = horiz ? 0 : Math.sign(dx), sy = horiz ? Math.sign(dy) : 0;
          if (!p.fp.pads.some((q) => q !== p && (horiz ? Math.abs(q.x - p.x) < w / 2 && (q.y - p.y) * sy > 0 && Math.abs(q.y - p.y) <= 1.0 : Math.abs(q.y - p.y) < h / 2 && (q.x - p.x) * sx > 0 && Math.abs(q.x - p.x) <= 1.0))) continue;
          const e = bad.get(p.fp.ref) || new Set<string>(); bad.set(p.fp.ref, e); e.add(p.number);
        }
      }
    }
    const items = Array.from(bad.entries()).map(([ref, s]) => `${ref}: pin${s.size > 1 ? "s" : ""} ${few(Array.from(s), 10).join(", ")}`);
    if (items.length) add("pads.entry", "warning", "These tracks leave a fine-pitch pad through its long side, towards the neighbouring pin: the clearance to that pin is at its smallest there and the joint is hard to inspect. Leave through the end of the pad, in line with it, and turn once clear of the row (board.route() does this by itself; redraw a hand-laid track with board.track through a point straight out from the pad).", few(items));
  }

  // ---- power.return: a ground via beside every supply via
  if (groundLayers.size >= 2) {
    const lone: string[] = [];
    for (const v of vias) { if (!v.net || isGnd(v.net) || kindOf(v.net) !== "supply") continue; let d = Infinity; for (const s of stitches) d = Math.min(d, Math.hypot(s[0] - v.shape.x, s[1] - v.shape.y)); if (d > CRAFT_LIMITS.pairVia) lone.push(`${bare(v.net)} at ${at(v.shape.x, v.shape.y)}${isFinite(d) ? `: nearest ground via ${r2(d)} mm` : ""}`); }
    if (lone.length) add("power.return", "note", `A supply via works as a pair with a ground via: the current goes down one and comes back up the other, and the area between them is inductance in the supply. Put a ground via within ${CRAFT_LIMITS.pairVia} mm of each (board.via("GND", at); board.finish() stitches the pours but does not aim at supply vias).`, few(lone));
  }

  // ---- bus.transitions: every line of a bus through the same number of vias
  {
    const BUS = /(DQ|DATA|ADDR|SDIO\w*|SD_?D(AT)?|QSPI\w*|RGMII\w*|[RT]XD|LCD\w*|DCMI\w*|CAM\w*|FMC\w*|^BA|^A|^D)_?$/i; const groups = new Map<string, string[]>();
    for (const n of nets) { const m = /^(.*?)(\d+)$/.exec(bare(n)); if (!m || !BUS.test(m[1]) || isGnd(n) || kindOf(n) === "supply") continue; const e = groups.get(m[1]) || []; groups.set(m[1], e); e.push(n); }
    const count = new Map<string, number>(); for (const v of vias) if (v.net) count.set(v.net, (count.get(v.net) || 0) + 1);
    const routed = new Set(tracks.map((t) => t.net)); const items: string[] = [];
    for (const [stem, g] of groups) {
      const r = g.filter((n) => routed.has(n)); if (r.length < 4) continue; const c = r.map((n) => count.get(n) || 0); const lo = Math.min(...c), hi = Math.max(...c); if (lo === hi) continue;
      const odd = r.filter((n) => (count.get(n) || 0) !== lo).sort(); items.push(`${stem}: most lines have ${lo} via${lo === 1 ? "" : "s"}; ${few(odd.map((n) => `${bare(n)} ${count.get(n)}`), 6).join(", ")}`);
    }
    if (items.length) add("bus.transitions", "warning", "The lines of one bus should take the same route through the board: the same layers and the same number of vias. A via's delay is hard to know, so lines that differ in vias cannot be matched by track length alone, and each via is one more step for the edge to reflect from. Route the whole group on one layer where it fits (board.route(max_vias=0, nets=[...]) for the group after board.unroute), or give every line the same layer change.", items);
  }

  // ---- vias.aspect: a hole no deeper than ten times its width
  {
    const thick = Number(doc.thickness) || 0; const deep = new Map<number, number>();
    if (thick > 0) for (const v of vias) { const d = Number(v.drill) || 0; if (d > 0 && thick / d > CRAFT_LIMITS.aspect + 1e-6) deep.set(d, (deep.get(d) || 0) + 1); }
    if (deep.size) add("vias.aspect", "warning", `These vias are drilled through a ${r2(thick)} mm board with a hole less than a tenth of that: the plating thins out in the middle of so deep a hole and the fabricator charges for the small drill. Use a drill of ${r2(Math.ceil(thick / CRAFT_LIMITS.aspect * 20) / 20)} mm or more (board.rules(via_drill=...)), or a thinner board.`, Array.from(deep.entries()).map(([d, n]) => `${n} via${n > 1 ? "s" : ""} with a ${d} mm drill`));
  }

  // ---- planes.signals: nothing but ground on a ground plane
  {
    const items: string[] = [];
    for (const layer of copper.slice(1, -1)) {
      if (!groundLayers.has(layer)) continue; const by = new Map<string, number>();
      for (const t of tracks) { if (!on(t, layer) || isGnd(t.net)) continue; by.set(t.net, (by.get(t.net) || 0) + (t.length || 0)); }
      const total = Array.from(by.values()).reduce((a, b) => a + b, 0); if (total < 1) continue;
      items.push(`${layer}: ${r2(total)} mm of track (${few(Array.from(by.entries()).sort((a, b) => b[1] - a[1]).map(([n, mm]) => `${bare(n)} ${r2(mm)} mm`), 5).join(", ")})`);
    }
    if (items.length) add("planes.signals", "warning", "A signal is routed on an inner ground plane. Every track there is a slot in the plane that the signals above and below must cross, which is what the plane is there to prevent. Route on the outer layers and keep the plane whole (board.route(layers=[\"F.Cu\", \"B.Cu\"]); board.unroute(net) takes the track off).", items);
  }
}
