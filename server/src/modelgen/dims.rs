//! Reads package dimensions out of a datasheet's text, with no AI.  Two forms are common:
//!
//! - a JEDEC dimension table, one row per letter: `A 0.80 0.85 0.90`, `e 0.50 BSC`, `Overall Height A – – 1.75`
//!   (min, nom, max, millimetres; a table that also lists inches gives those after or before, told apart by the
//!   MILLIMETERS / INCHES heading);
//! - TI's package outline pages, whose title gives the seated height (`VSON - 1 mm max height`).
//!
//! A datasheet often draws several packages; every page that has numbers becomes a candidate, ranked by
//! how well it names the footprint's package, and package.rs's check against the pads picks the one that fits.

use super::package::Dims;

/// One candidate set of dimensions and where it was found.
#[derive(Clone, Debug, PartialEq)]
pub struct Found { pub page: usize, pub dims: Dims, pub score: i32 }

fn is_num(t: &str) -> Option<f64> {
    let t = t.trim_matches(|c: char| c == '(' || c == ')' || c == ',' || c == '*');
    if t.is_empty() || !t.chars().next().map(|c| c.is_ascii_digit() || c == '.').unwrap_or(false) { return None; }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}
fn is_dash(t: &str) -> bool { matches!(t, "-" | "–" | "—" | "--" | "−" | "‒") }

/// The JEDEC letters a row can start with, as written (case matters: E and e differ).
const LETTERS: [&str; 18] = ["A", "A1", "A2", "A3", "b", "b1", "c", "D", "D1", "D2", "E", "E1", "E2", "e", "L", "L1", "K", "N"];

/// (letter, min, nom, max) rows of a page.
fn rows(page: &str) -> Vec<(String, Option<f64>, Option<f64>, Option<f64>)> {
    let lower = page.to_ascii_lowercase();
    // millimetres first unless the page says inches before millimetres
    let mm_first = match (lower.find("millimet"), lower.find("inch")) { (Some(m), Some(i)) => m < i, (None, Some(_)) => false, _ => true };
    let has_inch = lower.contains("inch");
    let mut out = Vec::new();
    for line in page.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        // the letter: the last token before the first number (a label like "Overall Height" may come first)
        let first_val = toks.iter().position(|t| is_num(t).is_some() || is_dash(t));
        let Some(fv) = first_val else { continue };
        if fv == 0 { continue; }
        let letter = toks[fv - 1];
        if !LETTERS.contains(&letter) { continue; }
        // a label of words only before the letter (no other numbers): keeps prose lines out
        if toks[..fv - 1].iter().any(|t| is_num(t).is_some()) { continue; }
        let vals: Vec<Option<f64>> = toks[fv..].iter().take_while(|t| is_num(t).is_some() || is_dash(t) || **t == "BSC" || **t == "REF" || **t == "TYP" || **t == "Ref" || **t == "Typ").filter(|t| is_num(t).is_some() || is_dash(t)).map(|t| is_num(t)).collect();
        if vals.is_empty() || vals.len() > 6 { continue; }
        // one value in each unit (`e 0.50 0.020`): keep the millimetres
        let ratio = |a: Option<f64>, b: Option<f64>| matches!((a, b), (Some(a), Some(b)) if a > 0.0 && b > 0.0 && ((a / b) / 25.4 - 1.0).abs() < 0.08);
        let vals: Vec<Option<f64>> = if has_inch && vals.len() == 2 && (ratio(vals[0], vals[1]) || ratio(vals[1], vals[0])) { vec![if ratio(vals[0], vals[1]) { vals[0] } else { vals[1] }] }
            else if has_inch && vals.len() >= 4 { let half = vals.len() / 2; if mm_first { vals[..half].to_vec() } else { vals[half..].to_vec() } } else { vals };
        let (mn, nom, mx) = match vals.len() { 1 => (None, vals[0], None), 2 => (vals[0], None, vals[1]), _ => (vals[0], vals[1], vals[2]) };
        out.push((letter.to_string(), mn, nom, mx));
    }
    out
}

fn nominal(mn: Option<f64>, nom: Option<f64>, mx: Option<f64>) -> Option<f64> {
    nom.or_else(|| match (mn, mx) { (Some(a), Some(b)) => Some((a + b) / 2.0), (a, b) => a.or(b) })
}

/// TI's outline title: `… - 1 mm max height`, `… - 1.2 mm max height`.
fn ti_height(page: &str) -> Option<f64> {
    let l = page.to_ascii_lowercase();
    let i = l.find("mm max height")?;
    let before = l[..i].trim_end();
    let num: String = before.chars().rev().take_while(|c| c.is_ascii_digit() || *c == '.').collect::<Vec<_>>().into_iter().rev().collect();
    num.parse().ok()
}

/// Dimensions from one page, if it has any.
pub fn from_page(page: &str) -> Option<Dims> {
    let rs = rows(page);
    let get = |k: &str| rs.iter().find(|r| r.0 == k);
    let mut d = Dims::default();
    if let Some(r) = get("A") { d.a = r.3.or(r.2).or(r.1); }
    if let Some(r) = get("A1") { d.a1 = nominal(r.1, r.2, r.3); }
    if let Some(r) = get("D") { d.d = nominal(r.1, r.2, r.3); }
    match (get("E"), get("E1")) {
        (Some(e), Some(e1)) => { d.e_span = nominal(e.1, e.2, e.3); d.e1 = nominal(e1.1, e1.2, e1.3); }
        (Some(e), None) => d.e1 = nominal(e.1, e.2, e.3),
        (None, Some(e1)) => d.e1 = nominal(e1.1, e1.2, e1.3),
        _ => {}
    }
    if let Some(r) = get("e") { d.pitch = nominal(r.1, r.2, r.3); }
    if let Some(r) = get("b") { d.b = nominal(r.1, r.2, r.3); }
    if let Some(r) = get("L") { d.l = nominal(r.1, r.2, r.3); }
    if let Some(r) = get("D2") { d.d2 = nominal(r.1, r.2, r.3); }
    if let Some(r) = get("E2") { d.e2 = nominal(r.1, r.2, r.3); }
    // a table needs a height or the body to count; a lone letter in prose does not
    let table = d.a.is_some() as u8 + d.d.is_some() as u8 + d.e1.is_some() as u8 + d.pitch.is_some() as u8 >= 2;
    if !table { d = Dims::default(); }
    if d.a.is_none() { d.a = ti_height(page); }
    // inches that slipped through (a D of 0.2 for a 5 mm part reads as 0.197 in): leave those to the check
    if d.is_empty() { None } else { Some(d) }
}

/// Every candidate in a datasheet, best first: pages that name the footprint's package (its family word
/// and its pin count) ahead of the rest.
pub fn candidates(pages: &[String], package_words: &[String], pins: usize) -> Vec<Found> {
    let mut out = Vec::new();
    for (i, p) in pages.iter().enumerate() {
        let Some(dims) = from_page(p) else { continue };
        let up = p.to_ascii_uppercase();
        let mut score = 0;
        for w in package_words { if !w.is_empty() && up.contains(&w.to_ascii_uppercase()) { score += 3; } }
        if pins > 0 && (up.contains(&format!("{pins}-LEAD")) || up.contains(&format!("{pins}-PIN")) || up.contains(&format!("{pins} LEAD")) || up.contains(&format!("{pins} PIN")) || up.contains(&format!("-{pins} ")) || up.contains(&format!("{pins}L"))) { score += 2; }
        if up.contains("PACKAGE") || up.contains("MECHANICAL") || up.contains("OUTLINE") { score += 1; }
        score += [dims.a, dims.d, dims.e1, dims.pitch, dims.b, dims.l].iter().filter(|v| v.is_some()).count() as i32;
        out.push(Found { page: i + 1, dims, score });
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.page.cmp(&b.page)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_jedec_tables() {
        // Microchip's layout: label words, letter, MIN NOM MAX
        let page = "8-Lead Plastic Small Outline (SN) - Narrow, 3.90 mm Body [SOIC]\nUnits MILLIMETERS\nDimension Limits MIN NOM MAX\nNumber of Pins N 8\nPitch e 1.27 BSC\nOverall Height A – – 1.75\nMolded Package Thickness A2 1.25 – –\nStandoff § A1 0.10 – 0.25\nOverall Width E 6.00 BSC\nMolded Package Width E1 3.90 BSC\nOverall Length D 4.90 BSC\nFoot Length L 0.40 – 1.27\nLead Width b 0.31 – 0.51\n";
        let d = from_page(page).unwrap();
        assert_eq!(d.a, Some(1.75));
        assert_eq!(d.pitch, Some(1.27));
        assert_eq!((d.d, d.e1, d.e_span), (Some(4.9), Some(3.9), Some(6.0)));
        assert!((d.a1.unwrap() - 0.175).abs() < 1e-9);
        assert!((d.b.unwrap() - 0.41).abs() < 1e-9);
        // a QFN table with millimetres and inches
        let qfn = "DIMENSIONS\nSYMBOL MILLIMETERS INCHES\nMIN NOM MAX MIN NOM MAX\nA 0.80 0.85 0.90 0.031 0.033 0.035\nA1 0.00 0.02 0.05 0.000 0.001 0.002\nb 0.18 0.25 0.30 0.007 0.010 0.012\nD 4.90 5.00 5.10 0.193 0.197 0.201\nE 4.90 5.00 5.10 0.193 0.197 0.201\ne 0.50 0.020\nD2 3.35 3.45 3.55 0.132 0.136 0.140\nL 0.30 0.40 0.50 0.012 0.016 0.020\n";
        let d = from_page(qfn).unwrap();
        assert_eq!((d.a, d.d, d.e1, d.e_span), (Some(0.9), Some(5.0), Some(5.0), None));
        assert_eq!(d.pitch, Some(0.5));
        assert_eq!(d.d2, Some(3.45));
        // inches first
        let inch = "Dimensions In Inches Dimensions In Millimeters\nA 0.035 0.039 0.90 1.00\nD 0.110 0.120 2.80 3.04\nE 0.047 0.055 1.20 1.40\n";
        let d = from_page(inch).unwrap();
        assert_eq!(d.a, Some(1.0));
        assert_eq!(d.d, Some(2.92));
    }

    #[test]
    fn reads_ti_outline_titles() {
        let page = "www.ti.com\n PACKAGE OUTLINE\nC\n10X\n0.30\n0.18\n A 3.1\n2.9 B\n VSON - 1 mm max heightDRC0010J\n PLASTIC SMALL OUTLINE - NO LEAD";
        let d = from_page(page).unwrap();
        assert_eq!(d.a, Some(1.0));
        assert_eq!(d.d, None);
        // prose with a stray letter is not a table
        assert_eq!(from_page("Supply voltage at VIN, VINA 1.8 5.5 V\nA 3 V output"), None);
    }

    #[test]
    fn ranks_the_page_that_names_the_package() {
        let pages = vec![
            "TSSOP-8 package\nA – – 1.20\nD 2.90 3.00 3.10\nE1 4.30 4.40 4.50\ne 0.65 BSC\n".to_string(),
            "8-Lead SOIC package outline\nA – – 1.75\nD 4.80 4.90 5.00\nE1 3.80 3.90 4.00\ne 1.27 BSC\n".to_string(),
        ];
        let c = candidates(&pages, &["SOIC".to_string()], 8);
        assert_eq!(c[0].page, 2);
        assert_eq!(c.len(), 2);
    }
}
