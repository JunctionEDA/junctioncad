//! Footprints from package dimensions: the land pattern IPC-7351B computes from a package's numbers (the
//! same JEDEC letters a datasheet's dimension table gives, dims.rs), the way KiCad's own footprint
//! generator scripts do, at nominal density.  Two-row gull-wing packages (SOIC, SSOP, TSSOP, MSOP, SOT),
//! four-side gull-wing (QFP), two-row and four-side leadless (DFN/SON, QFN, with the exposed pad) and
//! two-terminal chips.  Pins are numbered counter-clockwise from pin 1 at the top left, as JEDEC does.
//!
//! The numbers are checked against each other before anything is written (the pins fit along the body,
//! the leads reach past it, the pitch is a real pitch); the symbol's pin count is the caller's check.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use super::package::Dims;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style { GullWing2, GullWing4, NoLead2, NoLead4, Chip }

#[derive(Debug, Serialize)]
pub struct Land { pub name: String, pub kicad_mod: String, pub pads: usize, pub courtyard: [f64; 2] }

fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
fn grid(v: f64, g: f64) -> f64 { (v / g).ceil() * g }
fn f(v: f64) -> String { let s = format!("{:.4}", r2(v * 50.0) / 50.0); let s = s.trim_end_matches('0').trim_end_matches('.').to_string(); if s == "-0" { "0".into() } else { s } }

/// Checks the numbers hang together for this style; the reasons when they do not.
pub fn check(style: Style, pins: usize, d: &Dims) -> Vec<String> {
    let mut why = Vec::new();
    let need = |v: Option<f64>, k: &str, why: &mut Vec<String>| if v.is_none() { why.push(format!("{k} missing")); };
    match style {
        Style::Chip => { need(d.d, "L (D)", &mut why); need(d.e1, "W (E)", &mut why); }
        _ => {
            for (v, k) in [(d.d, "D"), (d.e1, "E/E1"), (d.pitch, "e"), (d.b, "b"), (d.l, "L")] { need(v, k, &mut why); }
            if matches!(style, Style::GullWing2 | Style::GullWing4) { need(d.e_span, "E (over the leads)", &mut why); }
        }
    }
    if !why.is_empty() { return why; }
    if style == Style::Chip { return why; }
    let (dd, e1, e, b, l) = (d.d.unwrap(), d.e1.unwrap(), d.pitch.unwrap(), d.b.unwrap(), d.l.unwrap());
    let sides = if matches!(style, Style::GullWing4 | Style::NoLead4) { 4 } else { 2 };
    if pins % sides != 0 { why.push(format!("{pins} pins do not split over {sides} sides")); return why; }
    let per = pins / sides;
    if ![0.3, 0.35, 0.4, 0.5, 0.635, 0.65, 0.8, 0.95, 1.0, 1.27, 2.54].iter().any(|p| (p - e).abs() < 0.011) { why.push(format!("pitch {e} mm is not a package pitch")); }
    if b >= e { why.push(format!("lead width {b} mm is not less than the pitch {e} mm")); }
    let row = (per as f64 - 1.0) * e + b;
    if row > dd + 0.05 { why.push(format!("{per} pins at {e} mm need {row:.2} mm, more than the body's {dd} mm")); }
    if sides == 4 && row > e1 + 0.05 { why.push(format!("{per} pins at {e} mm need {row:.2} mm, more than the body's {e1} mm")); }
    if matches!(style, Style::GullWing2 | Style::GullWing4) {
        let span = d.e_span.unwrap();
        if span <= e1 { why.push(format!("over the leads ({span} mm) is not wider than the body ({e1} mm)")); }
        if l > (span - e1) / 2.0 + 0.3 { why.push(format!("foot length {l} mm is longer than the leads reach")); }
    } else if l * 2.0 >= e1.min(dd) { why.push(format!("terminal length {l} mm is too long for a {e1} mm body")); }
    if let (Some(d2), Some(e2)) = (d.d2, d.e2) { if d2 >= dd - 2.0 * l + 0.4 || e2 >= e1 - 2.0 * l + 0.4 { why.push("the exposed pad overlaps the terminals".into()); } }
    why
}

struct Pad { num: String, x: f64, y: f64, w: f64, h: f64 }

/// The land pattern, or the reasons the numbers do not make one.
pub fn land(style: Style, pins: usize, d: &Dims, package: &str) -> Result<Land, Vec<String>> {
    let why = check(style, pins, d);
    if !why.is_empty() { return Err(why); }
    let mut pads: Vec<Pad> = Vec::new();
    let (body_x, body_y);
    match style {
        Style::Chip => {
            let (l, w) = (d.d.unwrap(), d.e1.unwrap());
            // IPC-7351B chip, nominal: toe 0.35 (0.25 below 1608), heel 0, side 0; the terminal a quarter of the length
            let jt = if l < 1.5 { 0.2 } else { 0.35 };
            let t = d.l.unwrap_or(l * 0.25);
            let (z, g) = (l + 2.0 * jt, (l - 2.0 * t).max(l * 0.3));
            let (len, x) = ((z - g) / 2.0, (z + g) / 4.0);
            let h = w + if l < 1.5 { 0.0 } else { 0.1 };
            pads.push(Pad { num: "1".into(), x: -x, y: 0.0, w: len, h });
            pads.push(Pad { num: "2".into(), x, y: 0.0, w: len, h });
            body_x = l; body_y = w;
        }
        Style::GullWing2 | Style::GullWing4 | Style::NoLead2 | Style::NoLead4 => {
            let (dd, e1, e, b, l) = (d.d.unwrap(), d.e1.unwrap(), d.pitch.unwrap(), d.b.unwrap(), d.l.unwrap());
            let gull = matches!(style, Style::GullWing2 | Style::GullWing4);
            let four = matches!(style, Style::GullWing4 | Style::NoLead4);
            // pad length and centre across a row: IPC-7351B nominal fillets
            let (outer, inner, width) = if gull {
                let span = d.e_span.unwrap();
                let (jt, jh, js) = (0.35, 0.35, if e > 0.625 { 0.03 } else { -0.02 });
                // only the nominal foot length is known: allow for its tolerance (JEDEC's is about +-30 %)
                ((span + 2.0 * jt) / 2.0, (span - 2.0 * 1.3 * l - 2.0 * jh) / 2.0, b + 2.0 * js)
            } else {
                let w = e1;
                ((w + 2.0 * 0.3) / 2.0, (w - 2.0 * l - 2.0 * 0.05) / 2.0, b + 0.05)
            };
            let inner = if gull { inner.max(d.e1.unwrap() / 2.0 - 0.6).min(outer - 0.4) } else { inner };
            let (len, c) = (outer - inner, (outer + inner) / 2.0);
            let width = width.min(e - 0.2).max(0.15);
            let sides = if four { 4 } else { 2 };
            let per = pins / sides;
            let start = (per as f64 - 1.0) * e / 2.0;
            let mut n = 1;
            // left side top to bottom (y down), bottom left to right, right bottom to top, top right to left
            for i in 0..per { pads.push(Pad { num: n.to_string(), x: -c, y: -start + i as f64 * e, w: len, h: width }); n += 1; }
            if four {
                // the top and bottom rows sit across D, the same way
                let (outer_d, inner_d) = if gull { let span = d.e_span.unwrap() - e1 + dd; ((span + 0.7) / 2.0, (span - 2.0 * l - 0.7) / 2.0) } else { ((dd + 0.6) / 2.0, (dd - 2.0 * l - 0.1) / 2.0) };
                let inner_d = if gull { inner_d.max(dd / 2.0 - 0.6).min(outer_d - 0.4) } else { inner_d };
                let (len_d, c_d) = (outer_d - inner_d, (outer_d + inner_d) / 2.0);
                for i in 0..per { pads.push(Pad { num: n.to_string(), x: -start + i as f64 * e, y: c_d, w: width, h: len_d }); n += 1; }
                for i in 0..per { pads.push(Pad { num: n.to_string(), x: c, y: start - i as f64 * e, w: len, h: width }); n += 1; }
                for i in 0..per { pads.push(Pad { num: n.to_string(), x: start - i as f64 * e, y: -c_d, w: width, h: len_d }); n += 1; }
            } else {
                for i in 0..per { pads.push(Pad { num: n.to_string(), x: c, y: start - i as f64 * e, w: len, h: width }); n += 1; }
            }
            if let (Some(d2), Some(e2)) = (d.d2, d.e2) { pads.push(Pad { num: (pins + 1).to_string(), x: 0.0, y: 0.0, w: e2, h: d2 }); }
            body_x = e1; body_y = dd;
        }
    }
    let pad_ext = pads.iter().fold((0.0f64, 0.0f64), |a, p| (a.0.max(p.x.abs() + p.w / 2.0), a.1.max(p.y.abs() + p.h / 2.0)));
    let cy = (grid(pad_ext.0.max(body_x / 2.0) + 0.25, 0.01), grid(pad_ext.1.max(body_y / 2.0) + 0.25, 0.01));
    let n_pads = pads.len();
    let name = match style {
        Style::Chip => format!("{package}_{}x{}mm", f(body_x), f(body_y)),
        _ => format!("{package}_{}x{}mm_P{}mm", f(body_x), f(body_y), f(d.pitch.unwrap_or(0.0))),
    };
    let mut s = String::new();
    let _ = writeln!(s, "(footprint \"{name}\"\n  (version 20240108)\n  (generator \"junction_footprint_generator\")\n  (layer \"F.Cu\")");
    let _ = writeln!(s, "  (descr \"{package}, {pins} pins, generated from the datasheet's package dimensions (IPC-7351B nominal)\")\n  (attr smd)");
    let _ = writeln!(s, "  (property \"Reference\" \"REF**\" (at 0 {} 0) (layer \"F.SilkS\") (effects (font (size 1 1) (thickness 0.15))))", f(-cy.1 - 1.0));
    let _ = writeln!(s, "  (property \"Value\" \"{name}\" (at 0 {} 0) (layer \"F.Fab\") (effects (font (size 1 1) (thickness 0.15))))", f(cy.1 + 1.0));
    // fabrication outline with pin 1's corner cut
    let (bx, by) = (body_x / 2.0, body_y / 2.0);
    let ch = (body_x.min(body_y) * 0.25).min(1.0);
    let fab = if style == Style::Chip { vec![(-bx, -by), (bx, -by), (bx, by), (-bx, by)] } else { vec![(-bx + ch, -by), (bx, -by), (bx, by), (-bx, by), (-bx, -by + ch)] };
    for i in 0..fab.len() { let (a, b) = (fab[i], fab[(i + 1) % fab.len()]); let _ = writeln!(s, "  (fp_line (start {} {}) (end {} {}) (stroke (width 0.1) (type solid)) (layer \"F.Fab\"))", f(a.0), f(a.1), f(b.0), f(b.1)); }
    let _ = writeln!(s, "  (fp_rect (start {} {}) (end {} {}) (stroke (width 0.05) (type solid)) (fill none) (layer \"F.CrtYd\"))", f(-cy.0), f(-cy.1), f(cy.0), f(cy.1));
    // silkscreen: the body's top and bottom edges outside the pads, and a pin 1 mark
    let sy = by + 0.11;
    let pad_x_in = pads.iter().filter(|p| p.y.abs() < by).map(|p| p.x.abs() - p.w / 2.0).fold(f64::MAX, f64::min) - 0.2;
    let sx = if style == Style::Chip { 0.0 } else { bx.min(pad_x_in).max(0.0) };
    if style == Style::Chip { let _ = writeln!(s, "  (fp_line (start {} {}) (end {} {}) (stroke (width 0.12) (type solid)) (layer \"F.SilkS\"))\n  (fp_line (start {} {}) (end {} {}) (stroke (width 0.12) (type solid)) (layer \"F.SilkS\"))", f(-bx * 0.3), f(-sy), f(bx * 0.3), f(-sy), f(-bx * 0.3), f(sy), f(bx * 0.3), f(sy)); }
    else if matches!(style, Style::GullWing2 | Style::NoLead2) {
        let _ = writeln!(s, "  (fp_line (start {} {}) (end {} {}) (stroke (width 0.12) (type solid)) (layer \"F.SilkS\"))\n  (fp_line (start {} {}) (end {} {}) (stroke (width 0.12) (type solid)) (layer \"F.SilkS\"))", f(-sx), f(-sy), f(sx), f(-sy), f(-sx), f(sy), f(sx), f(sy));
    }
    if let Some(p1) = pads.first() { if style != Style::Chip { let _ = writeln!(s, "  (fp_circle (center {} {}) (end {} {}) (stroke (width 0.12) (type solid)) (fill solid) (layer \"F.SilkS\"))", f(p1.x - p1.w / 2.0 - 0.35), f(p1.y), f(p1.x - p1.w / 2.0 - 0.25), f(p1.y)); } }
    let _ = writeln!(s, "  (fp_text user \"${{REFERENCE}}\" (at 0 0 0) (layer \"F.Fab\") (effects (font (size {} {}) (thickness 0.1))))", f((body_x.min(body_y) * 0.25).clamp(0.3, 1.0)), f((body_x.min(body_y) * 0.25).clamp(0.3, 1.0)));
    for p in &pads {
        let _ = writeln!(s, "  (pad \"{}\" smd roundrect (at {} {}) (size {} {}) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\") (roundrect_rratio 0.25))", p.num, f(p.x), f(p.y), f(p.w), f(p.h));
    }
    s.push_str(")\n");
    Ok(Land { name, kicad_mod: s, pads: n_pads, courtyard: [r2(2.0 * cy.0), r2(2.0 * cy.1)] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soic8_matches_kicads_footprint() {
        // JEDEC MS-012AA as a datasheet gives it
        let d = Dims { a: Some(1.75), d: Some(4.9), e1: Some(3.9), e_span: Some(6.0), pitch: Some(1.27), b: Some(0.41), l: Some(0.835), ..Default::default() };
        let land = land(Style::GullWing2, 8, &d, "SOIC-8").unwrap();
        assert_eq!(land.pads, 8);
        assert_eq!(land.name, "SOIC-8_3.9x4.9mm_P1.27mm");
        // KiCad's SOIC-8_3.9x4.9mm_P1.27mm: pads 1.95 x 0.6 at x = ±2.475, pin 1 at (-2.475, -1.905)
        let fp = super::super::footprint::parse(&land.kicad_mod).unwrap();
        let p1 = fp.pads.iter().find(|p| p.num == "1").unwrap();
        assert!((p1.x + 2.475).abs() < 0.15, "pin 1 x {}", p1.x);
        assert!((p1.y - 1.905).abs() < 1e-6, "pin 1 y {}", p1.y);   // model frame: y up
        assert!((p1.w - 1.95).abs() < 0.3, "pad length {}", p1.w);
        let p5 = fp.pads.iter().find(|p| p.num == "5").unwrap();
        assert!(p5.x > 2.0 && p5.y < 0.0, "pin 5 is bottom right");
        // and a model drawn on it lands on its pads
        let g = super::super::generate(&land.kicad_mod, Some(&d)).unwrap();
        assert_eq!(g.height, 1.75);
    }

    #[test]
    fn qfn_with_exposed_pad_and_bad_numbers() {
        let d = Dims { a: Some(0.9), d: Some(5.0), e1: Some(5.0), pitch: Some(0.5), b: Some(0.25), l: Some(0.4), d2: Some(3.45), e2: Some(3.45), ..Default::default() };
        let land = land(Style::NoLead4, 32, &d, "QFN-32-1EP").unwrap();
        assert_eq!(land.pads, 33);
        let fp = super::super::footprint::parse(&land.kicad_mod).unwrap();
        // KiCad's QFN-32-1EP_5x5mm_P0.5mm: side pads centred at ±2.4375 (0.875 long)
        let p1 = fp.pads.iter().find(|p| p.num == "1").unwrap();
        assert!((p1.x + 2.45).abs() < 0.15, "pin 1 x {}", p1.x);
        assert!((p1.y - 1.75).abs() < 1e-6);
        let p9 = fp.pads.iter().find(|p| p.num == "9").unwrap();
        assert!(p9.y < -2.0 && p9.x < 0.0, "pin 9 starts the bottom row at the left");
        // 32 pins at 0.8 mm do not fit a 5 mm body
        let bad = Dims { pitch: Some(0.8), ..d.clone() };
        assert!(land_err(Style::NoLead4, 32, &bad).iter().any(|w| w.contains("more than the body")));
        // a missing number is named
        let none = Dims { b: None, ..d };
        assert!(land_err(Style::NoLead4, 32, &none).iter().any(|w| w.contains("b missing")));
    }

    fn land_err(s: Style, n: usize, d: &Dims) -> Vec<String> { land(s, n, d, "X").err().unwrap_or_default() }

    #[test]
    fn chip_0603() {
        let d = Dims { d: Some(1.6), e1: Some(0.8), a: Some(0.8), ..Default::default() };
        let land = land(Style::Chip, 2, &d, "C_0603").unwrap();
        let fp = super::super::footprint::parse(&land.kicad_mod).unwrap();
        // KiCad's C_0603_1608Metric: pads 0.9 x 0.95 at ±0.775
        assert!((fp.pads[1].x - 0.775).abs() < 0.15, "{}", fp.pads[1].x);
    }
}
