# PCB design rules built into the harness

This is the reference behind `board.plan()`, `board.stackup()`, `board.prepare()`, `board.finish()`, `board.review()`
and `kh.calc`. Each rule says what to do, why, and how the harness applies or checks it. Rules marked **checked** are
tested automatically by `board.review()` (`review_design` on the board); rules marked **planned** are applied before
placement or routing by `board.plan()`; rules marked **manual** are printed in the review's manual checklist because
they cannot be read from the copper.

Code: `server/web/domains/pcb/ai/review-physics.ts` (checks and plans), `server/harness/kicad_harness/physics.py` (calls and sums),
`server/harness/kicad_harness/stackups.py` (stackups, materials, fabricators), `server/web/domains/pcb/ai/review-craft.ts` and
`server/harness/kicad_harness/craft.py` (workshop practice and the one-call layout). Tests: `server/harness/tests/test_physics.py`,
`test_stackups.py`.

## Sources, and how far to trust them

Read directly while writing this (figures taken from the documents):

- Espressif, ESP32-C3 Hardware Design Guidelines, PCB layout chapter.
- Johanson Technology, chip antenna layout notes (2450AT series).
- Texas Instruments SPRAAR7, High-Speed Interface Layout Guidelines.
- Texas Instruments SLMA002, PowerPAD Thermally Enhanced Package.
- Texas Instruments LMR33630 datasheet, layout section (buck converter).
- Texas Instruments OPA858 datasheet, layout section (high-speed amplifier, transimpedance).
- Analog Devices, photodiode front-end layout notes (guarding).
- IPC-2221 table 6-1 (electrical clearance) and its current formula.
- JLCPCB capability, impedance stackup and flex capability pages; PCBWay capability, stackup and flex pages (read 2026-11).

Standard texts whose well-known results are used but which were not re-read page by page: Johnson and Graham,
*High-Speed Digital Design*; Bogatin, *Signal and Power Integrity Simplified*; Ott, *Electromagnetic Compatibility
Engineering*; Hartley's stackup and return-current papers; JEDEC and vendor memory layout guides (Micron TN-46-14,
TN-41-13, TN-40-40; NXP and TI DDR application notes); ST AN2867 (oscillator design; its layout section was not
obtained). Memory-bus tolerances and the material constants come from these and from makers' datasheets as commonly
quoted. Treat every number as a starting point: the part's own datasheet and the fabricator's own calculator win.

## The order of work

Physics is decided before placement, not found by a review at the end.

1. `board.sync()`, outline.
2. `board.plan()`: from the netlist it works out what sits beside what, what goes on an edge, what must be kept
   apart, the width and kind of every net, the routing order, each interface's impedance and skew, and the stackup.
3. `board.stackup(fab=..., layers=..., material=..., finish=...)`: the physical layers and the fabricator's limits
   become the design rules. Track widths for 50 and 90 ohm follow from this, so it comes before routing.
4. `board.autoplace(near=plan["place"]["near"], edges=plan["place"]["edges"])`.
5. Ground zones on every layer that carries them.
6. `board.prepare()`: antenna keep-outs and their ground vias, before the router can put copper there.
7. `board.route(**plan["route"])`: critical nets, then inside each cluster, then power, then between clusters
   (see "Cluster first").
8. `board.finish()`: RF fences, thermal vias, the antenna's ground edge, stitching, refill.
9. `board.review()` until clean.

## The circuit, before the board

`sch.review()` checks the support circuits from the netlist (`server/web/domains/pcb/ai/review-circuit.ts`,
`harness/tests/test_circuit.py`), because a board laid out perfectly round a wrong circuit is still wrong:

- One small bypass capacitor for each supply pin, not one per chip (`bypass.count`).
- Exactly one pull-up per I2C line, and no smaller than (V - 0.4 V) / 3 mA, which is 967 ohm at 3.3 V; above
  about 10k the edges are too slow for 400 kHz (`i2c.pullups`).
- A crystal has a capacitor each side, both the same, C = 2 x (CL - Cstray) with 2 to 5 pF of stray; the crystal's
  CL comes from a `CL` field (`crystal.load`).
- A USB-C socket has its own resistor on CC1 and on CC2: 5.1k to ground for a device, 56k, 22k or 10k to VBUS for
  a source; joined CC pins or a missing resistor mean no power from a C-to-C cable (`usbc.cc`). USB data lines
  have an ESD part (`usb.esd`).
- A regulator has a capacitor on its input and its output (`regulator.caps`); its feedback divider sets
  Vout = Vref x (1 + Rtop / Rbottom) and that must be the voltage the output net is named for
  (`regulator.setpoint`; the reference voltages of common adjustable regulators are built in, others take a `Vref`
  field); a linear regulator loses P = (Vin - Vout) x I in a package good for about 1 W (SOT-223), 0.5 W
  (SOT-89) or 0.3 W (SOT-23) (`regulator.heat`).
- Every LED has a series resistor; more than 20 mA, or more than about 8 mA from an IC pin, is flagged
  (`led.current`).
- Net names that differ only in case or separators, or by one dropped or swapped letter, and named nets that
  reach a single pin (`nets.typos`). One passive package size where possible (`passives.sizes`).

## Stackup and return paths

- Every signal has a return current, and above a few hundred kilohertz it flows in the plane directly under the
  track. A track is only as good as the unbroken copper beneath it. **checked** (`return.path`: fast and RF tracks
  are walked and each point must have ground on the adjacent layer; a gap in the pour under a fast track is an error.)
- Four layers as soon as there is a radio or a fast bus: signal, ground, power, signal. Layer 2 is solid ground
  (Espressif). Six layers: signal, ground, signal, power, ground, signal, so inner signals run between planes.
  **planned** (`plan["stackup"]`), **checked** (`stackup.reference`).
- Do not split the ground plane. Separate by placement; never route across a gap.
- A fast signal that changes layer needs a ground via beside it so the return current can change planes too: within
  200 mil (5 mm) per TI, closer is better. **checked** (`return.vias`).
- Stitch ground pours together about every centimetre, and no further apart than a twentieth of a wavelength of the
  highest frequency on the board. **checked** (`ground.stitching` in the layout checklist; `antenna.fence` for RF).
- Keep fast tracks away from the plane edge (TI: pairs at least 90 mil from the edge of the reference plane).

## Impedance

`kh.calc.microstrip(width, height, er)`, `stripline`, `width_for(ohms, height, er)`, `pair(...)`; the router sizes RF nets from the
board's stackup. On JLCPCB's default four-layer build (0.21 mm of 7628 prepreg) 50 ohm is about 0.35 mm; on the
3313 build (0.1 mm) about 0.17 mm. On a two-layer 1.6 mm board a 50 ohm microstrip is about 3 mm wide: use four
layers or a coplanar feed. **checked** (`rf.feed` compares each RF track's width with the stackup's 50 ohm width).

## Radio and RF (Bluetooth, WiFi, LoRa, GPS, sub-GHz, anything with an antenna)

- The antenna sits at a board edge, ideally a corner, pointing away from the board. **planned**, **checked**
  (`antenna.keepout`).
- Chip and trace antennas: no copper on any layer under or beside the antenna, sized to its datasheet (Johanson:
  ground more than 2 mm from the short edges and 4 mm from the long edge). `board.antenna(ref)` adds the keep-out.
  **checked**.
- The ground right beside the clear area is the antenna's counterpoise, so it stays whole: a band of 1.2 mm round
  the clear area holds only the feed, the matching network and ground vias. No decoupling capacitor, supply track
  or signal via stands or runs there (owner, 2026-11-15: capacitors and a via hugging the keep-out edge are
  "cooked"). **planned** (`seat`, `place_bypass`, `settle` keep parts out; the router keeps other nets out,
  `antennaBand`), **checked** (`antenna.ground`, an error, so `design()` refuses the board).
- Patch antennas (GPS, GNSS) are the opposite: unbroken ground under and around them. **checked**.
- The ground edge facing the antenna, and the pours beside the feed, are stitched with vias no further apart than
  a twentieth of a wavelength in the board: about 2.9 mm at 2.45 GHz, 1.2 mm at 5.8 GHz, 4.5 mm at 1.575 GHz
  (GPS), 7.8 mm at 915 MHz (LoRa); the harness never goes wider than 8 mm. The harness reads the band from part values and net
  names. `board.antenna()`, `board.fence_net(net)`. **checked** (`antenna.fence`).
- The feed is 50 ohm, on the outer layer, over solid ground, with no vias, no stubs and no right angles (135 degree
  bends or arcs), and as short as placement allows (Espressif). **checked** (`rf.feed`).
- The matching network (pi or CLC) sits at the antenna end in a straight line, with its shunt parts grounded
  directly. **planned**.
- Keep switching converters, their inductors and crystals away from the antenna. **planned** (`apart`), **checked**.
- Nothing metal within about 15 mm of the antenna in the finished product; tune the match on the real board.
  **manual**.
- Above about 3 GHz, or for long 50 ohm runs, filters and couplers, use a low-loss laminate (RO4350B); above
  20 GHz PTFE. **planned** (`kh.materials.choose`), **checked** (`stackup.material`).
- LNA and PA stages: input and output on opposite sides, ground vias at every ground pad, supply decoupled per
  stage with the smallest capacitor nearest the pin, DC feed through a choke.

## Cluster first

Said by the owner 2026-11-15 ("I grouped together some of the components and planned out how I would route INSIDE
THOSE GROUPS FIRST", "this is critical"), with their Frost board and a USB-C PD controller as the examples, and
measured on Ledify, Cyberboard, Ember and Frost: the pad of a small part sits a median 2.0 to 2.1 mm from the pin
it serves (90th percentile 4.2 to 5.0 mm), and in 70 to 85 percent of cases its other end points away from the chip.

1. A cluster is one chip and everything that serves it: bypass capacitors, pull-ups, series resistors, the crystal
   and its load capacitors, a converter's inductor and capacitors, a connector's ESD part and CC resistors. The
   parts ring the chip, each at the pin it serves, the pad on that net facing the pin, the ground or far end
   outward, all within about one part length of the package.
2. The connections inside a cluster are planned and routed first: short, on the parts' layer, no via. A connection
   inside a cluster that needs a via or a detour means the cluster is built wrong.
3. Only then are the clusters placed on the board, with the critical nets in mind: each cluster put down and turned
   so its USB pair, RF feed or crystal line comes out short, straight and on one layer, and the nets that leave face
   where they go. A square chip may stand at 45 degrees when its cluster comes out smaller that way.
4. Then the tracks between clusters: critical nets (USB pair, RF feed, crystal) first, then power, then the rest.
   (Owner, 2026-11-16, after the benchmark: critical nets first, then the inside of each cluster; Ledify 93.4
   that way against 71 the other way round, where the later tracks cut the supply pours.)
5. Power as on Ember: pads of one supply or switching net that stand together are joined by a top-layer pour, not a
   track, and a block of vias about 1 mm apart (Ember's PPHV: 192 vias at 0.9 mm, +3.3V: 0.47 mm) takes the pour
   down into the net's inner plane. A pin of a net with an inner plane drops straight into it. The ground plane
   stays whole (the router's `planes: true` keeps tracks off it; off by default, it cost Ledify 20 points). Ground is stitched about every 1.5 to 2 mm.

Where it lives: `board.autoplace` builds the clusters (`near=`, `seat`, `place_bypass`); the router
(`web/domains/pcb/router/route.ts`) finds the clusters (`opts.groups`, or from the board: a small part belongs to the nearest
chip it shares a net with, within 5 mm pad to pad) and orders its queue critical nets, inside each cluster, power,
fine-pitch escapes, the rest; its result carries `groups: {clusters, inside, insideRouted, insideVias}`.
`board.design()` hands the plan's clusters to it and reports `routed.inside_groups`. A one-layer route may be 1.6
times the straight line plus 5 mm before a layer change is taken instead, a via costs 12 mm of track, plain signals
are widened to 0.2 mm where the clearances allow, and ground is stitched on a 2 mm grid: all four are what the
owner's boards do. The placer (`web/domains/pcb/router/place.ts`) pulls four times harder along critical nets and tries a
square chip at 45 degrees (kept when its block is 5 percent smaller). The harness makes the power pours
(`board.power_pours()`, before routing in `design()`) and the via blocks (`board.power_stitch()`, in `finish()`).
`scripts/board-bench.py` scores the router against those boards after every change.

## Parts that serve a pin

Said by the owner 2026-11-15 after a board where the CC resistors, the crystal and the matching network were
placed by typed coordinates. One rule covers them all: a small part whose job is one pin of a larger part sits in
front of that pin, turned so its far end points where its other net goes. `board.seat()` (run by `autoplace` and
`design`) places them; `board.seating()` checks them; `design()` refuses a board that fails.

- USB-C configuration resistors (5.1 k on CC1 and CC2) sit directly in front of their CC pins, ground ends
  towards the outer edges of the connector. **planned**, **checked** (`usb.cc`).
- Pull-ups, pull-downs, series resistors, LED resistors, regulator input and output capacitors and ESD parts sit
  within 3 mm of the pin they serve. **planned**, **checked** (`serve.near`).
- A crystal sits beside the oscillator pins, turned so its pads face the pins in the same order, so both nets
  reach it on the top layer without a via; load capacitors on the far side, grounded at once. **planned**,
  **checked** (`crystal.near`, `crystal.vias`).
- A four-pad crystal has its two signal pads on a diagonal, so whichever way it is turned one ground pad lies
  between the two tracks. Turn it so both tracks run straight from the pins without a jog and the other ground
  pad faces open pour; the boxed-in ground pad takes one ground via beside it (a ground via is not a fault, a via
  on XTAL_I or XTAL_O is). **planned**, **checked** (`crystal.vias`).
- A matching network runs in a straight line from the RF pin to the antenna feed, series parts in line, shunts
  beside the line with their ground ends away from it; the whole RF net no longer than 12 mm. Other nets do not
  cross the antenna's clear area. **planned**, **checked** (`rf.match`, `rf.feed`).
- A USB-C receptacle's twin data pins (D- D+ D- D+ in one row) are joined at the pads before anything is routed
  (`board.bridge_twins()`, run by `design()`): a short U on each side of the row when the chip wants the pair in the
  order of the outer pads, and otherwise the inner pads start the pair, one twin is joined by a U under the
  connector and the other by a hop of a few millimetres on the back. The pair itself runs coupled and straight from
  the connector to the chip with no via; never a loop round the connector. **planned**, **checked** (`usb.vias`
  allows only that hop; `pairs.coupled`).
- In the schematic a crystal is drawn inside its chip's frame, under the decoupling capacitors, joined by labels;
  supply symbols on neighbouring pins stand one step apart in height, never on a long wire.
- No part outside the board outline, none on top of another. **checked** (`placement.outside`,
  `placement.clash`).
- A layout that fails any of these, has open connections, DRC errors or review errors is refused by `design()`
  and is not published or saved. Try layouts with a dry run, never on the live project.

## High-speed digital and interfaces

`kh.calc.interface(name)` returns each row with its notes. Differential impedance in ohm, skew within the pair,
and the rule the review applies:

| Interface | Impedance | Pair skew | Notes |
|---|---|---|---|
| USB 2.0 | 90 | 1.27 mm (50 mil) | short, one layer, at most 4 vias, ESD at the connector |
| USB 3, HDMI, DisplayPort, PCIe, SATA | 85 to 100 | 0.13 mm (5 mil) | AC capacitors at the transmitter, no stubs, ground via at each layer change |
| Ethernet (MDI) | 100 | 1.27 mm | magnetics close to the PHY, no plane under the magnetics' line side |
| MIPI CSI/DSI, LVDS | 100 | 0.13 mm | lanes matched to the clock |
| CAN, RS-485 | 120 | loose | termination at the ends of the cable, TVS at the connector |
| SD, eMMC, QSPI | 50 single-ended | data matched to clock | series resistors at the driver |
| SDRAM, DDR1 to DDR5, LPDDR4 | 40 to 60 single-ended, 80 to 100 strobes and clocks | per byte lane | below |
| I2C, SPI, I2S, JTAG | not controlled | none | pull-ups once per bus, clock away from analog |

- A pair's two tracks have the same length, the same layer, the same vias and a constant gap; skew is made up
  near the end where it arises. **checked** (`pairs`).
- A track is a transmission line once it is longer than about a sixth of the rise time's length
  (`kh.calc.critical_length(rise_s)`); then it needs a reference plane and, usually, termination.
- No test points, stubs or tees on fast lines (TI). ESD parts directly at the connector, in line. **checked**
  (`esd.near`).

### Memory: SDRAM to DDR5

- Group signals by byte lane: eight data, the mask and the strobe pair of a lane route together, on the same layer,
  with the same via count. Match every line of a lane to its strobe (the harness uses 0.65 mm for DDR2, 0.5 mm for DDR3, 0.25 mm for DDR4,
  0.13 mm for DDR5, and 0.13 to 0.25 mm inside a strobe or clock pair), strobes to clock loosely (fly-by
  levelling takes up the rest from DDR3 on), and address, command and control to the clock.
- Topology: SDRAM, DDR1 and DDR2 use a balanced tree for address and clock; DDR3, DDR4 and DDR5 use fly-by
  (a daisy chain through the chips in order, terminated to VTT at the far end).
- Reference: data lanes over ground; address lines over ground or a solid VDD plane. No track crosses a plane
  split. VREF is a wide, quiet track with its own decoupling; VTT gets a small plane and bulk capacitance.
- Spacing: three track widths between unrelated signals, more to clocks and strobes. Decoupling under the chip.
- DDR5 adds 1.1 V rails from an on-module PMIC, tighter matching and back-drilled or blind vias on long channels.
- **checked** (`bus.match`: every line of a lane or bus is compared with its strobe or clock, with the tolerance
  of the interface the net names indicate).

## Power

- Track width for current: IPC-2221, `kh.calc.track_width(amps, rise=10, oz=1, internal=False)`. On 1 oz outer copper for a
  10 K rise: 0.3 mm for 1 A, 0.53 mm for 1.5 A, 0.78 mm for 2 A, 1.37 mm for 3 A. A 0.3 mm via carries about 1 A; use
  `kh.calc.vias_for(amps)`. Espressif's own figures: 25 mil for the main supply, 20 mil for the 3.3 V rail, 10 mil
  for small branches. **planned** (`route.widths`), **checked** (`power.width` in the layout checklist; `power.path` for nets through an
  inductor or from a battery).
- Switching converters: the hot loop (input capacitor, switch, ground) is as small as the parts allow, the input
  capacitor directly across VIN and GND of the chip; the switch node is short and compact, not a pour; the
  inductor is next to the switch pin with nothing sensitive beside or under it; the feedback divider sits at the
  FB pin and its sense track leaves from the output capacitor, away from the inductor (TI LMR33630). **planned**,
  **checked** (`switcher.loop`, `switcher.node`).
- Linear regulators and power parts: copper area and thermal vias for the dissipation
  (`kh.calc.thermal_rise(watts, theta_ja)`).

## Decoupling and power integrity

- One small capacitor per supply pin, closer to the pin than anything else, with its ground end on a via straight
  into the plane; the loop from pin through capacitor to ground is what matters, not the value. **planned**,
  **checked** (`bypass.near` in the layout checklist, `bypass.return`).
- Bulk capacitance where the supply enters and at each regulator output. A capacitor is only a capacitor below
  its self-resonance (`kh.calc.decoupling_resonance(farads, nh)`); smaller packages have less inductance.
- A power plane next to a ground plane is the best high-frequency decoupling there is.

## EMC

- Small loops radiate less: keep every fast signal against its return, every switching loop tight.
- Clocks and switch nodes stay away from connectors and board edges; filter and protect every line that leaves
  the board, at the connector. **checked** (`esd.near`).
- Crystals: against the oscillator pins (Espressif: about 2 mm from the pin at least, to keep the chip's noise off
  it, and no further than needed), load capacitors beside it, ground underneath, no tracks through or under it,
  no vias on its tracks, a ring of ground vias around it. **planned**, **checked** (`crystal`).
- Connector shells to chassis ground; the cable shield never to signal ground through a track.

## Analog and amplifiers

- Analog, digital, switching and radio each get their own area over one unbroken ground. **planned**, **checked**
  (`analog.separation`: analog tracks beside switch nodes).
- Op-amp inputs are the sensitive nodes: feedback and gain parts sit at the pins, the inverting node is as small
  as possible, and for fast amplifiers the planes are cut away under the input pins to remove their capacitance
  (TI OPA858). Outputs driving capacitance get a series resistor at the pin. **checked** (`amplifier.input`).
- References and ADC inputs: route with their return beside them, away from clocks; filter at the pin.
- Star the returns of high-current stages to the supply so their current does not flow under the input stage.
- Audio: keep inputs away from class-D outputs and the supply inductor; ground the input connector at one point.

## Optoelectronics and high-impedance nodes

- A photodiode feeding a transimpedance amplifier is a picoamp node: the diode on the same side as the amplifier,
  millimetres from the input, on one layer, with a guard ring driven to the same potential around it and nothing
  routed beside or under it (ADI, TI). Clean the board: flux residue leaks. **checked** (`analog.highz`).
- Optocouplers and digital isolators: nothing crosses the gap under the part on any layer, pours included.
  **checked** (`isolation`).
- LEDs and laser drivers: the pulse current loop (capacitor, switch, emitter) is as small as a converter's hot
  loop; power LEDs go on a metal-core board or a field of thermal vias. Image sensors and their MIPI lanes follow
  the interface table; keep their analog supply quiet.

## High voltage

- Clearance for the voltage between conductors follows IPC-2221 table 6-1 (`kh.calc.spacing(volts, "B2")`):
  for example 0.64 mm at 150 V on uncoated outer layers at sea level, 1.25 mm at 300 V, 2.5 mm at 500 V. Mains
  needs the safety standard's creepage as well (often 6 mm and more reinforced), and slots where the surface
  path is too short. **checked** (`creepage`: net voltages are read from net names).

## Heat

- An exposed pad is the package's heat path: an array of vias inside it to the ground planes, about 1.2 mm apart,
  drill 0.3 mm or less so solder does not wick, no thermal relief (TI SLMA002). `board.thermal_vias(ref)`.
  **checked** (`thermal.pad`).
- Heat spreads in copper, not in FR-4: give hot parts solid copper on every layer under them, tied with vias.
- Real heat (LEDs, power stages of several watts) wants aluminium or copper core. **planned**
  (`kh.materials.choose(watts=..., led=True)`), **checked** (`stackup.material`: nothing on the back, no plated
  holes).

## Stackups, materials and finishes

`board.stackup()` writes KiCad's physical stackup (Board Setup, Physical Stackup), the board thickness and the
copper finish, and with `fab=` the fabricator's limits as design rules.

Named builds (the fabricators' own figures, mm):

| Build | Stack |
|---|---|
| JLC04161H-7628 | 0.035 Cu, 0.2104 prepreg 7628 (er 4.4), 0.0152 Cu, 1.065 core, 0.0152 Cu, 0.2104 prepreg, 0.035 Cu |
| JLC04161H-3313 | as above with 0.0994 prepreg 3313 (er 4.1) and a 1.265 core |
| JLC04161H-1080 | as above with 0.0764 prepreg 1080 (er 3.91) and a 1.265 core |
| JLC06161H-3313 | 0.035, 3313 0.0994, 0.0152, core 0.55, 0.0152, 2116 0.1088, 0.0152, core 0.55, 0.0152, 3313 0.0994, 0.035 |
| JLC06161H-7628 | 0.035, 7628 0.2104, 0.0152, core 0.4, 0.0152, 7628 0.2028, 0.0152, core 0.4, 0.0152, 7628 0.2104, 0.035 |
| PCBWAY-4L-1.6 | 0.035, 7628 0.1855 (er 4.74), 0.035, core 1.03 (er 4.6), 0.035, 7628 0.1855, 0.035 |

Any other layer count or thickness is worked out from the thickness and returned with `derived: True`; use the
fabricator's impedance calculator before ordering controlled impedance on those. PCBWay's page gave no six-layer
stack.

Fabricator limits (`kh.FABS`), mm:

| | JLCPCB rigid | PCBWay rigid | JLCPCB flex |
|---|---|---|---|
| Track and space, 1 oz | 0.10 two-layer, 0.09 multilayer | 0.10 minimum, 0.127 without surcharge | 0.09 (18 um copper), 0.10 (35 um) |
| Via hole / pad | 0.15 / 0.25 minimum, 0.3 / 0.6 standard | 0.2 (0.15 extra) | 0.3 / 0.55 |
| Annular ring | 0.15 | 0.15 | 0.18 |
| Copper to edge | 0.2 (0.4 to a V-cut) | 0.25 | 0.3 |
| Mask bridge | 0.10 | 0.10 | coverlay bridge 0.5 |
| Silkscreen | 0.15 line, 1.0 high | 0.15 line, 0.8 high | 0.15 line, 1.0 high |
| Finishes | HASL, lead-free HASL, ENIG, OSP | those plus hard gold, silver, tin, ENEPIG | ENIG only |

Materials (`kh.MATERIALS`, `kh.materials.choose(...)`):

| Material | er | Loss tangent | Use it for |
|---|---|---|---|
| FR-4 (and TG170) | 4.5 | 0.02 | almost everything; high-Tg for many layers, lead-free, heat |
| Polyimide (flex) | 3.3 | 0.008 | anything that bends |
| Aluminium core | | | LEDs and power that must lose heat; one-sided |
| Copper core | | | the hottest parts; one-sided |
| Rogers RO4350B / RO4003C | 3.66 / 3.55 | 0.0037 / 0.0027 | RF from about 3 GHz, long 50 ohm runs, filters |
| Rogers RO3003, PTFE | 3.0 / 2.2 | 0.001 / 0.0009 | radar and millimetre-wave |

HDI (laser microvias, via in pad, blind and buried vias) is a build, not a material: it is needed when a BGA is
0.5 mm pitch or finer. Both fabricators quote it; the harness does not yet place blind or buried vias.

Finishes: ENIG for BGAs, QFNs, 0.5 mm pitch and finer, flex, and pressed contacts; HASL (leaded or lead-free) when
cost matters and nothing is fine-pitch; OSP for cheap fine pitch assembled soon; immersion silver for microwave;
hard gold with a bevel on edge-connector fingers; ENEPIG for wire bonding. JLCPCB does not offer HASL on six layers
and up, on 0.4 mm boards or on RF laminate; aluminium there is HASL only. The harness refuses a finish the chosen
fabricator does not offer on that kind of board.

## Flex

- Stack: `board.stackup(fab="jlcpcb", material="flex", layers=2)` gives 25 um polyimide, 18 um copper each side
  and a 27.5 um coverlay each side (12.5 um polyimide on 15 um adhesive), 0.11 mm finished, ENIG. A thickness of
  0.19 asks for the 50 um polyimide build. Four-layer flex is derived.
- Bend radius: at least 6 times the thickness for one layer, 10 times for two or more, bent once; 10 to 15 times,
  one or two layers and adhesiveless polyimide when it flexes in use (JLCPCB; PCBWay quotes 3 to 6, 7 to 10 and
  10 to 15 by layer count). `kh.calc.bend_radius(...)`.
- Mark every bend with `board.bend_area(box)`. In a bend: no vias, no pads, no parts; tracks cross straight, at
  right angles to the fold, and turn their corners outside it; tracks on the two sides are staggered, never one
  over the other; no solid pour (hatch it); the fewest layers. **checked** (`flex.bend`, `flex.copper`).
- Everywhere on flex: copper at least 0.3 mm from the outline; rounded track corners and teardrops at every pad
  and via; pads a little larger than on a rigid board and held down by the coverlay; inside corners of the outline
  rounded, with a relief hole or a copper tear stop.
- Parts and connector contacts need a stiffener behind them: FR-4 under parts, polyimide behind ZIF fingers
  (a 0.3 mm connector takes the 0.11 mm board plus a 0.225 mm polyimide stiffener), steel where it must be thin
  and stiff. Say which stiffeners the order needs. **manual**.
- Impedance on prototype flex is not controlled at JLCPCB; PCBWay controls it and also builds rigid-flex.

## Manufacture

- Design to the fabricator's standard limits, not their minimum: `board.stackup(fab=...)` writes them into the
  rules and the DRC holds the board to them.
- No open via in a small part's pad (tombstoning) unless the order is for filled and capped vias. **checked**
  (`dfm.via_in_pad`).
- Fiducials, test points, readable silkscreen, one passive size where possible, parts in stock: the layout
  checklist in the guide covers these.

## Workshop practice (Phil's Lab)

Source: the board walk-throughs and PCB routing videos of Phil's Lab (Philip Salmony, youtube.com/@PhilsLab), read
as transcripts in 2026-11 and distilled here in our own words. Twenty videos were read in full (first table). The
other forty board walk-throughs, design reviews and layout topics (second table) were skimmed: only the sentences
of their layout chapters that state a rule were read, to find what the first twenty had not already said.

| # | Video | Link |
|---|---|---|
| 112 | PCB Traces 101 | youtu.be/xEVntmYLARw |
| 77 | PCB Vias 101 | youtu.be/WPT96w3eLAM |
| 176 | Copper Pours 101 | youtu.be/Ao2HUjjhlmQ |
| 175 | Via Fencing and Edge Plating | youtu.be/fQ1BTyvXfKw |
| 156 | Crosstalk | youtu.be/lLknjLemY-M |
| 83 | Differential Pairs | youtu.be/xwrdvhm4vgw |
| 137 | 2-Layer PCB Design Tips | youtu.be/M6_an34wQJk |
| 144 | QFN PCB Design Tips | youtu.be/hOamoJ15hmA |
| 95 | BGA PCB Design Tips | youtu.be/0KbINAq0hcU |
| 60 | Switching Regulator PCB Design | youtu.be/AmfLhT5SntE |
| 75 | ESD Protection | youtu.be/MmG_m4xVNfQ |
| 25 | High-Speed PCB Design Tips | youtu.be/VRJI0X-6yTg |
| 19 | Practical RF Hardware and PCB Design Tips | youtu.be/_Hfzq1QES-Q |
| 18 | Common PCB Design Mistakes | youtu.be/IclJ9nbtYgI |
| 43 | Critiquing My Own PCB Designs | youtu.be/eQYJLRH4WPs |
| 84 | Aesthetic PCB Design Tips | youtu.be/D2UaRPkRExw |
| 88 | Mixed-Signal Hardware and PCB Design Tips | youtu.be/v6fTa6LRJLI |
| 131 | PCB Design Final Touches (Tips and Checklist) | youtu.be/g4m91gv-4oQ |
| 166 | KiCad 9 Hardware Design Tutorial, part 2 (PCB) | youtu.be/igQWdVGZGpI |
| 128 | KiCad 7 STM32 Bluetooth Hardware Design, part 2 (PCB) | youtu.be/PlXd3lLZ4vc |

Skimmed for rules not already covered:

| # | Video | # | Video |
|---|---|---|---|
| 174 | USB 3.1 to Gigabit Ethernet Adapter Hardware Design | 143 | Gigabit Ethernet Hardware Design |
| 115 | Interfacing FPGAs with DDR Memory | 107 | M.2 System-on-Module Hardware Design |
| 104 | USB-C Power Delivery Hardware Design | 101 | USB Headphone Amplifier Design Walkthrough |
| 90 | ESP32 + PCB Antenna Hardware Design Tutorial | 86 | USB Hub Design Walkthrough |
| 85 | FPGA PCB Design Review | 81 | Design Review (Buck + STM32 + Peripherals) |
| 78 | Mini 6-Layer Mixed-Signal Hardware Design Walkthrough | 76 | RF + MCU PCB Design Review |
| 70 | Design Review, Schematic and PCB | 66 | ESC Hardware Design |
| 65 | KiCad 6 STM32 PCB Design Full Tutorial | 63 | Design Review (Spartan 7 FPGA) |
| 57 | Audio Processor Prototype Hardware Design | 45 | Mixed-Signal Hardware Design Overview |
| 41 | STM32 PCB Design, Complete Walkthrough | 36 | KiCad Breakout Board Design (STM32 + Sensor) |
| 35 | How To Design a Breakout Board | 28 | Raspberry Pi RP2040 Hardware Design |
| 1 | Flight Control System Design: Hardware and PCB Design with KiCad | 125 | Class D Audio Amplifier Hardware Design |
| 110 | High-Speed PCB Delay Matching Explained | 139 | PCB Chip Antenna Hardware Design |
| 106 | Boost Converter PCB Design | 170 | PCB Design Rules 101 |
| 171 | PCB Controlled Impedance | 56 | PCB Stack-Up and Build-Up |
| 93 | Thermal PCB Design Tips | 161 | PCB Power Distribution Networks (PDN) Basics and Measurements |
| 132 | I2C Hardware and PCB Design | 69 | PCB and Schematic Tip: Net Ties |
| 40 | PCB Design for Manufacturing Tips (DFM) | 158 | PCB Design for Manufacturing (DFM) Q&A with Sierra Circuits |
| 133 | PCB Silkscreen and Solder Mask 101 | 121 | Series Termination Basics |
| 119 | Parallel Termination Basics | 155 | Series Termination Resistor Selection |

Most of what the videos teach was already in the harness from the references above (unbroken ground and never a
split, return vias, pairs, crystals, converter loops, ESD first at the connector, fences at a twentieth of a
wavelength, thermal pad vias, stitching, fiducials, silkscreen). What they added:

**Checked** by `board.review()` (`server/web/domains/pcb/ai/review-craft.ts`, tests in `harness/tests/test_craft.py`):

- `tracks.minimum`: signal tracks are 0.2 to 0.3 mm, never the fabricator's minimum, and neck down only at a
  fine-pitch pad row. Reported when a net has 5 mm or more below 0.15 mm further than 2 mm from a fine-pitch pad.
- `crosstalk.victims`: reset, crystal, reference and analog lines keep three track widths, centre to centre, from
  clocks, fast lines and switch nodes over any run above 5 mm. An unstitched guard track does not help.
- `vias.slot`: neighbouring vias leave room for plane copper between their clearance holes (two clearances plus
  0.15 mm). Four or more in a merged row longer than 4 mm are reported as a slot in the ground.
- `cluster.inside`: a net that lives inside one cluster (a chip pin and the small parts on it, within 6 mm) has no
  via and no wandering track; if it does, the cluster is built wrong (the owner's cluster-first rule, see above).
- `bypass.order`: the supply reaches the pin through the capacitor (via, capacitor, pin), on a short pad-wide track.
- `pads.entry`: a track leaves a fine-pitch pad through its end, in line with the pad, not sideways towards the
  next pin.
- `power.return`: a supply via has a ground via within 2.5 mm (a note, not a warning).
- `planes.signals`: no signal on an inner ground plane layer.
- `bus.transitions` (from the skim, #110): the lines of one bus use the same layers and the same number of vias, so
  that only track length has to be matched; a via's delay is hard to know. Match by delay, not by length, when a
  bus runs on both outer and inner layers (`kh.calc.interface(...)` gives the skew).
- `vias.aspect` (#40): board thickness over drill is at most ten.

**Applied** by `board.design()` (`harness/kicad_harness/craft.py`), which runs the whole order of work in one call:
plan, stackup, placement, ground on both outer layers and on both inner layers of a four-layer board (signal,
ground, ground, signal), antenna keep-outs, routing with the plan's order, a second pass at what is left open,
`finish()`, `cleanup()`, `silkscreen()`, the DRC and a one-line-per-finding review (`board.brief()`).

**Manual** (printed in the review's checklist): place and route in order of criticality with supplies and the pour
last; read the Gerbers layer by layer; compare hand-made footprints with the datasheet; a series termination
resistor at the driver (the track's impedance less the driver's output impedance, #121 and #155) and a parallel one
at the end of the line after the last load (#119); a current-sense resistor measured four-wire from the inside of
its pads (#104); a ground pin beside every signal pin of a header that carries fast signals (#63); I2C lines not
routed as a pair, and a bus with several devices run through them in a chain rather than a star (#132).

**Also from the skim, already the harness's way or the fabricator's rule:** set the stackup and the design rules
before anything is routed (#170: `board.stackup()` first); every signal layer of a six-layer or larger board next
to a ground plane (#56, `stackup.reference`); thermal vias no larger than a 0.3 mm drill, spread over the pad and
landing on a plane (#93, `thermal.pad`); the linear regulator's loss checked (#93, `regulator.heat`); the RF
matching parts in line with the feed, no stubs (#90, #139, `rf.feed`); pours with 45 degree corners and no
overlapping pieces of one net (#85); silkscreen 0.3 mm or more from the board edge and off holes (#133).

**Where the owner's rules differ, the owner's rules hold:**

| Subject | Phil's Lab | This project |
|---|---|---|
| Default via | 0.7 mm pad, 0.3 mm drill, an annular ring of 0.15 mm or more (#70, #40) | 0.5 mm pad, 0.2 mm drill: small like the owner's earlier 0.4 on 0.25, but with the 0.15 mm ring (changed 2026-11-15); the fabricator's larger minimum wins where it cannot drill 0.2 |
| A ground via beside a pad | kept a little away from the pad so solder is not drawn off (#76, #57) | vias are tented and sit close; no via in a small part's pad (`dfm.via_in_pad`) |
| Fan-out of a fine-pitch part | spread out, room between vias | tight and orderly, grouped (and `vias.slot` asks only for the plane sliver between them) |
| Decoupling on the back under the chip | common | all parts on the top side unless two sides cannot be avoided |
| Silkscreen text | 1 mm or more | 0.5 mm references allowed on dense boards |

Board corners are always rounded, as Phil's Lab does (owner, 2026-11-15; before that only on product boards): `board.outline()` draws a 1 mm radius and `design()` rounds the outline after placement.

**Left to the router** (not automatic yet): preferring three track widths of spacing wherever there is room;
breaking parallel tracks apart right after a pad row; a ground via placed beside each supply via; never cutting a
back-side jump under a pair or a clock when a DC net could be crossed instead; teardrops; pour clearance of three
dielectric heights beside impedance-controlled tracks.

## The Art of Electronics (Horowitz and Hill, 3rd edition)

Read 2026-11-16 from the owner's copy: section 8.16 (interference, shielding and grounding), 12.9 (on-board
interconnections), and the grounding, bypassing and converter passages it points to. Most of its board advice was
already here (a ground plane, a small ceramic at every supply pin, short loops, high-impedance nodes kept short and
over ground, differential signalling between boards). New from it:

| Rule | Where |
|---|---|
| Several ceramic bypass capacitors and the supply wiring between them ring at 5 to 20 MHz; one electrolytic, tantalum or polymer capacitor (about 10 uF) on the rail damps that with its ESR (12.9.1A, note 54) | `bypass.damping` (schematic review, note) |
| A converter's AGND and DGND pins keep digital return current out of the analog side inside the chip; both go to one ground at the chip (chapter 13) | `converter.grounds` (schematic review, warning) |
| Return currents of a high-current stage must not flow through the ground a low-level input refers to; tie low-level stages to the supply at the regulator's sense point (8.16.2A, figure 8.124) | manual: `power.return` notes it on the board |
| A low-level stage may take its supply through a small RC (10 ohm, 10 uF) from the main rail (figure 8.125) | manual |
| Fast clocks between boards go through a buffer or differential receiver on each board; edges of a nanosecond or less run as terminated microstrip or stripline (12.9.2) | manual, and `pairs`/impedance in the router |

## What is not automatic yet

- Blind, buried and micro vias (HDI) and back-drilling.
- Rigid-flex stackups with different layer counts per region.
- Creepage along slots and around the board edge; the check is straight-line clearance.
- Simulation: no field solver, no eye diagrams, no PDN impedance plot. The sums are closed-form estimates.
- The checks have run on test boards built for them, not yet on the ESP32-C3 board that started this work.
