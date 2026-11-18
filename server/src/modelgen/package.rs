//! What kind of package a footprint is, and its numbers: body size, seated height, standoff, leads.
//! Found without any AI, in this order: a datasheet's dimension table (when one was read and agrees with
//! the pads), the numbers in the footprint's name (KiCad's and EasyEDA's naming conventions both carry
//! them), the fabrication outline, the courtyard, and last the pads with typical JEDEC heights.

use serde::{Deserialize, Serialize};

use super::footprint::{Footprint, Pad, Rect};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Family {
    /// two-terminal chip parts: resistors, capacitors, inductors, ferrites, fuses, chip LEDs and diodes
    Chip,
    /// moulded two-terminal parts with bent leads: SOD-123/323/523, SMA/SMB/SMC, tantalum, PowerDI
    Molded2,
    /// MELF and MiniMELF: a cylinder lying on its end caps
    Melf,
    /// leads out of the body's sides, bent down: SOIC, SSOP, TSSOP, MSOP, QFP, SOT-23, SC-70, SOT-223, DPAK
    GullWing,
    /// terminals in the body's underside: QFN, DFN, SON, LGA, LCC
    NoLead,
    /// solder balls: BGA, WLCSP
    Bga,
    /// a ceramic base and a metal lid: SMD crystals and oscillators
    Crystal,
    /// an aluminium electrolytic can on a plastic base
    ElectrolyticSmd,
    /// an LED in a plastic package with a lens: PLCC-2/4, 2835, 5050, WS2812
    LedPackage,
    /// SMD power inductors
    Inductor,
    /// tactile and slide switches
    Switch,
    /// USB Type-C receptacles
    UsbC,
    /// through-hole: DIP
    Dip,
    /// pin headers and sockets
    Header,
    /// axial parts lying along their leads
    Axial,
    /// radial cans and LEDs standing on their leads
    Radial,
    /// TO-220 / TO-247 transistors and regulators
    To220,
    /// TO-92
    To92,
    /// anything else: a box over the body outline with its pads or leads
    Generic,
}

/// Where a number came from, for the report.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum From { Datasheet, Name, Fab, Courtyard, Pads, Typical }

/// Package dimensions as a datasheet gives them (JEDEC letters), millimetres.  Orientation-free: D runs
/// along a row of pins, E1 across the body, E from lead tip to lead tip.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Dims {
    /// A: seated height (max)
    #[serde(default, skip_serializing_if = "Option::is_none")] pub a: Option<f64>,
    /// A1: standoff (nominal)
    #[serde(default, skip_serializing_if = "Option::is_none")] pub a1: Option<f64>,
    /// D: body length
    #[serde(default, skip_serializing_if = "Option::is_none")] pub d: Option<f64>,
    /// E1 (leaded) or E (leadless): body width
    #[serde(default, skip_serializing_if = "Option::is_none")] pub e1: Option<f64>,
    /// E: overall width over the leads (leaded packages)
    #[serde(default, skip_serializing_if = "Option::is_none")] pub e_span: Option<f64>,
    /// e: pitch
    #[serde(default, skip_serializing_if = "Option::is_none")] pub pitch: Option<f64>,
    /// b: lead width
    #[serde(default, skip_serializing_if = "Option::is_none")] pub b: Option<f64>,
    /// L: foot length
    #[serde(default, skip_serializing_if = "Option::is_none")] pub l: Option<f64>,
    /// D2 x E2: exposed pad
    #[serde(default, skip_serializing_if = "Option::is_none")] pub d2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub e2: Option<f64>,
}

impl Dims {
    pub fn is_empty(&self) -> bool { *self == Dims::default() }
}

/// Everything a model is drawn from.
#[derive(Clone, Debug, Serialize)]
pub struct Spec {
    pub family: Family,
    /// the moulded body (model frame)
    pub body: Rect,
    /// underside of the body above the board
    pub z0: f64,
    /// top of the body above the board (seated height)
    pub height: f64,
    /// lead width and foot length for leaded packages
    pub lead_w: Option<f64>,
    pub foot: Option<f64>,
    /// the kind of chip part: R, C, L, D, LED, F, FB
    pub kind: String,
    /// pins run along X (rows of fixed y) for two-row packages; None for quads and two terminals
    pub sources: Vec<(String, From)>,
    pub notes: Vec<String>,
}

const fn clampf(v: f64, lo: f64, hi: f64) -> f64 { if v < lo { lo } else if v > hi { hi } else { v } }

/// `key<number>mm` in a KiCad name (`_L6.3mm`, `_D8.0mm`, `_P2.54mm`).
fn mm_after(name: &str, key: &str) -> Option<f64> {
    let b = name.as_bytes();
    let mut i = 0;
    while let Some(p) = name[i..].find(key) {
        let at = i + p;
        let before_ok = at == 0 || matches!(b[at - 1], b'_' | b'-');
        let s = at + key.len();
        let digits: String = name[s..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        if before_ok && !digits.is_empty() && name[s + digits.len()..].starts_with("mm") { return digits.parse().ok(); }
        i = at + key.len();
        if i >= name.len() { break; }
    }
    None
}

/// EasyEDA's `_L2.9-W1.3-P1.90-LS2.4` / `-H1.0` fields.
fn easyeda_field(name: &str, key: &str) -> Option<f64> {
    for part in name.split(|c| c == '_' || c == '-') {
        if let Some(rest) = part.strip_prefix(key) {
            if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '.') && rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) { return rest.parse().ok(); }
        }
    }
    None
}

/// A through-hole crystal can: lying (Horizontal: its thickness), else standing (HC52-6mm, HC49-4H: the
/// height in the name; HC-49/U and HC-18/U cans are about 13.5 mm tall).
fn crystal_tht_height(name: &str, body: &Rect) -> f64 {
    let up = name.to_ascii_uppercase();
    if up.contains("HORIZONTAL") {
        if let Some(d) = mm_after(name, "D") { return d + 0.1; }
        return if up.contains("HC52") { 3.4 } else if up.contains("HC18") { 4.75 } else if up.contains("HC49") { 4.65 } else { body.w().min(body.h()) };
    }
    for part in name.split('_') {
        if let Some((_, h)) = part.split_once('-') {
            if let Some(v) = h.strip_suffix("mm").and_then(|v| v.parse::<f64>().ok()) { return v + 0.1; }
            if let Some(v) = h.strip_suffix('H').and_then(|v| v.parse::<f64>().ok()) { return v + 0.1; }
        }
    }
    if up.contains("HC52") { 10.2 } else { 13.5 }
}

/// `Elec_6.3x5.4` -> (6.3, 5.4): an electrolytic's diameter and height.
fn elec_dh(name: &str) -> Option<(f64, f64)> {
    let i = name.find("Elec_")? + 5;
    let part = name[i..].split('_').next()?;
    let (d, h) = part.split_once('x')?;
    Some((d.parse().ok()?, h.trim_end_matches("mm").parse().ok()?))
}

/// A tantalum's EIA code `EIA-3216-18` -> 1.8 mm high.
fn eia_height(name: &str) -> Option<f64> {
    let i = name.find("EIA-")? + 4;
    let mut it = name[i..].split(|c| c == '-' || c == '_');
    let size = it.next()?;
    let h = it.next()?;
    if size.len() == 4 && size.chars().all(|c| c.is_ascii_digit()) && h.len() == 2 && h.chars().all(|c| c.is_ascii_digit()) { return Some(h.parse::<f64>().ok()? / 10.0); }
    None
}

/// Power inductor series codes carry size and height: XAL7030 (7.0 mm, 3.0 mm high), SRN6045, MSS1210
/// (12 mm, 10 mm), MAPI-3012, ASPI-0628.  The digits are read in tenths or whole millimetres, whichever
/// makes the size match the body; the height is the next two digits in the same unit.
fn series_height(name: &str, body: &Rect) -> Option<f64> {
    let long = body.w().max(body.h());
    let b = name.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_digit()) {
            let j = (i..b.len()).find(|&k| !b[k].is_ascii_digit()).unwrap_or(b.len());
            let run = &name[i..j];
            let tries: Vec<(&str, &str)> = match run.len() { 4 => vec![(&run[..2], &run[2..])], 6 => vec![(&run[..2], &run[4..]), (&run[2..4], &run[4..])], 8 => vec![(&run[2..4], &run[6..]), (&run[4..6], &run[6..])], _ => vec![] };
            for (sz, h) in tries {
                let (sz, h): (f64, f64) = (sz.parse().unwrap_or(0.0), h.parse().unwrap_or(0.0));
                for unit in [0.1, 1.0] {
                    let (s, hh) = (sz * unit, h * unit);
                    if s > 0.0 && (s - long).abs() <= 0.25 * long && hh > 0.3 && hh <= s * 1.1 { return Some(hh); }
                }
            }
            i = j;
        } else { i += 1; }
    }
    None
}

/// `_<w>x<l>mm` or `_<w>x<l>x<h>mm` in a KiCad name.
fn wxl(name: &str) -> Option<(f64, f64, Option<f64>)> {
    for part in name.split('_') {
        let Some(p) = part.strip_suffix("mm") else { continue };
        let nums: Vec<&str> = p.split('x').collect();
        if nums.len() < 2 || nums.len() > 3 { continue; }
        let v: Vec<f64> = nums.iter().filter_map(|n| n.parse::<f64>().ok()).collect();
        if v.len() != nums.len() { continue; }
        return Some((v[0], v[1], v.get(2).copied()));
    }
    None
}

/// The metric chip code `_1608Metric` -> (1.6, 0.8).
fn chip_metric(name: &str) -> Option<(f64, f64)> {
    let i = name.find("Metric")?;
    let digits = &name[..i];
    let code: String = digits.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    if code.len() != 4 { return None; }
    let l: f64 = code[..2].parse().ok()?;
    let w: f64 = code[2..].parse().ok()?;
    Some((l / 10.0, w / 10.0))
}

/// The imperial chip code (0402, 0603 …) anywhere in a name, for footprints that use only that.
fn chip_imperial(name: &str) -> Option<(f64, f64)> {
    const CODES: [(&str, f64, f64); 11] = [("01005", 0.4, 0.2), ("0201", 0.6, 0.3), ("0402", 1.0, 0.5), ("0603", 1.6, 0.8), ("0805", 2.0, 1.25), ("1206", 3.2, 1.6), ("1210", 3.2, 2.5), ("1812", 4.5, 3.2), ("2010", 5.0, 2.5), ("2512", 6.4, 3.2), ("2220", 5.7, 5.0)];
    for (code, l, w) in CODES {
        if let Some(p) = name.find(code) {
            let b = name.as_bytes();
            let before = p == 0 || !b[p - 1].is_ascii_digit();
            let after = p + code.len() >= b.len() || !b[p + code.len()].is_ascii_digit();
            if before && after { return Some((l, w)); }
        }
    }
    None
}

fn has_word(name: &str, words: &[&str]) -> bool {
    let up = name.to_ascii_uppercase();
    words.iter().any(|w| {
        let w = w.to_ascii_uppercase();
        let mut from = 0;
        while let Some(p) = up[from..].find(&w) {
            let at = from + p;
            let b = up.as_bytes();
            let before = at == 0 || !b[at - 1].is_ascii_alphabetic();
            let end = at + w.len();
            let after = end >= b.len() || !b[end].is_ascii_alphabetic();
            if before && after { return true; }
            from = at + 1;
        }
        false
    })
}

/// The pads that carry a lead (copper, not a mechanical hole).
fn leads(fp: &Footprint) -> Vec<&Pad> { fp.copper_pads().collect() }

/// The most common spacing between neighbouring pads in a row, if the pads form rows.
pub fn pad_pitch(fp: &Footprint) -> Option<f64> {
    let pads = leads(fp);
    let mut gaps: Vec<f64> = Vec::new();
    for (i, a) in pads.iter().enumerate() {
        let mut best = f64::MAX;
        for (j, b) in pads.iter().enumerate() {
            if i == j { continue; }
            let (dx, dy) = ((a.x - b.x).abs(), (a.y - b.y).abs());
            // neighbours in a row share x or y
            let d = if dx < 0.01 { dy } else if dy < 0.01 { dx } else { continue };
            if d > 0.05 && d < best { best = d; }
        }
        if best < f64::MAX { gaps.push((best * 1000.0).round() / 1000.0); }
    }
    if gaps.is_empty() { return None; }
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // the mode
    let mut best = (gaps[0], 0usize);
    let mut i = 0;
    while i < gaps.len() {
        let mut j = i;
        while j < gaps.len() && (gaps[j] - gaps[i]).abs() < 0.011 { j += 1; }
        if j - i > best.1 { best = (gaps[i], j - i); }
        i = j;
    }
    Some(best.0)
}

pub fn classify(fp: &Footprint) -> Family {
    let n = fp.name.as_str();
    let lib = fp.id.split(':').next().unwrap_or("");
    let pads = leads(fp);
    let smd = fp.smd && !fp.tht;
    let drilled = pads.iter().filter(|p| p.drill.is_some()).count();
    let prefix = fp.reference_prefix();
    if has_word(n, &["USB_C", "USB-C", "TYPE-C", "TYPEC", "USB4105", "USB4085", "USB4110", "USB4125"]) || (n.to_ascii_uppercase().contains("USB") && n.to_ascii_uppercase().contains("TYPE")) {
        if !n.contains("Vertical") && !n.contains("Plug") && fp.fab_box().or(fp.courtyard_box()).is_some() { return Family::UsbC; }
    }
    if !smd || drilled * 2 > pads.len() {
        if has_word(n, &["DIP", "PDIP", "CERDIP"]) || n.starts_with("DIP-") { return Family::Dip; }
        if has_word(n, &["PinHeader", "PinSocket", "Pin_Header", "Socket_Strip"]) || n.starts_with("PinHeader") || n.starts_with("PinSocket") { return Family::Header; }
        if n.contains("Axial") || has_word(n, &["DO-35", "DO-34", "DO-41", "DO-15", "DO-201", "DO-201AD", "DO-27"]) { return Family::Axial; }
        if n.contains("Radial") || n.starts_with("CP_Radial") || n.starts_with("LED_D") || n.contains("_THT_") && n.starts_with("CP_") { return Family::Radial; }
        if has_word(n, &["TO-220", "TO-247", "TO-3P", "TO-218"]) || n.starts_with("TO-220") || n.starts_with("TO-247") { return Family::To220; }
        if n.starts_with("TO-92") || has_word(n, &["TO-92"]) { return Family::To92; }
        return Family::Generic;
    }
    let up = n.to_ascii_uppercase();
    if up.contains("TO-220") || up.contains("TO-247") || up.contains("TO-263") || up.contains("D2PAK") { return Family::GullWing; }
    if up.contains("LFCSP") || up.contains("MLPQ") || up.contains("MLPD") { return Family::NoLead; }
    if up.starts_with("SMDIP") || up.contains("DIP") && up.contains("SMD") { return Family::Dip; }
    if up.starts_with("PINHEADER") || up.starts_with("PINSOCKET") { return Family::Header; }
    if up.contains("MELF") || up.contains("SOD-80") || up.contains("SOD80") { return Family::Melf; }
    let chip_name = (n.contains("Metric") && chip_metric(n).is_some())
        || (pads.len() == 2 && ["R", "C", "L", "D", "LED", "F", "FB", "RES", "CAP", "IND"].iter().any(|k| up.strip_prefix(k).and_then(|r| r.strip_prefix('_').or_else(|| r.strip_prefix('-'))).map(|r| chip_imperial(&r[..r.len().min(5)]).is_some()).unwrap_or(false)));
    if chip_name && pads.len() == 2 && !up.starts_with("CP_ELEC") && !up.contains("EIA") { return Family::Chip; }
    if up.starts_with("CP_ELEC") || up.starts_with("C_ELEC") || up.contains("ELEC_") || lib.contains("Capacitor_SMD") && up.contains("ELEC") { return Family::ElectrolyticSmd; }
    if up.starts_with("CRYSTAL") || up.starts_with("OSCILLATOR") || up.contains("_XTAL") || up.starts_with("XTAL") || has_word(n, &["OSC", "TCXO", "VCTCXO", "OSC-SMD", "CRYSTAL-SMD"]) || prefix == "Y" || lib.starts_with("Crystal") || lib.starts_with("Oscillator") { return Family::Crystal; }
    if has_word(n, &["BGA", "WLCSP", "CSP", "UFBGA", "LFBGA", "TFBGA", "FBGA", "VFBGA", "DSBGA", "WLP"]) || up.starts_with("BGA") { return Family::Bga; }
    if has_word(n, &["QFN", "DFN", "SON", "VQFN", "WQFN", "UQFN", "TQFN", "UFQFPN", "VFQFPN", "WSON", "VSON", "USON", "XSON", "TDFN", "UDFN", "WDFN", "LGA", "LCC", "MLF", "MLP", "QFN-", "HVQFN", "PQFN", "X2SON", "X1SON", "VDFN", "UFDFN"]) || up.contains("QFN") || up.contains("DFN") || up.contains("SON-") || up.starts_with("SON") || up.contains("LGA") || up.contains("PowerPAK".to_ascii_uppercase().as_str()) && !up.contains("SO-8") { return Family::NoLead; }
    if has_word(n, &["SOIC", "SO", "SOP", "SSOP", "TSSOP", "MSOP", "VSSOP", "HTSSOP", "QSOP", "TSOP", "HSOP", "LQFP", "TQFP", "PQFP", "QFP", "VQFP", "HTQFP", "SOT", "SC-70", "SC70", "SC-74", "SC-88", "TSOT", "SOT-23", "SOT-223", "SOT-89", "SOT-323", "SOT-363", "SOT-563", "SOT-353", "TO-252", "TO-263", "TO-268", "DPAK", "D2PAK", "SC-59", "SC-82", "SC-88A", "SOIC-8", "SO-8", "PLCC", "SOJ", "HSOP", "ESOP", "MSOP-10", "eSOP"]) || up.starts_with("SOT") || up.starts_with("TSOT") || up.starts_with("SOIC") || up.contains("SSOP") || up.contains("TSSOP") || up.contains("MSOP") || up.contains("QFP") || up.starts_with("TO-252") || up.starts_with("TO-263") || up.starts_with("SC-") {
        if up.starts_with("SOD") || has_word(n, &["SOD"]) { return Family::Molded2; }
        // a PLCC LED is an LED package, not an IC
        if up.starts_with("LED") { return Family::LedPackage; }
        return Family::GullWing;
    }
    if has_word(n, &["SOD", "SMA", "SMB", "SMC", "SMAJ", "SMBJ", "SMCJ", "SMF", "SOD-123", "SOD-323", "SOD-523", "SOD-923", "SOD-123F", "SOD-123FL", "PowerDI", "DO-214AA", "DO-214AB", "DO-214AC", "DO-219AB", "SMP", "MiniSMA"]) || up.starts_with("SOD") || up.contains("DO-214") || up.contains("EIA-") && pads.len() == 2 { return Family::Molded2; }
    if up.starts_with("LED") || prefix == "LED" || (prefix == "D" && up.contains("LED")) || up.contains("WS2812") || up.contains("SK6812") || up.contains("PLCC") || up.contains("2835") && up.contains("LED") || up.contains("5050") && up.contains("LED") { return Family::LedPackage; }
    if (up.starts_with("L_") || prefix == "L" || prefix == "FB" || up.starts_with("IND")) && pads.len() <= 4 { return Family::Inductor; }
    if up.starts_with("SW_") || up.starts_with("SW-") || prefix == "SW" || up.contains("BUTTON") || up.contains("TACT") || up.contains("SWITCH") { return Family::Switch; }
    if pads.len() == 2 && chip_imperial(n).is_some() && !up.starts_with("L_") { return Family::Chip; }
    Family::Generic
}

/// Typical seated height (JEDEC maxima, rounded down a little to look like a real part).
fn typical_height(family: Family, fp: &Footprint, body: &Rect, kind: &str) -> f64 {
    let up = fp.name.to_ascii_uppercase();
    let area = body.w() * body.h();
    let short = body.w().min(body.h());
    match family {
        Family::Chip => {
            let (l, w) = (body.w().max(body.h()), short);
            match kind {
                "R" | "FB" | "F" => if l < 0.5 { 0.13 } else if l < 0.8 { 0.23 } else if l < 1.2 { 0.35 } else if l < 1.8 { 0.45 } else if l < 2.2 { 0.5 } else { 0.55 },
                "C" => if l < 0.5 { 0.2 } else if l < 0.8 { 0.3 } else if l < 1.2 { 0.5 } else if l < 1.8 { 0.8 } else if l < 2.2 { 1.25 } else { clampf(0.85 * w, 1.1, 2.5) },
                "L" => if l < 0.8 { 0.3 } else if l < 1.2 { 0.5 } else if l < 1.8 { 0.8 } else if l < 2.2 { 1.0 } else { clampf(0.7 * w, 0.9, 2.5) },
                "LED" => if l < 1.2 { 0.4 } else if l < 1.8 { 0.6 } else if l < 2.2 { 0.75 } else { 1.1 },
                _ => clampf(0.5 * w, 0.3, 1.2),
            }
        }
        Family::Molded2 => {
            if up.contains("SOD-923") || up.contains("SOD923") { 0.37 } else if up.contains("SOD-523") || up.contains("SOD523") { 0.65 } else if up.contains("SOD-323") || up.contains("SOD323") { 1.0 }
            else if up.contains("SOD-123F") { 0.98 } else if up.contains("SOD-123") || up.contains("SOD123") { 1.17 } else if up.contains("SMC") || up.contains("DO-214AB") { 2.3 } else if up.contains("SMB") || up.contains("DO-214AA") { 2.2 }
            else if up.contains("SMA") || up.contains("DO-214AC") { 2.1 } else if up.contains("SMF") || up.contains("DO-219") { 0.98 } else if up.contains("POWERDI") { 1.0 }
            else if up.contains("SOD-110") { 1.8 } else { clampf(0.55 * short, 0.6, 2.8) }
        }
        Family::Melf => clampf(short, 1.0, 2.6),
        Family::GullWing => {
            if up.contains("TO-220") || up.contains("TO-263") || up.contains("D2PAK") || up.contains("TO-247") { 4.4 } else if up.contains("SOT-223") { 1.7 } else if up.contains("SOT-89") { 1.5 } else if up.contains("TO-252") || up.contains("DPAK") && !up.contains("D2PAK") { 2.3 } else if up.contains("TO-263") || up.contains("D2PAK") { 4.4 }
            else if up.contains("SC-70") || up.contains("SC70") || up.contains("SOT-323") || up.contains("SOT-363") || up.contains("SOT-353") || up.contains("SC-88") { 1.0 } else if ["SOT-563", "SOT-666", "SOT-543", "SOT-553", "SOT-583", "SOT-383", "SOT-963", "SOT-883", "SOT-1123"].iter().any(|k| up.contains(k)) { if up.contains("SOT-963") || up.contains("SOT-883") || up.contains("SOT-1123") { 0.45 } else { 0.6 } }
            else if up.contains("TSOT") { 1.0 } else if up.starts_with("SOT") || up.contains("SC-59") || up.contains("SC-74") { 1.12 }
            else if up.contains("LQFP") { 1.6 } else if up.contains("TQFP") || up.contains("VQFP") || up.contains("HTQFP") { 1.2 } else if up.contains("PQFP") || up.contains("MQFP") { if short < 15.0 { 2.15 } else { 3.4 } } else if up.contains("QFP") { 1.6 }
            else if up.contains("TSSOP") || up.contains("HTSSOP") { 1.1 } else if up.contains("VSSOP") || up.contains("MSOP") || up.contains("TSOP") && !up.contains("TSOP-I") { 1.1 }
            else if up.contains("QSOP") { 1.75 } else if up.contains("SSOP") { if short > 7.0 { 2.8 } else if short > 5.0 { 2.0 } else { 1.75 } } else if up.contains("PLCC") { 3.6 } else if up.contains("SOJ") { 3.5 }
            else if up.contains("SOIC") || up.contains("SO-") || up.contains("SOP") || up.contains("SO_") { if short > 6.0 { 2.65 } else { 1.75 } }
            else { clampf(0.25 * short, 1.0, 2.6) }
        }
        Family::NoLead => {
            if up.contains("X2SON") || up.contains("X1SON") || up.contains("X2QFN") { 0.4 } else if up.contains("UQFN") || up.contains("UDFN") || up.contains("USON") || up.contains("UFQFPN") && short < 4.0 { 0.55 }
            else if up.contains("WQFN") || up.contains("WDFN") || up.contains("WSON") { 0.8 } else if up.contains("LGA") { if area > 9.0 { 1.0 } else { 0.9 } }
            else if up.contains("VQFN") || up.contains("VSON") || up.contains("VDFN") { 0.9 } else if up.contains("LCC") && !up.contains("LFCSP") { 1.5 } else { 0.9 }
        }
        Family::Bga => if up.contains("UFBGA") || up.contains("XFBGA") { 0.6 } else if up.contains("WFBGA") { 0.8 } else if up.contains("VFBGA") { 1.0 } else if up.contains("TFBGA") { 1.2 } else if up.contains("LFBGA") { 1.5 } else if up.contains("WLCSP") || up.contains("CSP") || up.contains("WLP") || up.contains("DSBGA") { 0.6 } else if area < 25.0 { 1.0 } else if area < 150.0 { 1.2 } else { 2.0 },
        Family::Crystal => {
            let l = body.w().max(body.h());
            let osc = up.starts_with("OSC") || fp.id.starts_with("Oscillator");
            if up.contains("HC49") || up.contains("HC-49") { 4.2 } else if osc && l > 6.0 { 1.8 } else if osc && l > 4.5 { 1.4 } else if l <= 1.7 { 0.35 } else if l <= 2.1 { 0.45 } else if l <= 2.6 { 0.55 } else if l <= 3.3 { 0.75 } else if l <= 4.2 { 0.8 } else if l <= 5.2 { 1.1 } else { 1.4 }
        }
        Family::ElectrolyticSmd => clampf(short, 3.0, 12.0),
        Family::LedPackage => if area >= 20.0 { 1.6 } else if area >= 6.0 { 0.8 } else { 0.6 },
        Family::Inductor => clampf(0.55 * short, 0.8, 8.0),
        Family::Switch => if up.starts_with("SW_DIP") { 2.6 } else if area < 12.0 { 1.5 } else { 3.5 },
        Family::UsbC => 3.16,
        Family::Dip => 3.3,
        Family::Header => {
            // plastic height of a straight header; the pins are drawn above it (build.rs)
            2.5
        }
        Family::Axial | Family::Radial | Family::To220 | Family::To92 => 5.0,
        Family::Generic => {
            let up = fp.name.to_ascii_uppercase();
            if up.starts_with("CONN") || up.contains("JST") || up.contains("MOLEX") { clampf(0.6 * short, 3.0, 9.0) }
            else if up.starts_with("C_RECT") { let l = body.w().max(body.h()); if l > 15.0 { 1.06 * l } else if l >= 10.0 { 10.0 } else { 9.0 } }
            else if up.contains("BRIDGE") { clampf(0.35 * short, 2.0, 15.0) }
            else if fp.tht && !fp.smd { clampf(0.5 * short, 2.0, 10.0) }
            else if up.starts_with("R_") { chip_imperial(&up).map(|(l, _)| if l < 1.2 { 0.35 } else if l < 1.8 { 0.45 } else { 0.55 }).unwrap_or_else(|| clampf(0.3 * short, 0.3, 1.0)) }
            else { clampf(0.35 * short, 0.15, 3.0) }
        }
    }
}

fn chip_kind(fp: &Footprint) -> String {
    let up = fp.name.to_ascii_uppercase();
    let p = fp.reference_prefix();
    for k in ["LED", "FB", "R", "C", "L", "D", "F"] { if up.starts_with(&format!("{k}_")) { return k.to_string(); } }
    if up.starts_with("RES") { return "R".into(); }
    if up.starts_with("CAP") { return "C".into(); }
    if up.starts_with("IND") { return "L".into(); }
    if !p.is_empty() { return match p.as_str() { "R" | "RN" => "R", "C" => "C", "L" => "L", "FB" => "FB", "D" => "D", "LED" => "LED", "F" => "F", _ => "R" }.to_string(); }
    "R".into()
}

/// The body for a package with leads out of it: inside the pads (the leads reach out to them).
fn body_inside_pads(fp: &Footprint) -> Option<Rect> {
    let pads = leads(fp);
    if pads.is_empty() { return None; }
    let pb = fp.pad_box()?;
    // pads on the left and right edges (two rows of fixed x) or top and bottom
    let near = |v: f64, edge: f64| (v - edge).abs() < 0.3;
    let left = pads.iter().filter(|p| near(p.x - p.w / 2.0, pb.x0)).count();
    let right = pads.iter().filter(|p| near(p.x + p.w / 2.0, pb.x1)).count();
    let bottom = pads.iter().filter(|p| near(p.y - p.h / 2.0, pb.y0)).count();
    let top = pads.iter().filter(|p| near(p.y + p.h / 2.0, pb.y1)).count();
    let inner_x0 = pads.iter().filter(|p| near(p.x - p.w / 2.0, pb.x0)).map(|p| p.x + p.w / 2.0).fold(f64::MIN, f64::max);
    let inner_x1 = pads.iter().filter(|p| near(p.x + p.w / 2.0, pb.x1)).map(|p| p.x - p.w / 2.0).fold(f64::MAX, f64::min);
    let inner_y0 = pads.iter().filter(|p| near(p.y - p.h / 2.0, pb.y0)).map(|p| p.y + p.h / 2.0).fold(f64::MIN, f64::max);
    let inner_y1 = pads.iter().filter(|p| near(p.y + p.h / 2.0, pb.y1)).map(|p| p.y - p.h / 2.0).fold(f64::MAX, f64::min);
    let side_rows = left >= 1 && right >= 1 && (left + right) as f64 >= 0.6 * pads.len() as f64;
    let quad = left >= 2 && right >= 2 && top >= 2 && bottom >= 2;
    if quad {
        return Some(Rect { x0: inner_x0 + 0.15, x1: inner_x1 - 0.15, y0: inner_y0 + 0.15, y1: inner_y1 - 0.15 }).filter(|r| r.w() > 0.3 && r.h() > 0.3);
    }
    if side_rows {
        return Some(Rect { x0: inner_x0 + 0.1, x1: inner_x1 - 0.1, y0: pb.y0 - 0.2, y1: pb.y1 + 0.2 }).filter(|r| r.w() > 0.3);
    }
    let tb_rows = top >= 1 && bottom >= 1 && (top + bottom) as f64 >= 0.6 * pads.len() as f64;
    if tb_rows {
        return Some(Rect { y0: inner_y0 + 0.1, y1: inner_y1 - 0.1, x0: pb.x0 - 0.2, x1: pb.x1 + 0.2 }).filter(|r| r.h() > 0.3);
    }
    None
}

/// Do the pads of this footprint run in two rows of fixed x (leads out of the left and right sides)?
pub fn rows_along_y(fp: &Footprint, body: &Rect) -> Option<bool> {
    let pads = leads(fp);
    let lr = pads.iter().filter(|p| p.x < body.x0 - 0.05 || p.x > body.x1 + 0.05).count();
    let tb = pads.iter().filter(|p| p.y < body.y0 - 0.05 || p.y > body.y1 + 0.05).count();
    if lr > 0 && tb == 0 { Some(true) } else if tb > 0 && lr == 0 { Some(false) } else { None }
}

/// The package's spec from the footprint alone.
pub fn spec_of(fp: &Footprint) -> Option<Spec> {
    let pads = leads(fp);
    if pads.is_empty() { return None; }
    let family = classify(fp);
    let n = fp.name.as_str();
    let mut sources: Vec<(String, From)> = Vec::new();
    let pb = fp.pad_box()?;
    let fab = fp.fab_box();
    let crt = fp.courtyard_box();
    let mut kind = String::new();
    let named = wxl(n);
    let mut name_h: Option<f64> = named.and_then(|(_, _, h)| h).or_else(|| easyeda_field(n, "H")).or_else(|| mm_after(n, "H"));

    // ---- the body outline
    let body: Rect = match family {
        Family::Chip => {
            kind = chip_kind(fp);
            let (l, w) = chip_metric(n).or_else(|| chip_imperial(n)).or_else(|| fab.map(|f| (f.w().max(f.h()), f.w().min(f.h())))).unwrap_or((pb.w().max(pb.h()) * 0.6, pb.w().min(pb.h())));
            sources.push(("body".into(), if chip_metric(n).or_else(|| chip_imperial(n)).is_some() { From::Name } else { From::Fab }));
            let (a, b) = (pads[0], pads[1]);
            let along_x = (b.x - a.x).abs() >= (b.y - a.y).abs();
            let (cx, cy) = ((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
            if along_x { Rect::centred(cx, cy, l, w) } else { Rect::centred(cx, cy, w, l) }
        }
        Family::Header | Family::Dip | Family::To92 | Family::To220 | Family::Axial | Family::Radial => fab.or(crt.map(|c| c.grow(-0.25))).unwrap_or(pb),
        _ => {
            // the name's W x L when it gives one (KiCad: the body, W across the rows), else the fab outline
            let from_name = named.filter(|(w, l, _)| *w > 0.2 && *l > 0.2 && family != Family::Generic).map(|(w, l, _)| {
                // KiCad writes W x L, W across the pin rows and L along them
                let probe = Rect::centred(pb.cx(), pb.cy(), w.min(l), w.min(l));
                let (bx, by) = match (family, rows_along_y(fp, &probe)) {
                    (Family::GullWing, Some(true)) => (w, l),
                    (Family::GullWing, Some(false)) => (l, w),
                    _ => if (pb.w() >= pb.h()) == (w >= l) { (w, l) } else { (l, w) },
                };
                Rect::centred(pb.cx(), pb.cy(), bx, by)
            });
            let ee = easyeda_field(n, "L").zip(easyeda_field(n, "W")).map(|(l, w)| {
                // EasyEDA's L is the body's length (along the pin rows), W its width
                let probe = Rect::centred(pb.cx(), pb.cy(), w.min(l), w.min(l));
                let (bx, by) = match rows_along_y(fp, &probe) {
                    Some(true) => (w.min(l), l.max(w)),
                    Some(false) => (l.max(w), w.min(l)),
                    None => if pb.w() >= pb.h() { (l.max(w), l.min(w)) } else { (l.min(w), l.max(w)) },
                };
                Rect::centred(pb.cx(), pb.cy(), bx, by)
            });
            if let Some(b) = ee { sources.push(("body".into(), From::Name)); b }
            else if let Some(b) = from_name { sources.push(("body".into(), From::Name)); b }
            else if let Some(f) = fab { sources.push(("body".into(), From::Fab)); f }
            else if let Some(b) = body_inside_pads(fp).filter(|_| matches!(family, Family::GullWing | Family::Molded2)) { sources.push(("body".into(), From::Pads)); b }
            else if let Some(c) = crt { sources.push(("body".into(), From::Courtyard)); c.grow(-0.25) }
            else { sources.push(("body".into(), From::Pads)); pb }
        }
    };
    if body.w() < 0.1 || body.h() < 0.1 { return None; }

    if matches!(family, Family::ElectrolyticSmd) {
        // CP_Elec_6.3x5.4: diameter x height
        if let Some((_, h)) = elec_dh(n) { name_h = Some(h); } else if let Some((_, h, _)) = named { name_h = Some(h); }
    }
    if let Some(h) = eia_height(n) { name_h = Some(h); }
    if family == Family::Inductor && name_h.is_none() { name_h = series_height(n, &body); }
    if family == Family::Chip { name_h = None; }
    if family == Family::To92 { kind = if n.contains("Horizontal") { "horizontal".into() } else if n.starts_with("TO-92L") { "L".into() } else { String::new() }; }
    if family == Family::Generic && n.starts_with("Crystal_") && fp.tht { name_h = Some(crystal_tht_height(n, &body)); }
    if let Some(t) = easyeda_field(n, "T").filter(|_| family == Family::Chip) { name_h = Some(t); }
    let height = match name_h.filter(|h| *h > 0.05 && *h < 40.0) {
        Some(h) => { sources.push(("height".into(), From::Name)); h }
        None => { sources.push(("height".into(), From::Typical)); typical_height(family, fp, &body, &kind) }
    };
    let z0 = match family { Family::GullWing => 0.08, Family::Molded2 => 0.0, Family::Header => 0.0, _ => 0.0 };
    Some(Spec { family, body, z0, height, lead_w: None, foot: None, kind, sources, notes: Vec::new() })
}

/// Applies a datasheet's numbers to `spec`, after checking them against the footprint.  Returns the
/// reasons it refused them (empty when applied).
pub fn apply_dims(spec: &mut Spec, fp: &Footprint, d: &Dims) -> Vec<String> {
    let mut why: Vec<String> = Vec::new();
    let pads = leads(fp);
    let pb = match fp.pad_box() { Some(b) => b, None => return vec!["no pads".into()] };
    let plaus = |a: f64| -> (f64, f64) {
        match spec.family {
            Family::Chip => (0.1, 3.0), Family::Molded2 => (0.3, 3.5), Family::Melf => (0.8, 3.0), Family::GullWing => (0.5, 5.0), Family::NoLead => (0.3, 2.0), Family::Bga => (0.3, 3.5),
            Family::Crystal => (0.2, 5.0), Family::ElectrolyticSmd => (2.0, 25.0), Family::LedPackage => (0.3, 4.0), Family::Inductor => (0.5, 12.0), Family::Switch => (0.5, 15.0), _ => { let _ = a; (0.1, 30.0) }
        }
    };
    // pitch
    if let (Some(e), Some(fpp)) = (d.pitch, pad_pitch(fp)) {
        if !matches!(spec.family, Family::Chip | Family::Molded2 | Family::Melf) && pads.len() > 3 && (e - fpp).abs() > 0.03 {
            why.push(format!("pitch {e} mm but the pads are {fpp} mm apart"));
        }
    }
    if let Some(a) = d.a {
        let (lo, hi) = plaus(a);
        if a < lo || a > hi { why.push(format!("height {a} mm is not a {:?} height ({lo} to {hi} mm)", spec.family)); }
    }
    // body against the pads
    let (long, short) = (pb.w().max(pb.h()), pb.w().min(pb.h()));
    let along_y = rows_along_y(fp, &spec.body);
    let fits = |bx: f64, by: f64| -> Result<(), String> {
        match spec.family {
            Family::NoLead | Family::Bga | Family::Crystal | Family::LedPackage => {
                // pads reach to the body edge or a little past it (no-lead) or sit inside (BGA)
                let (sx, sy) = (pb.w(), pb.h());
                let ok = |b: f64, s: f64| b <= s + 0.6 && b >= s - 1.6;
                if ok(bx, sx) && ok(by, sy) { Ok(()) } else { Err(format!("body {bx:.2} x {by:.2} mm does not fit pads spanning {sx:.2} x {sy:.2} mm")) }
            }
            Family::GullWing => {
                // the body sits between the rows: narrower than the span across the pads, longer than the row
                let (across, along) = match along_y { Some(true) => (pb.w(), pb.h()), Some(false) => (pb.h(), pb.w()), None => (short, long) };
                let (b_across, b_along) = match along_y { Some(true) => (bx, by), Some(false) => (by, bx), None => (bx.min(by), bx.max(by)) };
                if b_across >= across { return Err(format!("body {b_across:.2} mm is as wide as the pads ({across:.2} mm)")); }
                if b_along + 0.05 < along - 1.2 || b_along > along + 4.0 { return Err(format!("body length {b_along:.2} mm does not match the pin row ({along:.2} mm)")); }
                Ok(())
            }
            Family::Chip | Family::Molded2 | Family::Melf => {
                if long - 0.05 > 0.0 && (bx.max(by) > long + 0.8 || bx.max(by) < long * 0.35) { Err(format!("body length {:.2} mm does not match the pads ({long:.2} mm)", bx.max(by))) } else { Ok(()) }
            }
            _ => Ok(()),
        }
    };
    let (dd, ee) = (d.d, d.e1);
    let mut body = None;
    if let (Some(dl), Some(ew)) = (dd, ee) {
        // D along the rows; for quads and leadless parts try both ways and keep the one that fits
        let tries: Vec<(f64, f64)> = match along_y { Some(true) => vec![(ew, dl)], Some(false) => vec![(dl, ew)], None => if pb.w() >= pb.h() { vec![(dl.max(ew), dl.min(ew)), (dl.min(ew), dl.max(ew))] } else { vec![(dl.min(ew), dl.max(ew)), (dl.max(ew), dl.min(ew))] } };
        let mut errs = Vec::new();
        for (bx, by) in tries { match fits(bx, by) { Ok(()) => { body = Some((bx, by)); break; } Err(e) => errs.push(e) } }
        if body.is_none() { why.extend(errs.into_iter().take(1)); }
    }
    if let Some(span) = d.e_span {
        if spec.family == Family::GullWing {
            let across = match along_y { Some(true) => pb.w(), Some(false) => pb.h(), None => short };
            // the lead tips end on the pads: inside the pad span, beyond the inner edges of the pads
            if span > across + 0.4 || span < across - 2.0 { why.push(format!("lead span {span:.2} mm does not match the pads ({across:.2} mm)")); }
        }
    }
    if !why.is_empty() { return why; }
    if let Some((bx, by)) = body {
        spec.body = Rect::centred(spec.body.cx(), spec.body.cy(), bx, by);
        spec.sources.retain(|(k, _)| k != "body");
        spec.sources.push(("body".into(), From::Datasheet));
    }
    if let Some(a) = d.a {
        spec.height = a;
        spec.sources.retain(|(k, _)| k != "height");
        spec.sources.push(("height".into(), From::Datasheet));
    }
    if let Some(a1) = d.a1.filter(|v| *v >= 0.0 && *v < 0.5) { if spec.family == Family::GullWing { spec.z0 = a1.max(0.02); } }
    if let Some(b) = d.b.filter(|v| *v > 0.05 && *v < 3.0) { spec.lead_w = Some(b); }
    if let Some(l) = d.l.filter(|v| *v > 0.1 && *v < 3.0) { spec.foot = Some(l); }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modelgen::footprint::parse;

    #[test]
    fn names_give_numbers() {
        assert_eq!(chip_metric("R_0603_1608Metric"), Some((1.6, 0.8)));
        assert_eq!(chip_metric("C_0402_1005Metric_Pad0.74x0.62mm_HandSolder"), Some((1.0, 0.5)));
        assert_eq!(wxl("QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm"), Some((5.0, 5.0, None)));
        assert_eq!(wxl("SOIC-8_3.9x4.9mm_P1.27mm"), Some((3.9, 4.9, None)));
        assert_eq!(easyeda_field("SOT-23-3_L2.9-W1.3-P1.90-LS2.4-BR", "L"), Some(2.9));
        assert_eq!(easyeda_field("SOT-23-3_L2.9-W1.3-P1.90-LS2.4-BR", "LS"), Some(2.4));
        assert_eq!(mm_after("CP_Radial_D8.0mm_P3.50mm", "D"), Some(8.0));
        assert_eq!(mm_after("PinHeader_1x05_P2.54mm_Vertical", "P"), Some(2.54));
    }

    #[test]
    fn families() {
        let fp = |name: &str, pads: &str| parse(&format!("(footprint \"{name}\" (attr smd) {pads})")).unwrap();
        let two = "(pad 1 smd rect (at -0.8 0) (size 0.8 0.9) (layers F.Cu)) (pad 2 smd rect (at 0.8 0) (size 0.8 0.9) (layers F.Cu))";
        assert_eq!(classify(&fp("R_0603_1608Metric", two)), Family::Chip);
        assert_eq!(classify(&fp("D_SOD-123", two)), Family::Molded2);
        assert_eq!(classify(&fp("QFN-32-1EP_5x5mm_P0.5mm", two)), Family::NoLead);
        assert_eq!(classify(&fp("SOIC-8_3.9x4.9mm_P1.27mm", two)), Family::GullWing);
        assert_eq!(classify(&fp("SOT-23-5", two)), Family::GullWing);
        assert_eq!(classify(&fp("LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm", two)), Family::LedPackage);
        assert_eq!(classify(&fp("Crystal_SMD_3225-4Pin_3.2x2.5mm", two)), Family::Crystal);
        assert_eq!(classify(&fp("CP_Elec_6.3x5.4", two)), Family::ElectrolyticSmd);
        assert_eq!(classify(&fp("USB_C_Receptacle_HRO_TYPE-C-31-M-12", "(fp_rect (start -4.5 -3.6) (end 4.5 3.6) (layer F.Fab))")), Family::UsbC);
    }

    #[test]
    fn datasheet_numbers_are_checked_against_the_pads() {
        let text = r#"(footprint "SOIC-8_3.9x4.9mm_P1.27mm" (attr smd)
          (pad 1 smd rect (at -2.475 -1.905) (size 1.95 0.6) (layers F.Cu)) (pad 2 smd rect (at -2.475 -0.635) (size 1.95 0.6) (layers F.Cu))
          (pad 3 smd rect (at -2.475 0.635) (size 1.95 0.6) (layers F.Cu)) (pad 4 smd rect (at -2.475 1.905) (size 1.95 0.6) (layers F.Cu))
          (pad 5 smd rect (at 2.475 1.905) (size 1.95 0.6) (layers F.Cu)) (pad 6 smd rect (at 2.475 0.635) (size 1.95 0.6) (layers F.Cu))
          (pad 7 smd rect (at 2.475 -0.635) (size 1.95 0.6) (layers F.Cu)) (pad 8 smd rect (at 2.475 -1.905) (size 1.95 0.6) (layers F.Cu)))"#;
        let fp = parse(text).unwrap();
        let mut s = spec_of(&fp).unwrap();
        assert_eq!(s.family, Family::GullWing);
        assert!((s.body.w() - 3.9).abs() < 1e-9 && (s.body.h() - 4.9).abs() < 1e-9, "{:?}", s.body);
        // the right table: applied
        let good = Dims { a: Some(1.75), a1: Some(0.1), d: Some(4.9), e1: Some(3.9), e_span: Some(6.0), pitch: Some(1.27), b: Some(0.42), l: Some(0.8), ..Default::default() };
        assert!(apply_dims(&mut s, &fp, &good).is_empty());
        assert_eq!(s.height, 1.75);
        // a table for another package of the same datasheet (TSSOP-8, 0.65 mm pitch): refused
        let bad = Dims { a: Some(1.2), d: Some(3.0), e1: Some(4.4), e_span: Some(6.4), pitch: Some(0.65), ..Default::default() };
        let why = apply_dims(&mut s, &fp, &bad);
        assert!(!why.is_empty());
        assert_eq!(s.height, 1.75);
    }
}
