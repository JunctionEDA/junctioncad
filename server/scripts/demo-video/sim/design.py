# The Pico's RUN pin at power-up, on its own sheet so the web simulator can run it: 3V3 ramps up in 1 ms,
# 10 kOhm pulls RUN up, 100 nF holds it low for a few milliseconds.
P = {
    "V1": {"lib": "Simulation_SPICE:VDC", "value": "PULSE", "fields": {"Sim.Device": "V", "Sim.Type": "PULSE", "Sim.Pins": "1=+ 2=-",
           "Sim.Params": "y1=0 y2=3.3 td=0 tr=1m tf=1m tw=1 per=2"}},
    "R1": {"lib": "Device:R", "value": "10k", "footprint": "Resistor_SMD:R_0402_1005Metric"},
    "C1": {"lib": "Device:C", "value": "100n", "footprint": "Capacitor_SMD:C_0402_1005Metric"},
}
N = {"3V3": "V1.1 R1.1", "RUN": "R1.2 C1.1", "GND": "V1.2 C1.2"}
sch = project.schematic()
sch.clear()
built = sch.build(P, {k: v.split() for k, v in N.items()}, {"RUN pin power-on": "V1 R1 C1".split()}, labels=["RUN", "3V3"])
print("built", {k: built.get(k) for k in ("placed", "nets", "problems", "unconnected")})
sch.text(".tran 10u 6m", at=(60, 120))
sch.title("RUN pin power-on", rev="V1")
if hasattr(sch, "fit_page"):
    print("page", sch.fit_page())
