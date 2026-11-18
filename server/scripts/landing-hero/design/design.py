# STM32F042F6P6 USB-C devboard (V1): TSSOP-20 Cortex-M0 with crystal-less USB, USB-C with ESD protection,
# TI TLV75733 3.3 V LDO, reset and boot buttons, two LEDs, breadboard edge pins with SWD.
R0402, C0402, C0603 = "Resistor_SMD:R_0402_1005Metric", "Capacitor_SMD:C_0402_1005Metric", "Capacitor_SMD:C_0603_1608Metric"
HDR = "Connector_PinHeader_2.54mm:PinHeader_1x10_P2.54mm_Vertical"
BTN = "Button_Switch_SMD:SW_Push_SPST_NO_Alps_SKRK"
LED = "LED_SMD:LED_0402_1005Metric"
P = {
    "J1": {"lib": "Connector:USB_C_Receptacle_USB2.0_16P", "value": "USB-C", "footprint": "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal"},
    "U2": {"lib": "Power_Protection:TPD2E2U06DCK", "value": "TPD2E2U06DCK", "footprint": "Package_TO_SOT_SMD:SOT-323_SC-70"},
    "U3": {"lib": "Regulator_Linear:TLV75733PDBV", "value": "TLV75733PDBV", "footprint": "Package_TO_SOT_SMD:SOT-23-5"},
    "U1": {"lib": "MCU_ST_STM32F0:STM32F042F6Px", "value": "STM32F042F6P6", "footprint": "Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm"},
    "SW1": {"lib": "Switch:SW_Push", "value": "RESET", "footprint": BTN},
    "SW2": {"lib": "Switch:SW_Push", "value": "BOOT", "footprint": BTN},
    "D1": {"lib": "Device:LED", "value": "PWR", "footprint": LED},
    "D2": {"lib": "Device:LED", "value": "USER", "footprint": LED},
    "J2": {"lib": "Connector_Generic:Conn_01x10", "value": "Pins 1-10", "footprint": HDR},
    "J3": {"lib": "Connector_Generic:Conn_01x10", "value": "Pins 11-20", "footprint": HDR},
}
def many(lib, fp, table):
    for value, refs in table.items():
        for ref in refs.split():
            P[ref] = {"lib": lib, "value": value, "footprint": fp}
many("Device:C", C0402, {"1uF": "C1 C2 C6", "100nF": "C3 C5 C7"})
many("Device:C", C0603, {"4.7uF": "C4"})
many("Device:R", R0402, {"5.1k": "R1 R2", "10k": "R3", "1k": "R4 R5"})
YAGEO = {"5.1k": "5K1", "10k": "10K", "1k": "1K"}
CAPS = {("1uF", C0402): ("CL05A105KA5NQNC", "25V"), ("100nF", C0402): ("CL05B104KO5NNNC", "16V"), ("4.7uF", C0603): ("CL10A475KO8NNNC", "16V")}
BUY = {"J1": ("GCT", "USB4105-GF-A"), "U2": ("Texas Instruments", "TPD2E2U06DCKR"), "U3": ("Texas Instruments", "TLV75733PDBVR"),
       "U1": ("STMicroelectronics", "STM32F042F6P6"), "SW1": ("Alps Alpine", "SKRKAEE020"), "SW2": ("Alps Alpine", "SKRKAEE020"),
       "D1": ("Lite-On", "LTST-C281KGKT"), "D2": ("Lite-On", "LTST-C281KGKT"), "J2": ("Wurth Elektronik", "61301011121"), "J3": ("Wurth Elektronik", "61301011121")}
for ref, p in P.items():
    if ref in BUY:
        p["fields"] = {"MFR": BUY[ref][0], "MPN": BUY[ref][1]}
    elif p["lib"] == "Device:R":
        p["fields"] = {"MFR": "Yageo", "MPN": "RC0402FR-07%sL" % YAGEO[p["value"]]}
    elif p["lib"] == "Device:C":
        mpn, volts = CAPS[(p["value"], p["footprint"])]
        p["fields"] = {"MFR": "Samsung Electro-Mechanics", "MPN": mpn, "Voltage": volts}
SUPPLIES = {"+3V3": {"volts": (3.2, 3.3, 3.4), "amps": (None, 0.05, 1.0)}}
N = {
    "VBUS": "J1.A4 J1.A9 J1.B4 J1.B9 U3.1 U3.3 C1.1 J3.1",
    "+3V3": "U3.5 C2.1 U1.16 U1.5 C3.1 C4.1 C5.1 C6.1 R4.1 SW2.1 J2.2 J3.10",
    "GND": "J1.A1 J1.A12 J1.B1 J1.B12 J1.SH R1.2 R2.2 U2.3 U3.2 C1.2 C2.2 U1.15 C3.2 C4.2 C5.2 C6.2 C7.2 SW1.2 R3.2 D1.1 D2.1 J2.1 J3.2",
    "CC1": "J1.A5 R1.1", "CC2": "J1.B5 R2.1",
    "USB_D+": "J1.A6 J1.B6 U2.1 U1.18", "USB_D-": "J1.A7 J1.B7 U2.2 U1.17",
    "NRST": "U1.4 C7.1 SW1.1 J3.8",
    "BOOT0": "U1.1 R3.1 SW2.2 J3.5",
    "PWR_LED": "R4.2 D1.2",
    "PB1_LED": "U1.14 R5.1 J2.3", "USER_LED": "R5.2 D2.2",
    "PA7": "U1.13 J2.4", "PA6": "U1.12 J2.5", "PA5": "U1.11 J2.6", "PA4": "U1.10 J2.7", "PA3": "U1.9 J2.8", "PA2": "U1.8 J2.9", "PA1": "U1.7 J2.10",
    "SWDIO": "U1.19 J3.3", "SWCLK": "U1.20 J3.4", "PF0": "U1.2 J3.6", "PF1": "U1.3 J3.7", "PA0": "U1.6 J3.9",
}
G = {
    "USB-C input": "J1 R1 R2 U2",
    "3.3 V regulator (TI TLV75733)": "U3 C1 C2 D1 R4",
    "STM32F042F6P6 (USB without a crystal)": "U1 C3 C4 C5 C6",
    "Reset and boot buttons": "SW1 C7 SW2 R3",
    "User LED": "R5 D2",
    "Breadboard edge pins": "J2 J3",
}
NOTES = {
    "USB-C input": ["In: 5 V from USB, 100 mA used at most."],
    "3.3 V regulator (TI TLV75733)": ["In: VBUS, 5.5 V max. Out: 3.3 V, 1 A max."],
}
NC = "J1.A8 J1.B8 U3.4".split()
LABELS = "USB_D+ USB_D- NRST BOOT0".split()
sch = project.schematic()
sch.clear()
built = sch.build(P, {k: v.split() for k, v in N.items()}, {k: v.split() for k, v in G.items()}, no_connect=NC, notes=NOTES, labels=LABELS, supplies=SUPPLIES)
left = sch.tidy()
sch.title("STM32F042 USB-C devboard (V1)", rev="V1")
if hasattr(sch, "fit_page"):
    print("page", sch.fit_page())
print("schematic", {k: built.get(k) for k in ("placed", "nets", "page", "overlaps", "problems", "unconnected", "pins_swapped")})
print("overlaps", sch.overlaps()[:12], "tidy", left)
print("erc", sch.check())
rv = sch.review()
print("review", rv["errors"], rv["warnings"], [f[:300] for f in rv["findings"]])
