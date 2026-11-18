//! The last resort for a part no vendor has drawings for: KiCad's own libraries.
//!
//! Mouser, DigiKey and Farnell publish no drawings, and LCSC does not stock
//! everything.  What every vendor does say is the package ("0603 (1608 Metric)",
//! "8-SOIC (0.154\", 3.90mm Width)", "LQFP-48"), and for the common packages
//! KiCad's standard library has exactly one footprint.  So the footprint is
//! matched by package, a passive gets KiCad's `Device` symbol, and anything else
//! gets a plain box with one numbered pin per pad, to be checked against the
//! datasheet.  A package that could mean several footprints (QFN with its many
//! exposed pads, a 28-pin DIP of either width) is left unmatched rather than
//! guessed.

use serde_json::{json, Value};

use super::easyeda::{self, fnum, q, SymbolOut};
use super::vendors::PartInfo;

/// What kind of part the vendor's words describe, as far as the symbol is concerned.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Resistor,
    Capacitor,
    Inductor,
    Led,
    Diode,
    Other,
}

impl Kind {
    fn reference(self) -> &'static str {
        match self {
            Kind::Resistor => "R",
            Kind::Capacitor => "C",
            Kind::Inductor => "L",
            Kind::Led | Kind::Diode => "D",
            Kind::Other => "U",
        }
    }
    /// KiCad's `Device` symbol for a two-pin passive.
    fn device_symbol(self) -> Option<&'static str> {
        match self {
            Kind::Resistor => Some("R"),
            Kind::Capacitor => Some("C"),
            Kind::Inductor => Some("L"),
            Kind::Led => Some("LED"),
            Kind::Diode => Some("D"),
            Kind::Other => None,
        }
    }
}

fn has_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == word || w.strip_suffix('s') == Some(word))
}

pub fn kind_of(info: &PartInfo) -> Kind {
    let t = format!("{} {}", info.category, info.description).to_ascii_lowercase();
    // an IC that drives or protects one of these is not one of these
    if ["driver", "controller", "regulator", "converter", "array", "network", "module", "sensor", "amplifier"].iter().any(|w| has_word(&t, w)) {
        return Kind::Other;
    }
    if has_word(&t, "led") || t.contains("light emitting") {
        Kind::Led
    } else if has_word(&t, "resistor") || has_word(&t, "thermistor") {
        Kind::Resistor
    } else if has_word(&t, "capacitor") {
        Kind::Capacitor
    } else if has_word(&t, "inductor") || t.contains("ferrite bead") || has_word(&t, "choke") {
        Kind::Inductor
    } else if ["diode", "rectifier", "schottky", "zener", "tvs"].iter().any(|w| has_word(&t, w)) {
        Kind::Diode
    } else {
        Kind::Other
    }
}

/// "48-LQFP", "LQFP-48", "SOIC-8", "8-SOIC (0.154\", 3.90mm Width)" → ("LQFP", 48).
fn family_and_pins(p: &str) -> Option<(String, u32)> {
    let head = p.split(['(', ',']).next().unwrap_or("").trim();
    let toks: Vec<&str> = head.split(['-', ' ', '_']).filter(|t| !t.is_empty()).collect();
    let num = |t: &str| t.parse::<u32>().ok().filter(|n| (2..=400).contains(n));
    let alpha = |t: &&&str| t.chars().any(|c| c.is_ascii_alphabetic());
    if let (Some(n), Some(f)) = (toks.first().and_then(|t| num(t)), toks.get(1).filter(alpha)) {
        return Some((f.to_string(), n));
    }
    if let (Some(f), Some(n)) = (toks.first().filter(alpha), toks.last().and_then(|t| num(t))) {
        if toks.len() == 2 {
            return Some((f.to_string(), n));
        }
    }
    None
}

/// The KiCad standard footprint a vendor's package wording names, when it names exactly one.
pub fn footprint_for(package: &str, kind: Kind) -> Option<(&'static str, String)> {
    // DigiKey lists a package under each of its names ("SC-74A, SOT-753"): any one will do.
    // A comma inside brackets belongs to one name ("8-SOIC (0.154\", 3.90mm Width)").
    let mut names: Vec<String> = vec![String::new()];
    let mut depth = 0;
    for c in package.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            _ => {}
        }
        if c == ',' && depth <= 0 {
            names.push(String::new());
        } else {
            names.last_mut().unwrap().push(c);
        }
    }
    names.iter().find_map(|n| footprint_for_name(n, kind))
}

/// Wording that says how the part is shipped, which Mouser gives where others give the package.
pub fn is_packaging(p: &str) -> bool {
    let t = p.trim().to_ascii_lowercase();
    ["mousereel", "reel", "tray", "tube", "bulk", "cut tape", "ammo", "ammo pack", "bag", "box", "each", "tape & reel (tr)", "cut tape (ct)"].contains(&t.as_str())
}

fn footprint_for_name(package: &str, kind: Kind) -> Option<(&'static str, String)> {
    let p = package.trim().to_ascii_uppercase().replace('\u{2011}', "-");
    if p.is_empty() {
        return None;
    }
    let squashed: String = p.chars().filter(|c| !matches!(c, ' ' | '_')).collect();

    // Chip passives: the imperial size code, alone or as "0603 (1608 Metric)".
    const CHIPS: [(&str, &str); 9] =
        [("0201", "0603"), ("0402", "1005"), ("0603", "1608"), ("0805", "2012"), ("1206", "3216"), ("1210", "3225"), ("1812", "4532"), ("2010", "5025"), ("2512", "6332")];
    let first = p.split(|c: char| !c.is_ascii_alphanumeric()).find(|t| !t.is_empty()).unwrap_or("");
    if let Some((imp, met)) = CHIPS.iter().find(|(imp, _)| first == *imp) {
        let (lib, pre) = match kind {
            Kind::Resistor => ("Resistor_SMD", "R"),
            Kind::Capacitor => ("Capacitor_SMD", "C"),
            Kind::Inductor => ("Inductor_SMD", "L"),
            Kind::Led => ("LED_SMD", "LED"),
            Kind::Diode => ("Diode_SMD", "D"),
            Kind::Other => return None,
        };
        return Some((lib, format!("{pre}_{imp}_{met}Metric")));
    }

    // Small-signal and power packages with one land pattern.
    const FIXED: [(&str, &str, &str); 37] = [
        // metal cans, under their own names and JEDEC's
        ("TO-18-3", "Package_TO_SOT_THT", "TO-18-3"),
        ("TO-206AA", "Package_TO_SOT_THT", "TO-18-3"),
        ("TO-18-4", "Package_TO_SOT_THT", "TO-18-4"),
        ("TO-39-3", "Package_TO_SOT_THT", "TO-39-3"),
        ("TO-205AD", "Package_TO_SOT_THT", "TO-39-3"),
        ("TO-5-3", "Package_TO_SOT_THT", "TO-5-3"),
        ("TO-205AA", "Package_TO_SOT_THT", "TO-5-3"),
        ("TO-46-3", "Package_TO_SOT_THT", "TO-46-3"),
        ("SOT-753", "Package_TO_SOT_SMD", "SOT-23-5"),
        ("SC-74A", "Package_TO_SOT_SMD", "SOT-23-5"),
        ("SOT-457", "Package_TO_SOT_SMD", "SOT-23-6"),
        ("SC-74", "Package_TO_SOT_SMD", "SOT-23-6"),
        ("TSOT-23-5", "Package_TO_SOT_SMD", "TSOT-23-5"),
        ("SOT-23-3", "Package_TO_SOT_SMD", "SOT-23"),
        ("SOT-23-5", "Package_TO_SOT_SMD", "SOT-23-5"),
        ("SOT-23-6", "Package_TO_SOT_SMD", "SOT-23-6"),
        ("SOT-23-8", "Package_TO_SOT_SMD", "SOT-23-8"),
        ("SOT-223-3", "Package_TO_SOT_SMD", "SOT-223-3_TabPin2"),
        ("SOT-223", "Package_TO_SOT_SMD", "SOT-223-3_TabPin2"),
        ("SOT-89-3", "Package_TO_SOT_SMD", "SOT-89-3"),
        ("SOT-89", "Package_TO_SOT_SMD", "SOT-89-3"),
        ("SOT-323", "Package_TO_SOT_SMD", "SOT-323_SC-70"),
        ("SC-70-3", "Package_TO_SOT_SMD", "SOT-323_SC-70"),
        ("SOT-353", "Package_TO_SOT_SMD", "SOT-353_SC-70-5"),
        ("SC-70-5", "Package_TO_SOT_SMD", "SOT-353_SC-70-5"),
        ("SOT-363", "Package_TO_SOT_SMD", "SOT-363_SC-70-6"),
        ("SC-70-6", "Package_TO_SOT_SMD", "SOT-363_SC-70-6"),
        ("TO-252", "Package_TO_SOT_SMD", "TO-252-2"),
        ("DPAK", "Package_TO_SOT_SMD", "TO-252-2"),
        ("TO-263", "Package_TO_SOT_SMD", "TO-263-2"),
        ("D2PAK", "Package_TO_SOT_SMD", "TO-263-2"),
        ("TO-220-3", "Package_TO_SOT_THT", "TO-220-3_Vertical"),
        ("TO-92-3", "Package_TO_SOT_THT", "TO-92_Inline"),
        ("TO-92", "Package_TO_SOT_THT", "TO-92_Inline"),
        ("SOD-123", "Diode_SMD", "D_SOD-123"),
        ("SOD-323", "Diode_SMD", "D_SOD-323"),
        ("SOD-523", "Diode_SMD", "D_SOD-523"),
    ];
    let head = squashed.split('(').next().unwrap_or("");
    let head = head.strip_suffix("METALCAN").unwrap_or(head);
    // metal cans by lead count: KiCad has TO-18, TO-39, TO-5 and TO-46 with these leads
    if let Some(rest) = head.strip_prefix("TO-") {
        if let Some((can, leads)) = rest.split_once('-') {
            let known: &[&str] = match can {
                "18" => &["2", "3", "4"],
                "39" => &["2", "3", "4", "6", "8", "10"],
                "5" => &["2", "3", "4", "6", "8", "10"],
                "46" => &["2", "3", "4"],
                _ => &[],
            };
            if known.contains(&leads) {
                return Some(("Package_TO_SOT_THT", format!("TO-{can}-{leads}")));
            }
        }
    }
    // the longest name first, so "SOT-23-5" is not taken for "SOT-23"
    let mut fixed: Vec<&(&str, &str, &str)> = FIXED.iter().collect();
    fixed.sort_by_key(|f| std::cmp::Reverse(f.0.len()));
    for (name, lib, fp) in fixed {
        let hit = head == *name || head.starts_with(&format!("{name}-")) && !head[name.len() + 1..].starts_with(|c: char| c.is_ascii_digit()) || head.ends_with(&format!("-{name}"));
        if hit {
            return Some((lib, fp.to_string()));
        }
    }
    if head == "SOT-23" || head == "SOT23" || head == "TO-236" || head.starts_with("TO-236-3") {
        return Some(("Package_TO_SOT_SMD", "SOT-23".into()));
    }
    for (name, fp) in [("DO-214AC", "D_SMA"), ("SMA", "D_SMA"), ("DO-214AA", "D_SMB"), ("SMB", "D_SMB"), ("DO-214AB", "D_SMC"), ("SMC", "D_SMC")] {
        if (head == name || head.starts_with(&format!("{name}-"))) && matches!(kind, Kind::Diode | Kind::Led) {
            return Some(("Diode_SMD", fp.to_string()));
        }
    }

    let (family, n) = family_and_pins(&p)?;
    let wide = p.contains("7.5MM") || p.contains("7.50MM") || p.contains("0.295") || p.contains("0.300\"") && family.starts_with("SO");
    let name = match (family.as_str(), n) {
        ("SOIC" | "SO" | "SOP" | "SOICN", 8) if !wide => "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
        ("SOIC" | "SO" | "SOP" | "SOICN", 14) if !wide => "Package_SO:SOIC-14_3.9x8.7mm_P1.27mm",
        ("SOIC" | "SO" | "SOP" | "SOICN", 16) if !wide => "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm",
        ("SOIC" | "SO" | "SOICW", 16) => "Package_SO:SOIC-16W_7.5x10.3mm_P1.27mm",
        ("SOIC" | "SO" | "SOICW", 20) => "Package_SO:SOIC-20W_7.5x12.8mm_P1.27mm",
        ("TSSOP", 8) => "Package_SO:TSSOP-8_3x3mm_P0.65mm",
        ("TSSOP", 14) => "Package_SO:TSSOP-14_4.4x5mm_P0.65mm",
        ("TSSOP", 16) => "Package_SO:TSSOP-16_4.4x5mm_P0.65mm",
        ("TSSOP", 20) => "Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm",
        ("TSSOP", 24) => "Package_SO:TSSOP-24_4.4x7.8mm_P0.65mm",
        ("TSSOP", 28) => "Package_SO:TSSOP-28_4.4x9.7mm_P0.65mm",
        ("MSOP" | "VSSOP", 8) => "Package_SO:MSOP-8_3x3mm_P0.65mm",
        ("MSOP" | "VSSOP", 10) => "Package_SO:MSOP-10_3x3mm_P0.5mm",
        ("LQFP", 32) => "Package_QFP:LQFP-32_7x7mm_P0.8mm",
        ("LQFP", 48) => "Package_QFP:LQFP-48_7x7mm_P0.5mm",
        ("LQFP", 64) => "Package_QFP:LQFP-64_10x10mm_P0.5mm",
        ("LQFP", 100) => "Package_QFP:LQFP-100_14x14mm_P0.5mm",
        ("LQFP", 144) => "Package_QFP:LQFP-144_20x20mm_P0.5mm",
        ("TQFP", 32) => "Package_QFP:TQFP-32_7x7mm_P0.8mm",
        ("TQFP", 44) => "Package_QFP:TQFP-44_10x10mm_P0.8mm",
        ("TQFP", 64) => "Package_QFP:TQFP-64_10x10mm_P0.5mm",
        ("TQFP", 100) => "Package_QFP:TQFP-100_14x14mm_P0.5mm",
        ("DIP" | "PDIP", 4 | 6 | 8 | 14 | 16 | 18 | 20) => return Some(("Package_DIP", format!("DIP-{n}_W7.62mm"))),
        ("DIP" | "PDIP", 32 | 40 | 48) => return Some(("Package_DIP", format!("DIP-{n}_W15.24mm"))),
        ("DIP" | "PDIP", 24 | 28) if p.contains("7.62") || p.contains("0.300") => return Some(("Package_DIP", format!("DIP-{n}_W7.62mm"))),
        ("DIP" | "PDIP", 24 | 28) if p.contains("15.24") || p.contains("0.600") => return Some(("Package_DIP", format!("DIP-{n}_W15.24mm"))),
        _ => return None,
    };
    let (lib, fp) = name.split_once(':')?;
    Some((lib, fp.to_string()))
}

/// The footprint for a part: by its package, else by DigiKey's "Supplier Device Package".
pub fn footprint_of(info: &PartInfo, kind: Kind) -> Option<(&'static str, String)> {
    footprint_for(&info.package, kind).or_else(|| info.attributes.get("Supplier Device Package").and_then(|p| footprint_for(p, kind)))
}

/// The pad numbers of a KiCad footprint, each once, in natural order.
fn pad_numbers(fp: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in fp.split("(pad \"").skip(1) {
        let n = part.split('"').next().unwrap_or("");
        if !n.is_empty() && !out.iter().any(|o| o == n) {
            out.push(n.to_string());
        }
    }
    out.sort_by(|a, b| match (a.parse::<u32>(), b.parse::<u32>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        _ => (a.len(), a).cmp(&(b.len(), b)),
    });
    out
}

/// A plain box with one numbered pin per pad, down the left then up the right as a DIP is
/// numbered.  The pins are unnamed and passive: the datasheet says what they are.
fn generic_symbol(name: &str, pads: &[String]) -> SymbolOut {
    const G: f64 = 2.54;
    let left = pads.len().div_ceil(2);
    let rows = left.max(1) as f64;
    let top = ((rows - 1.0) / 2.0).ceil() * G;
    let (x, half) = (7.62, top + G);
    let mut body = format!(
        "\t\t(symbol {}\n\t\t\t(rectangle (start {} {}) (end {} {}) (stroke (width 0.254) (type default)) (fill (type background)))\n",
        q(&format!("{name}_1_1")),
        fnum(-x),
        fnum(half),
        fnum(x),
        fnum(top - (rows - 1.0) * G - G),
    );
    for (i, n) in pads.iter().enumerate() {
        let (px, row, angle) = if i < left { (-x - G, i, 0) } else { (x + G, pads.len() - 1 - i, 180) };
        body.push_str(&format!(
            "\t\t\t(pin passive line (at {} {} {angle}) (length 2.54) (name \"~\" (effects (font (size 1.27 1.27)))) (number {} (effects (font (size 1.27 1.27)))))\n",
            fnum(px),
            fnum(top - row as f64 * G),
            q(n),
        ));
    }
    body.push_str("\t\t)\n");
    SymbolOut {
        name: name.to_string(),
        body,
        units: 1,
        pins: pads.len(),
        bbox: [-x - G, top - (rows - 1.0) * G - G, x + G, half],
        hide_pin_names: true,
        hide_pin_numbers: false,
        tidied: false,
        transistor: None,
    }
}

/// The `cad` block of a part view built from KiCad's standard library, when the part's
/// package names one of its footprints.  `lib` is the library the generic symbol goes in.
pub async fn cad(info: &PartInfo, lib: &str, fields: &[(String, String)]) -> Option<Value> {
    let kind = kind_of(info);
    let (fp_lib, fp_name) = footprint_of(info, kind)?;
    let libs = crate::libs::shared();
    let fp: Value = serde_json::from_str(&libs.footprint_json(fp_lib, &fp_name).await.ok()?).ok()?;
    let fp_text = fp.get("footprint")?.as_str()?.to_string();
    let fpid = format!("{fp_lib}:{fp_name}");
    let pads = pad_numbers(&fp_text);
    let value = super::display_value(info, &fp_name);

    let symbol = match kind.device_symbol() {
        Some(dev) => match libs.symbol_json("Device", dev).await.ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            Some(s) => s.get("symbol").and_then(Value::as_str).map(|text| json!({ "name": dev, "lib_id": format!("Device:{dev}"), "sexpr": text, "units": 1, "pins": 2, "generic": false })),
            None => None,
        },
        None if (3..=256).contains(&pads.len()) => {
            let name = easyeda::lib_name(if info.mpn.is_empty() { &fp_name } else { &info.mpn });
            let sym = generic_symbol(&name, &pads);
            let sexpr = easyeda::symbol_sexpr(&sym, kind.reference(), &value, &fpid, &info.datasheet, &info.description, fields);
            Some(json!({ "name": name, "lib_id": format!("{lib}:{name}"), "sexpr": sexpr, "units": 1, "pins": sym.pins, "generic": true }))
        }
        None => None,
    };
    Some(json!({
        "source": { "vendor": "kicad", "vendor_id": fpid, "package": info.package },
        "lib": lib,
        "reference": kind.reference(),
        "symbol": symbol,
        "footprint": { "name": fp_name, "fpid": fpid, "sexpr": fp_text, "pads": pads.len(), "through_hole": fp_text.contains("thru_hole") },
        "model": Value::Null,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(package: &str, kind: Kind) -> Option<String> {
        footprint_for(package, kind).map(|(l, n)| format!("{l}:{n}"))
    }

    #[test]
    fn packages_as_the_vendors_write_them() {
        // DigiKey
        assert_eq!(fp("0603 (1608 Metric)", Kind::Resistor).as_deref(), Some("Resistor_SMD:R_0603_1608Metric"));
        assert_eq!(fp("0805 (2012 Metric)", Kind::Capacitor).as_deref(), Some("Capacitor_SMD:C_0805_2012Metric"));
        assert_eq!(fp("48-LQFP", Kind::Other).as_deref(), Some("Package_QFP:LQFP-48_7x7mm_P0.5mm"));
        assert_eq!(fp("8-SOIC (0.154\", 3.90mm Width)", Kind::Other).as_deref(), Some("Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"));
        assert_eq!(fp("16-SOIC (0.295\", 7.50mm Width)", Kind::Other).as_deref(), Some("Package_SO:SOIC-16W_7.5x10.3mm_P1.27mm"));
        assert_eq!(fp("SOT-23-3", Kind::Other).as_deref(), Some("Package_TO_SOT_SMD:SOT-23"));
        assert_eq!(fp("TO-236-3, SC-59, SOT-23-3", Kind::Other).as_deref(), Some("Package_TO_SOT_SMD:SOT-23"));
        assert_eq!(fp("SC-74A, SOT-753", Kind::Other).as_deref(), Some("Package_TO_SOT_SMD:SOT-23-5"));
        assert_eq!(fp("SC-74, SOT-457", Kind::Other).as_deref(), Some("Package_TO_SOT_SMD:SOT-23-6"));
        assert_eq!(fp("TO-206AA, TO-18-3 Metal Can", Kind::Other).as_deref(), Some("Package_TO_SOT_THT:TO-18-3"));
        assert_eq!(fp("TO-205AD, TO-39-3 Metal Can", Kind::Other).as_deref(), Some("Package_TO_SOT_THT:TO-39-3"));
        assert_eq!(fp("TO-99-8 Metal Can", Kind::Other), None);
        assert_eq!(fp("TO-5-8 Metal Can", Kind::Other).as_deref(), Some("Package_TO_SOT_THT:TO-5-8"));
        assert_eq!(fp("TO-18", Kind::Other), None, "a can with an unknown number of leads");
        assert!(is_packaging("MouseReel") && is_packaging("Tray") && !is_packaging("SOT-23-5"));
        assert_eq!(fp("TO-220-3", Kind::Other).as_deref(), Some("Package_TO_SOT_THT:TO-220-3_Vertical"));
        assert_eq!(fp("8-DIP (0.300\", 7.62mm)", Kind::Other).as_deref(), Some("Package_DIP:DIP-8_W7.62mm"));
        assert_eq!(fp("28-DIP (0.300\", 7.62mm)", Kind::Other).as_deref(), Some("Package_DIP:DIP-28_W7.62mm"));
        // Mouser
        assert_eq!(fp("SOIC-8", Kind::Other).as_deref(), Some("Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"));
        assert_eq!(fp("LQFP-48", Kind::Other).as_deref(), Some("Package_QFP:LQFP-48_7x7mm_P0.5mm"));
        assert_eq!(fp("SOT-23-5", Kind::Other).as_deref(), Some("Package_TO_SOT_SMD:SOT-23-5"));
        assert_eq!(fp("TSSOP-16", Kind::Other).as_deref(), Some("Package_SO:TSSOP-16_4.4x5mm_P0.65mm"));
        assert_eq!(fp("SOD-123", Kind::Diode).as_deref(), Some("Diode_SMD:D_SOD-123"));
        assert_eq!(fp("SMA", Kind::Diode).as_deref(), Some("Diode_SMD:D_SMA"));
        // not one footprint: left alone
        assert_eq!(fp("QFN-32", Kind::Other), None);
        assert_eq!(fp("28-DIP", Kind::Other), None);
        assert_eq!(fp("0603", Kind::Other), None, "a chip size without knowing what the part is");
        assert_eq!(fp("", Kind::Resistor), None);
        assert_eq!(fp("Reel", Kind::Resistor), None);
    }

    #[test]
    fn kinds_from_the_vendor_words() {
        let k = |category: &str, description: &str| kind_of(&PartInfo { category: category.into(), description: description.into(), ..Default::default() });
        assert_eq!(k("Chip Resistor - Surface Mount", "RES 10K OHM 1% 1/10W 0603"), Kind::Resistor);
        assert_eq!(k("Thick Film Resistors - SMD", "10 kOhms"), Kind::Resistor);
        assert_eq!(k("Ceramic Capacitors", "CAP CER 100NF"), Kind::Capacitor);
        assert_eq!(k("LED Indication - Discrete", "LED RED CLEAR 0603 SMD"), Kind::Led);
        assert_eq!(k("LED Drivers", "IC LED DRIVER"), Kind::Other);
        assert_eq!(k("Diodes - Rectifiers", "DIODE SCHOTTKY 40V"), Kind::Diode);
        assert_eq!(k("Microcontrollers", "IC MCU 32BIT 64KB FLASH 48LQFP"), Kind::Other);
        assert_eq!(k("Resistor Networks, Arrays", "RES ARRAY 4 RES 10K"), Kind::Other);
    }

    #[test]
    fn a_generic_symbol_has_a_pin_per_pad() {
        let fp = "(footprint \"X\" (pad \"1\" smd) (pad \"2\" smd) (pad \"3\" smd) (pad \"4\" smd) (pad \"5\" smd) (pad \"5\" smd) (pad \"\" np_thru_hole))";
        let pads = pad_numbers(fp);
        assert_eq!(pads, ["1", "2", "3", "4", "5"]);
        let s = generic_symbol("X", &pads);
        assert_eq!(s.pins, 5);
        assert_eq!(s.body.matches("(pin passive line").count(), 5);
        // 1-3 down the left, 4-5 up the right: pin 5 is opposite pin 1
        assert!(s.body.contains("(at -10.16 2.54 0) (length 2.54) (name \"~\" (effects (font (size 1.27 1.27)))) (number \"1\""), "{}", s.body);
        assert!(s.body.contains("(at 10.16 2.54 180) (length 2.54) (name \"~\" (effects (font (size 1.27 1.27)))) (number \"5\""), "{}", s.body);
    }
}
