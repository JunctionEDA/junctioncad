// fixes.ts — propose_fixes: the violations of the ERC or DRC that have one mechanical cure, each kind planned as
// one change with the ordinary edits (web/domains/pcb/ai/proposals.ts) and parked as a proposal a person accepts or rejects.
// Nothing here changes the design, and nothing is guessed: a violation whose cure is a design decision (a
// clearance, a short, a pin conflict) is handed back to the model with a hint instead.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Marker { severity: string; code: string; text: string; x: number; y: number; ids?: string[] }
export interface FixPlan { kind: string; title: string; rationale: string; edits: any[]; fixes: number; codes: string[] }
export interface Left { code: string; count: number; example: string; hint: string }

const HINTS: Record<string, string> = {
  clearance: "Move or reroute the copper named in the message; trace_net shows where the net runs.",
  copper_edge_clearance: "Move the track or part in from the board edge, or enlarge the outline.",
  courtyards_overlap: "Move one of the two parts apart (move), then route again where needed.",
  shorting_items: "Two nets touch: find which track is wrong with trace_net and remove or reroute it. cleanup with shorts: true removes shorting tracks, but check which net is the right one first.",
  tracks_crossing: "Reroute one of the two tracks on another layer or around the other.",
  starved_thermal: "pad_connection with connect: solid on the pad named in the message.",
  track_width: "The track is thinner than the board's minimum: reroute the net at the class width, or relax the minimum with set_rules if the fabricator allows it.",
  via_diameter: "Replace the via with one of the class size, or relax the minimum with set_rules.",
  annular_width: "Use a larger via or a smaller drill, or relax the minimum with set_rules.",
  hole_clearance: "Move the track or via away from the hole.",
  track_right_angle: "Reroute the corner as two 45 degree bends (remove the segments and add_track, or autoroute the net).",
  pin_to_pin: "Two pins that must not be joined are on one net (two outputs, an output on a supply): check the wiring with trace_net.",
  wire_dangling: "A wire end touches nothing: extend it to its pin or remove it.",
  unconnected_wire_endpoint: "A wire end touches nothing: extend it to its pin or remove it.",
  duplicate_reference: "Give one of the two parts another reference (set_field Reference).",
  unannotated: "Give the part a number (set_field Reference).",
  hier_label_mismatch: "Make the sheet pin and the hierarchical label inside the sheet match by name.",
  label_multiple_wires: "Move the label so it sits on one wire only.",
  isolated_pin_label: "The label names a net with a single pin: connect the other end or remove the label.",
  missing_footprint: "update_from_schematic puts missing parts on the board.",
  extra_footprint: "A footprint the schematic does not have: remove it, or add the part to the schematic.",
  net_conflict: "update_from_schematic brings the pad nets into line with the schematic.",
};

/** Sort the violations into mechanical fixes (one plan per kind) and the ones left to judgement. */
export function planFixes(doc: any, markers: Marker[], only?: string[]): { plans: FixPlan[]; left: Left[] } {
  const want = only && only.length ? new Set(only) : null;
  const by = new Map<string, Marker[]>();
  for (const m of markers) { if (want && !want.has(m.code)) continue; const l = by.get(m.code); if (l) l.push(m); else by.set(m.code, [m]); }
  const take = (...codes: string[]): Marker[] => { const out: Marker[] = []; for (const c of codes) { const l = by.get(c); if (l) { out.push(...l); by.delete(c); } } return out; };
  const codesOf = (l: Marker[]) => Array.from(new Set(l.map((m) => m.code)));
  const n = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);
  const plans: FixPlan[] = [];
  const at = (l: Marker[]) => { const seen = new Set<string>(); return l.filter((m) => { const k = `${m.x.toFixed(3)},${m.y.toFixed(3)}`; if (seen.has(k)) return false; seen.add(k); return true; }); };

  if (doc.type === "sch") {
    const open = at(take("pin_not_connected"));
    if (open.length) plans.push({ kind: "no_connect", fixes: open.length, codes: ["pin_not_connected"], title: `Mark ${n(open.length, "unconnected pin", "unconnected pins")} as not connected`,
      rationale: `Adds a no-connect flag on each pin the ERC reports as unconnected. Accept only if these pins are meant to stay unused; a pin that should be wired needs a wire instead.\n${open.slice(0, 12).map((m) => m.text.replace(/^Pin not connected: /, "")).join(", ")}${open.length > 12 ? ", ..." : ""}`,
      edits: open.map((m) => ({ op: "add_no_connect", x: m.x, y: m.y })) });
    const undriven = at(take("power_pin_not_driven"));
    if (undriven.length) plans.push({ kind: "pwr_flag", fixes: undriven.length, codes: ["power_pin_not_driven"], title: `Add ${n(undriven.length, "PWR_FLAG", "PWR_FLAGs")} to supply nets nothing drives`,
      rationale: "A supply pin sits on a net with no power output, because the supply comes in through a connector or a passive part. A PWR_FLAG on the net tells the ERC that this is intended.",
      edits: undriven.map((m) => ({ op: "add_symbol", lib_id: "power:PWR_FLAG", x: m.x, y: m.y })) });
    const stray = take("label_dangling", "no_connect_dangling", "no_connect_connected");
    const ids = new Set<string>();
    for (const m of stray) for (const id of m.ids || []) {
      const it = doc.items.get(id); if (!it) continue;
      if (m.code === "no_connect_connected") {   // the marker names the symbol: the flag is the item at the pin
        for (const o of doc.items.values() as Iterable<any>) if (o.kind === "no_connect" && o.bbox && Math.abs((o.bbox[0] + o.bbox[2]) / 2 - m.x) < 0.01 && Math.abs((o.bbox[1] + o.bbox[3]) / 2 - m.y) < 0.01) ids.add(o.id);
      } else ids.add(id);
    }
    if (ids.size) plans.push({ kind: "stray", fixes: ids.size, codes: codesOf(stray), title: ids.size === 1 ? "Remove 1 label or flag that connects nothing" : `Remove ${ids.size} labels and flags that connect nothing`,
      rationale: "Labels on no wire, and no-connect flags that sit on nothing or on a pin that is wired.", edits: Array.from(ids).map((id) => ({ op: "remove", id })) });
  } else {
    const open = take("unconnected_items");
    if (open.length) plans.push({ kind: "route", fixes: open.length, codes: ["unconnected_items"], title: `Route ${n(open.length, "open connection", "open connections")}`,
      rationale: "Runs the autorouter over the connections the DRC reports as missing. Existing copper is not moved.", edits: [{ op: "autoroute", time_s: 30 }] });
    const loose = take("track_dangling", "via_dangling");
    if (loose.length) plans.push({ kind: "dangling", fixes: loose.length, codes: codesOf(loose), title: `Remove ${n(loose.length, "track end or via", "track ends and vias")} that lead nowhere`,
      rationale: "KiCad's Cleanup Tracks and Vias with dangling items removed.", edits: [{ op: "cleanup", dangling: true }] });
    const silk = take("silk_over_copper", "silk_overlap", "silk_edge_clearance", "text_height");
    if (silk.length) plans.push({ kind: "silk", fixes: silk.length, codes: codesOf(silk), title: `Tidy the silkscreen (${n(silk.length, "violation", "violations")})`,
      rationale: "Moves each reference designator beside its part where it lies on no pad, no other text and not over the edge, making it smaller only where it does not fit.", edits: [{ op: "silkscreen" }] });
  }
  const left: Left[] = [];
  for (const [code, l] of by) left.push({ code, count: l.length, example: l[0]!.text, hint: HINTS[code] || "No mechanical fix: read the message, look with render_view violations: true, and propose a change with apply_changes propose: true." });
  left.sort((a, b) => b.count - a.count);
  return { plans, left };
}
