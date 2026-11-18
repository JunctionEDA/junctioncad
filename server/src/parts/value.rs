//! The Value a placed part carries.
//!
//! A passive is known by what it is, not by its part number: a 220 Ω resistor's Value is
//! "220Ω", a 100 nF capacitor's "100nF".  Vendors say this in an attribute ("Resistance":
//! "10 kOhms", "Capacitance": "0.1 µF") or in the description ("… 100mW 10kΩ 75V Thick Film
//! Resistor …"); either is read and written the way a schematic writes it.  Any other part
//! keeps its manufacturer part number.

use super::standard::{kind_of, Kind};
use super::vendors::PartInfo;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Unit {
    Ohm,
    Farad,
    Henry,
    Hertz,
}

impl Unit {
    fn symbol(self) -> &'static str {
        match self {
            Unit::Ohm => "Ω",
            Unit::Farad => "F",
            Unit::Henry => "H",
            Unit::Hertz => "Hz",
        }
    }
    /// The prefixes a schematic uses for this unit, smallest first.  A capacitor is
    /// "1000µF", never "1mF".
    fn prefixes(self) -> &'static [(&'static str, i32)] {
        match self {
            Unit::Ohm => &[("m", -3), ("", 0), ("k", 3), ("M", 6), ("G", 9)],
            Unit::Farad => &[("p", -12), ("n", -9), ("µ", -6)],
            Unit::Henry => &[("n", -9), ("µ", -6), ("m", -3), ("", 0)],
            Unit::Hertz => &[("", 0), ("k", 3), ("M", 6), ("G", 9)],
        }
    }
}

/// The schematic Value for this part: its resistance, capacitance, inductance or
/// frequency for a passive or a crystal, else None (the caller uses the part number).
pub fn component_value(info: &PartInfo) -> Option<String> {
    let text = format!("{} {}", info.category, info.description).to_ascii_lowercase();
    let (unit, keys): (Unit, &[&str]) = match kind_of(info) {
        Kind::Resistor => (Unit::Ohm, &["Resistance", "Resistance (Ohms)", "Resistance Value"]),
        Kind::Capacitor => (Unit::Farad, &["Capacitance", "Capacitance Value"]),
        // a ferrite bead is known by its impedance at its test frequency
        Kind::Inductor if text.contains("ferrite") || text.contains("bead") => (Unit::Ohm, &["Impedance @ Frequency", "Impedance @ Freq", "Impedance"]),
        Kind::Inductor => (Unit::Henry, &["Inductance", "Inductance Value"]),
        Kind::Other if ["crystal", "resonator", "oscillator"].iter().any(|w| text.contains(w)) => (Unit::Hertz, &["Frequency", "Nominal Frequency"]),
        _ => return None,
    };
    for k in keys {
        if let Some(v) = info.attributes.iter().find(|(name, _)| name.eq_ignore_ascii_case(k)).and_then(|(_, v)| first_quantity(v, unit)) {
            return Some(v);
        }
    }
    first_quantity(&info.description, unit)
}

/// The first "<number><prefix><unit>" in `text` with this unit, as a schematic writes it.
fn first_quantity(text: &str, unit: Unit) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // a number starts here, not inside a word or another number ("0603", "X7R")
        let starts = chars[i].is_ascii_digit() && (i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '.'));
        if !starts {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == '.') {
            j += 1;
        }
        let num: String = chars[i..j].iter().collect();
        let Ok(mantissa) = num.parse::<f64>() else {
            i = j;
            continue;
        };
        let mut k = j;
        while k < chars.len() && chars[k] == ' ' {
            k += 1;
        }
        let rest: String = chars[k..].iter().take(8).collect();
        if let Some(base) = read_unit(&rest, unit) {
            return Some(format_si(mantissa * base, unit));
        }
        // "4R7", "4K7": a resistor's code, the letter standing for the point
        if unit == Unit::Ohm {
            if let Some((mult, frac)) = rkm(&chars, j) {
                let frac: f64 = format!("0.{frac}").parse().unwrap_or(0.0);
                return Some(format_si((mantissa + frac) * mult, unit));
            }
        }
        i = j;
    }
    None
}

/// "4K7" after the digits "4": the multiplier and the digits after the letter.
fn rkm(chars: &[char], at: usize) -> Option<(f64, String)> {
    let mult = match chars.get(at)? {
        'R' | 'r' => 1.0,
        'K' | 'k' => 1e3,
        'M' => 1e6,
        _ => return None,
    };
    let digits: String = chars[at + 1..].iter().take_while(|c| c.is_ascii_digit()).collect();
    let end = at + 1 + digits.len();
    if digits.is_empty() || chars.get(end).is_some_and(|c| c.is_alphanumeric()) {
        return None;
    }
    Some((mult, digits))
}

/// The multiplier of the prefixed unit that `rest` starts with, if it is `unit`.
fn read_unit(rest: &str, unit: Unit) -> Option<f64> {
    let matches = |t: &str| -> bool {
        let t = t.trim_start();
        let lower = t.to_lowercase();
        match unit {
            Unit::Ohm => t.starts_with('Ω') || t.starts_with('\u{2126}') || lower.starts_with("ohm"),
            Unit::Farad => lower.starts_with('f'),
            Unit::Henry => lower.starts_with('h') && !lower.starts_with("hz"),
            Unit::Hertz => lower.starts_with("hz"),
        }
    };
    if matches(rest) {
        return Some(1.0);
    }
    let first = rest.chars().next()?;
    let prefix = match first {
        'p' | 'P' => 1e-12,
        'n' | 'N' => 1e-9,
        'u' | 'U' | 'µ' | 'μ' => 1e-6,
        'm' => 1e-3,
        'k' | 'K' => 1e3,
        'M' => 1e6,
        'G' => 1e9,
        _ => return None,
    };
    matches(&rest[first.len_utf8()..]).then_some(prefix)
}

/// 220 Ω → "220Ω"; 1e-7 F → "100nF"; 4700 Ω → "4.7kΩ".
fn format_si(value: f64, unit: Unit) -> String {
    if value == 0.0 {
        return format!("0{}", unit.symbol());
    }
    let prefixes = unit.prefixes();
    let mut pick = prefixes[0];
    for p in prefixes {
        if value >= 10f64.powi(p.1) * 0.999_999 {
            pick = *p;
        }
    }
    let m = value / 10f64.powi(pick.1);
    // six significant figures (enough for 32.768kHz), without trailing zeros
    let digits = (6 - (m.abs().log10().floor() as i32 + 1)).clamp(0, 6) as usize;
    let mut s = format!("{m:.digits$}");
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    format!("{s}{}{}", pick.0, unit.symbol())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(category: &str, description: &str, attrs: &[(&str, &str)]) -> PartInfo {
        PartInfo {
            category: category.into(),
            description: description.into(),
            mpn: "MPN-1".into(),
            attributes: attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn resistors() {
        let r = part("Chip Resistor - Surface Mount / Resistors", "-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1% 0603", &[]);
        assert_eq!(component_value(&r).as_deref(), Some("10kΩ"));
        let r = part("Chip Resistor - Surface Mount", "", &[("Resistance", "220Ω")]);
        assert_eq!(component_value(&r).as_deref(), Some("220Ω"));
        let r = part("Resistors", "RES 4.7K OHM 1% 1/10W 0603", &[("Resistance", "4.7 kOhms")]);
        assert_eq!(component_value(&r).as_deref(), Some("4.7kΩ"));
        let r = part("Thick Film Resistors - SMD", "Thick Film Resistors - SMD 1/10W 1Mohm 1%", &[]);
        assert_eq!(component_value(&r).as_deref(), Some("1MΩ"));
        let r = part("Resistors", "RES 0 OHM JUMPER 0603", &[("Resistance", "0 Ohms")]);
        assert_eq!(component_value(&r).as_deref(), Some("0Ω"));
        let r = part("Current Sense Resistors", "100mΩ 1% 0805", &[]);
        assert_eq!(component_value(&r).as_deref(), Some("100mΩ"));
        let r = part("Resistors", "Chip resistor 4K7 1% 0603", &[]);
        assert_eq!(component_value(&r).as_deref(), Some("4.7kΩ"));
        let r = part("Resistors", "Resistor 1.5 kohm", &[]);
        assert_eq!(component_value(&r).as_deref(), Some("1.5kΩ"));
    }

    #[test]
    fn capacitors_and_inductors() {
        let c = part("Multilayer Ceramic Capacitors MLCC - SMD/SMT", "50V 100nF X7R ±10% 0603", &[]);
        assert_eq!(component_value(&c).as_deref(), Some("100nF"));
        let c = part("Capacitors", "CAP CER 0.1UF 50V X7R 0603", &[("Capacitance", "0.1 µF")]);
        assert_eq!(component_value(&c).as_deref(), Some("100nF"));
        let c = part("Aluminum Electrolytic Capacitors", "1000uF 16V", &[]);
        assert_eq!(component_value(&c).as_deref(), Some("1000µF"));
        let c = part("Capacitors", "22pF 50V C0G 0402", &[]);
        assert_eq!(component_value(&c).as_deref(), Some("22pF"));
        let l = part("Power Inductors", "10uH ±20% 2A", &[("Inductance", "10µH")]);
        assert_eq!(component_value(&l).as_deref(), Some("10µH"));
        let l = part("Fixed Inductors", "", &[("Inductance", "4.7 µH")]);
        assert_eq!(component_value(&l).as_deref(), Some("4.7µH"));
        let fb = part("Ferrite Beads", "600Ω@100MHz 0603 Ferrite Bead", &[]);
        assert_eq!(component_value(&fb).as_deref(), Some("600Ω"));
    }

    #[test]
    fn crystals_and_others() {
        let y = part("Crystals", "16MHz ±20ppm 20pF SMD3225-4P Crystal", &[]);
        assert_eq!(component_value(&y).as_deref(), Some("16MHz"));
        let y = part("Crystals", "CRYSTAL 32.7680KHZ 12.5PF SMD", &[("Frequency", "32.768 kHz")]);
        assert_eq!(component_value(&y).as_deref(), Some("32.768kHz"));
        let u = part("Microcontrollers", "ARM Cortex-M3 72MHz 64KB Flash", &[]);
        assert_eq!(component_value(&u), None);
        let reg = part("Voltage Regulators", "1A 3.3V LDO with 10uF capacitor", &[]);
        assert_eq!(component_value(&reg), None);
        // a value that cannot be read is no value
        let r = part("Resistors", "Thick film resistor", &[]);
        assert_eq!(component_value(&r), None);
    }
}
