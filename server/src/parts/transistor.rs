//! Vendor transistors redrawn as KiCad's own transistor symbols.
//!
//! EasyEDA draws every transistor by hand, each a little differently.  When the
//! part plainly is a single MOSFET or bipolar transistor, the drawing is replaced
//! by KiCad's `Device:Q_NMOS`, `Q_PMOS`, `Q_NPN` or `Q_PNP` (graphics copied from
//! the KiCad symbol library, CC-BY-SA 4.0 with the library exception), and each
//! of the vendor's pin numbers goes on the terminal the vendor drew it on.
//!
//! Which terminal a pin is comes from its name (G/D/S, B/C/E).  A bipolar
//! transistor whose pins are only numbered is read from the vendor's drawing
//! instead: the base is the pin entering from the side, the emitter the one
//! beside the arrow.  The polarity comes from the listing's description when it
//! says so ("N-Channel", "PNP"), otherwise from the arrow the vendor drew.
//! Anything that is not certain keeps the vendor's drawing.

use super::easyeda::{fnum, q};
use super::tidy::RawPin;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Nmos,
    Pmos,
    Npn,
    Pnp,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Nmos => "N-channel MOSFET",
            Kind::Pmos => "P-channel MOSFET",
            Kind::Npn => "NPN transistor",
            Kind::Pnp => "PNP transistor",
        }
    }
}

const NMOS: &[&str] = &[
    r#"(polyline (pts (xy 0.254 1.905) (xy 0.254 -1.905)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.254 0) (xy -2.54 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 2.286) (xy 0.762 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 0.508) (xy 0.762 -0.508)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 -1.27) (xy 0.762 -2.286)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 -1.778) (xy 3.302 -1.778) (xy 3.302 1.778) (xy 0.762 1.778)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 1.016 0) (xy 2.032 0.381) (xy 2.032 -0.381) (xy 1.016 0)) (stroke (width 0) (type default)) (fill (type outline)))"#,
    r#"(circle (center 1.651 0) (radius 2.794) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 2.54 2.54) (xy 2.54 1.778)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(circle (center 2.54 1.778) (radius 0.254) (stroke (width 0) (type default)) (fill (type outline)))"#,
    r#"(circle (center 2.54 -1.778) (radius 0.254) (stroke (width 0) (type default)) (fill (type outline)))"#,
    r#"(polyline (pts (xy 2.54 -2.54) (xy 2.54 0) (xy 0.762 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 2.921 0.381) (xy 3.683 0.381)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 3.302 0.381) (xy 2.921 -0.254) (xy 3.683 -0.254) (xy 3.302 0.381)) (stroke (width 0) (type default)) (fill (type none)))"#,
];
const PMOS: &[&str] = &[
    r#"(polyline (pts (xy 0.254 1.905) (xy 0.254 -1.905)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.254 0) (xy -2.54 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 2.286) (xy 0.762 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 1.778) (xy 3.302 1.778) (xy 3.302 -1.778) (xy 0.762 -1.778)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 0.508) (xy 0.762 -0.508)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.762 -1.27) (xy 0.762 -2.286)) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(circle (center 1.651 0) (radius 2.794) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 2.286 0) (xy 1.27 0.381) (xy 1.27 -0.381) (xy 2.286 0)) (stroke (width 0) (type default)) (fill (type outline)))"#,
    r#"(polyline (pts (xy 2.54 2.54) (xy 2.54 1.778)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(circle (center 2.54 1.778) (radius 0.254) (stroke (width 0) (type default)) (fill (type outline)))"#,
    r#"(circle (center 2.54 -1.778) (radius 0.254) (stroke (width 0) (type default)) (fill (type outline)))"#,
    r#"(polyline (pts (xy 2.54 -2.54) (xy 2.54 0) (xy 0.762 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 2.921 -0.381) (xy 3.683 -0.381)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 3.302 -0.381) (xy 2.921 0.254) (xy 3.683 0.254) (xy 3.302 -0.381)) (stroke (width 0) (type default)) (fill (type none)))"#,
];
const NPN: &[&str] = &[
    r#"(polyline (pts (xy -2.54 0) (xy 0.635 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.635 1.905) (xy 0.635 -1.905)) (stroke (width 0.508) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.635 0.635) (xy 2.54 2.54)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.635 -0.635) (xy 2.54 -2.54)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(circle (center 1.27 0) (radius 2.8194) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 1.27 -1.778) (xy 1.778 -1.27) (xy 2.286 -2.286) (xy 1.27 -1.778)) (stroke (width 0) (type default)) (fill (type outline)))"#,
];
const PNP: &[&str] = &[
    r#"(polyline (pts (xy -2.54 0) (xy 0.635 0)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.635 1.905) (xy 0.635 -1.905)) (stroke (width 0.508) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.635 0.635) (xy 2.54 2.54)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 0.635 -0.635) (xy 2.54 -2.54)) (stroke (width 0) (type default)) (fill (type none)))"#,
    r#"(circle (center 1.27 0) (radius 2.8194) (stroke (width 0.254) (type default)) (fill (type none)))"#,
    r#"(polyline (pts (xy 2.286 -1.778) (xy 1.778 -2.286) (xy 1.27 -1.27) (xy 2.286 -1.778)) (stroke (width 0) (type default)) (fill (type outline)))"#,
];

pub struct Redrawn {
    pub kind: Kind,
    /// The unit's contents: KiCad's graphics and the three pins.
    pub unit: String,
    pub bbox: [f64; 4],
}

type Tri = [[f64; 2]; 3];

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// The arrowhead's tip: the corner opposite its shortest edge.
fn tip(t: &Tri) -> ([f64; 2], [f64; 2]) {
    let e = [dist(t[1], t[2]), dist(t[0], t[2]), dist(t[0], t[1])];
    let k = (0..3).min_by(|&a, &b| e[a].partial_cmp(&e[b]).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(0);
    let (a, b) = (t[(k + 1) % 3], t[(k + 2) % 3]);
    (t[k], [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0])
}

/// What the listing says the part is: (is a MOSFET, is N type), when it says one thing only.
fn polarity_from_text(hint: &str) -> Option<bool> {
    let h = hint.to_ascii_uppercase().replace(['-', '_'], " ");
    let has = |keys: &[&str]| keys.iter().any(|k| h.contains(k));
    let n = has(&["N CHANNEL", "NCHANNEL", "N CH ", "NMOS", "N MOS", "NPN"]);
    let p = has(&["P CHANNEL", "PCHANNEL", "P CH ", "PMOS", "P MOS", "PNP"]);
    match (n, p) {
        (true, false) => Some(true),
        (false, true) => Some(false),
        _ => None,
    }
}

/// Redraw a single MOSFET or bipolar transistor, or `None` to keep the vendor's drawing.
/// `tris` are the filled triangles of the drawing (arrowheads), in symbol coordinates.
pub fn redraw(pins: &[RawPin], tris: &[Tri], prefix: &str, hint: &str) -> Option<Redrawn> {
    let pfx = prefix.trim_end_matches('?').to_ascii_uppercase();
    if !(pfx == "Q" || pfx == "T" || pfx == "VT" || pfx == "M") || pins.len() != 3 {
        return None;
    }
    let name = |p: &RawPin| p.name.trim().to_ascii_uppercase();
    let find = |n: &str| pins.iter().position(|p| name(p) == n);
    let horizontal = |p: &RawPin| p.angle == 0 || p.angle == 180;
    let at = |p: &RawPin| [p.x, p.y];
    let text = polarity_from_text(hint);

    // (control, top, bottom) pins: gate/drain/source or base/collector/emitter
    let (mos, ctl, hi, lo, n_type) = if let (Some(g), Some(d), Some(s)) = (find("G"), find("D"), find("S")) {
        // the arrow on the substrate lies along the gate's axis and points at the channel for N
        let gate = at(&pins[g]);
        let arrow = tris.iter().map(tip).filter(|(t, b)| (t[1] - b[1]).abs() < (t[0] - b[0]).abs()).min_by(|a, b| dist(a.0, gate).partial_cmp(&dist(b.0, gate)).unwrap_or(std::cmp::Ordering::Equal));
        let drawn = arrow.map(|(t, b)| dist(t, gate) < dist(b, gate));
        (true, g, d, s, text.or(drawn)?)
    } else {
        let named = (find("B"), find("C"), find("E"));
        let arrow = tris.first().map(tip);
        let (b, c, e) = if let (Some(b), Some(c), Some(e)) = named {
            (b, c, e)
        } else if pins.iter().all(|p| name(p).chars().all(|c| c.is_ascii_digit())) && pfx != "M" {
            // numbered pins only: read the terminals off the drawing
            let (t, _) = arrow?;
            let b = pins.iter().position(horizontal)?;
            let mut rest: Vec<usize> = (0..3).filter(|&i| i != b).collect();
            if rest.iter().any(|&i| horizontal(&pins[i])) {
                return None;
            }
            rest.sort_by(|&x, &y| dist(at(&pins[x]), t).partial_cmp(&dist(at(&pins[y]), t)).unwrap_or(std::cmp::Ordering::Equal));
            (b, rest[1], rest[0])
        } else {
            return None;
        };
        // the emitter's arrow points away from the base for NPN
        let base = at(&pins[b]);
        let drawn = arrow.map(|(t, m)| dist(t, base) > dist(m, base));
        (false, b, c, e, text.or(drawn)?)
    };
    let kind = match (mos, n_type) {
        (true, true) => Kind::Nmos,
        (true, false) => Kind::Pmos,
        (false, true) => Kind::Npn,
        (false, false) => Kind::Pnp,
    };
    let art = match kind {
        Kind::Nmos => NMOS,
        Kind::Pmos => PMOS,
        Kind::Npn => NPN,
        Kind::Pnp => PNP,
    };
    let mut unit = String::new();
    for g in art {
        unit.push_str(&format!("\t\t\t{g}\n"));
    }
    let names = if mos { ["G", "D", "S"] } else { ["B", "C", "E"] };
    for (k, (i, (x, y, a, et))) in [(ctl, (-5.08, 0.0, 0, "input")), (hi, (2.54, 5.08, 270, "passive")), (lo, (2.54, -5.08, 90, "passive"))].into_iter().enumerate() {
        unit.push_str(&format!(
            "\t\t\t(pin {et} line (at {} {} {a}) (length 2.54) (name {} (effects (font (size 1.27 1.27)))) (number {} (effects (font (size 1.27 1.27)))))\n",
            fnum(x),
            fnum(y),
            q(names[k]),
            q(&pins[i].number),
        ));
    }
    Some(Redrawn { kind, unit, bbox: [-5.08, -5.08, 4.445, 5.08] })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(name: &str, number: &str, x: f64, y: f64, angle: i32) -> RawPin {
        RawPin { etype: "passive".into(), style: "line".into(), name: name.into(), number: number.into(), x, y, angle }
    }
    fn number_on(r: &Redrawn, terminal: &str) -> String {
        let l = r.unit.lines().find(|l| l.contains(&format!("(name \"{terminal}\""))).unwrap();
        l.split("(number \"").nth(1).unwrap().split('"').next().unwrap().to_string()
    }

    #[test]
    fn mosfet_pins_follow_their_names_and_the_listing_decides_the_channel() {
        let pins = vec![pin("D", "3", 0.0, 5.0, 270), pin("G", "1", -7.0, 0.0, 0), pin("S", "2", 0.0, -5.0, 90)];
        let r = redraw(&pins, &[], "Q?", "30V 5.7A N-Channel SOT-23 MOSFETs").unwrap();
        assert_eq!(r.kind, Kind::Nmos);
        assert_eq!((number_on(&r, "G"), number_on(&r, "D"), number_on(&r, "S")), ("1".into(), "3".into(), "2".into()));
        assert_eq!(redraw(&pins, &[], "Q", "P-Channel 30V").unwrap().kind, Kind::Pmos);
        // nothing says which: the vendor's drawing stays
        assert!(redraw(&pins, &[], "Q", "AO3400A").is_none());
        // an arrow pointing at the gate side is N, away from it P
        let toward: Tri = [[-2.5, 0.0], [-1.0, 0.5], [-1.0, -0.5]];
        let away: Tri = [[0.0, 0.0], [-1.5, 0.5], [-1.5, -0.5]];
        assert_eq!(redraw(&pins, &[toward], "Q", "").unwrap().kind, Kind::Nmos);
        assert_eq!(redraw(&pins, &[away], "Q", "").unwrap().kind, Kind::Pmos);
    }

    #[test]
    fn numbered_bjt_is_read_from_the_drawing() {
        // base from the left, collector up, emitter down with the arrow at its outer end (NPN)
        let pins = vec![pin("1", "1", -5.0, 0.0, 0), pin("3", "3", 0.0, 5.0, 270), pin("2", "2", 0.0, -5.0, 90)];
        let arrow: Tri = [[0.0, -2.5], [-0.8, -1.3], [-1.5, -2.3]];
        let r = redraw(&pins, &[arrow], "Q", "").unwrap();
        assert_eq!(r.kind, Kind::Npn);
        assert_eq!((number_on(&r, "B"), number_on(&r, "C"), number_on(&r, "E")), ("1".into(), "3".into(), "2".into()));
        // four pins, or a part that is not a transistor: left alone
        assert!(redraw(&pins[..2], &[arrow], "Q", "NPN").is_none());
        assert!(redraw(&pins, &[arrow], "U", "NPN").is_none());
    }
}
