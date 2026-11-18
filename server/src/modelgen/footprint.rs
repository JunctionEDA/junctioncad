//! What a model generator needs from a footprint: its pads, its fabrication outline and courtyard,
//! its name and the part's fields, read from a `.kicad_mod` file or a `(footprint …)` taken out of a
//! board.  Everything is turned into KiCad's 3D model frame (millimetres, X right, Y up), so a model
//! drawn over these pads lands on them with no offset or turn.  A board's footprint on the back is
//! stored mirrored; it is mirrored back here, since a model is always drawn for the front.

use std::collections::HashMap;

use crate::libs::{parse_sexpr, Sx};

#[derive(Clone, Debug)]
pub struct Pad {
    pub num: String,
    pub x: f64,
    pub y: f64,
    /// size along X and Y once the pad's own turn is applied
    pub w: f64,
    pub h: f64,
    /// drill diameter (the larger side of a slot)
    pub drill: Option<f64>,
    #[allow(dead_code)]
    pub shape: String,
    /// on copper (a mechanical hole or a paste-only pad has no lead)
    pub copper: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Rect { pub x0: f64, pub y0: f64, pub x1: f64, pub y1: f64 }

impl Rect {
    pub fn w(&self) -> f64 { self.x1 - self.x0 }
    pub fn h(&self) -> f64 { self.y1 - self.y0 }
    pub fn cx(&self) -> f64 { (self.x0 + self.x1) / 2.0 }
    pub fn cy(&self) -> f64 { (self.y0 + self.y1) / 2.0 }
    pub fn centred(cx: f64, cy: f64, w: f64, h: f64) -> Rect { Rect { x0: cx - w / 2.0, y0: cy - h / 2.0, x1: cx + w / 2.0, y1: cy + h / 2.0 } }
    pub fn grow(&self, d: f64) -> Rect { Rect { x0: self.x0 - d, y0: self.y0 - d, x1: self.x1 + d, y1: self.y1 + d } }
    pub fn of(pts: impl IntoIterator<Item = (f64, f64)>) -> Option<Rect> {
        let mut r: Option<Rect> = None;
        for (x, y) in pts {
            r = Some(match r { None => Rect { x0: x, y0: y, x1: x, y1: y }, Some(r) => Rect { x0: r.x0.min(x), y0: r.y0.min(y), x1: r.x1.max(x), y1: r.y1.max(y) } });
        }
        r
    }
}

#[derive(Clone, Debug, Default)]
pub struct Footprint {
    /// "Library:Name" as written, or the bare name of a library file
    pub id: String,
    /// the name without its library
    pub name: String,
    pub descr: String,
    pub tags: String,
    pub smd: bool,
    pub tht: bool,
    pub pads: Vec<Pad>,
    /// corners of everything drawn on the fabrication layer
    pub fab: Vec<(f64, f64)>,
    /// the largest circle on the fabrication (else silkscreen) layer: (x, y, r)
    pub fab_circle: Option<(f64, f64, f64)>,
    pub courtyard: Vec<(f64, f64)>,
    /// the part's fields (Reference, Value, Datasheet, MPN, LCSC …), as the board holds them
    pub fields: HashMap<String, String>,
}

impl Footprint {
    pub fn fab_box(&self) -> Option<Rect> { Rect::of(self.fab.iter().copied()).filter(|r| r.w() > 0.2 && r.h() > 0.2) }
    pub fn courtyard_box(&self) -> Option<Rect> { Rect::of(self.courtyard.iter().copied()).filter(|r| r.w() > 0.2 && r.h() > 0.2) }
    pub fn copper_pads(&self) -> impl Iterator<Item = &Pad> { self.pads.iter().filter(|p| p.copper) }
    pub fn pad_box(&self) -> Option<Rect> {
        let mut r: Option<Rect> = None;
        for p in self.copper_pads() {
            let b = Rect::centred(p.x, p.y, p.w, p.h);
            r = Some(match r { None => b, Some(r) => Rect { x0: r.x0.min(b.x0), y0: r.y0.min(b.y0), x1: r.x1.max(b.x1), y1: r.y1.max(b.y1) } });
        }
        r
    }
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).filter(|v| !v.trim().is_empty() && *v != "~")
    }
    pub fn reference_prefix(&self) -> String {
        self.field("Reference").unwrap_or("").chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_uppercase()
    }
}

fn num(s: Option<&str>) -> Option<f64> { s.and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()) }

fn xy(node: &Sx, head: &str) -> Option<(f64, f64)> {
    let k = node.list(head)?;
    Some((num(k.arg(1))?, num(k.arg(2))?))
}

/// The first `(footprint …)` (or old `(module …)`) in `text`.
pub fn parse(text: &str) -> Option<Footprint> {
    let top = parse_sexpr(text);
    let node = top.iter().find(|n| n.head() == "footprint" || n.head() == "module")?;
    Some(read(node))
}

fn read(node: &Sx) -> Footprint {
    let id = node.arg(1).unwrap_or("").to_string();
    let name = id.rsplit(':').next().unwrap_or("").to_string();
    let back = node.list("layer").and_then(|l| l.arg(1)).map(|l| l.starts_with("B.")).unwrap_or(false);
    let fp_angle = node.list("at").and_then(|a| num(a.arg(3))).unwrap_or(0.0);
    // file y runs down; the model frame's y up.  A back footprint is stored mirrored top to bottom.
    let my = |y: f64| if back { y } else { -y };
    let mut fp = Footprint { id, name, ..Default::default() };
    fp.descr = node.list("descr").and_then(|d| d.arg(1)).unwrap_or("").to_string();
    fp.tags = node.list("tags").and_then(|d| d.arg(1)).unwrap_or("").to_string();
    if let Some(a) = node.list("attr") {
        for c in a.children().iter().skip(1) { match c.atom() { Some("smd") => fp.smd = true, Some("through_hole") => fp.tht = true, _ => {} } }
    }
    for c in node.children() {
        match c.head() {
            "property" => { if let (Some(k), Some(v)) = (c.arg(1), c.arg(2)) { fp.fields.insert(k.to_string(), v.to_string()); } }
            "fp_text" => {
                let kind = c.arg(1).unwrap_or("");
                if kind == "reference" || kind == "value" { if let Some(v) = c.arg(2) { fp.fields.insert(if kind == "reference" { "Reference".into() } else { "Value".into() }, v.to_string()); } }
            }
            "pad" => {
                let (x, y) = xy(c, "at").unwrap_or((0.0, 0.0));
                let angle = c.list("at").and_then(|a| num(a.arg(3))).unwrap_or(0.0);
                let size = c.list("size");
                let (mut w, mut h) = (num(size.and_then(|s| s.arg(1))).unwrap_or(0.0), num(size.and_then(|s| s.arg(2))).unwrap_or(0.0));
                if h == 0.0 { h = w; }
                // a board stores a pad's angle with the footprint's added; a quarter turn swaps the sides
                let local = ((angle - fp_angle) % 180.0 + 180.0) % 180.0;
                if (local - 90.0).abs() < 1.0 { std::mem::swap(&mut w, &mut h); }
                else if local > 1.0 && local < 179.0 { let a = local.to_radians(); let (ww, hh) = (w * a.cos().abs() + h * a.sin().abs(), w * a.sin().abs() + h * a.cos().abs()); w = ww; h = hh; }
                let kind = c.arg(2).unwrap_or("");
                let drill = c.list("drill").map(|d| {
                    let vals: Vec<f64> = d.children().iter().skip(1).filter_map(|a| a.atom()).filter_map(|a| a.parse::<f64>().ok()).collect();
                    vals.iter().cloned().fold(0.0, f64::max)
                }).filter(|d| *d > 0.0);
                let layers: Vec<String> = c.list("layers").map(|l| l.children().iter().skip(1).filter_map(|a| a.atom()).map(|s| s.to_string()).collect()).unwrap_or_default();
                let copper = kind != "np_thru_hole" && (layers.is_empty() || layers.iter().any(|l| l.ends_with(".Cu")));
                fp.pads.push(Pad { num: c.arg(1).unwrap_or("").to_string(), x, y: my(y), w, h, drill: if kind == "thru_hole" || kind == "np_thru_hole" { drill } else { None }, shape: c.arg(3).unwrap_or("").to_string(), copper });
            }
            "fp_line" | "fp_rect" | "fp_circle" | "fp_arc" | "fp_poly" => {
                let layer = c.list("layer").and_then(|l| l.arg(1)).unwrap_or("");
                let layer = layer.trim_start_matches("F.").trim_start_matches("B.");
                let mut pts: Vec<(f64, f64)> = Vec::new();
                for h in ["start", "end", "mid"] { if let Some(p) = xy(c, h) { pts.push(p); } }
                if let Some(p) = c.list("pts") { for k in p.lists("xy") { if let (Some(x), Some(y)) = (num(k.arg(1)), num(k.arg(2))) { pts.push((x, y)); } } }
                let mut circle = None;
                if c.head() == "fp_circle" {
                    if let (Some(cen), Some(e)) = (xy(c, "center"), xy(c, "end")) {
                        let r = ((e.0 - cen.0).powi(2) + (e.1 - cen.1).powi(2)).sqrt();
                        pts = vec![(cen.0 - r, cen.1 - r), (cen.0 + r, cen.1 + r)];
                        circle = Some((cen.0, my(cen.1), r));
                    }
                }
                if c.head() == "fp_rect" {
                    if let (Some(a), Some(b)) = (xy(c, "start"), xy(c, "end")) { pts = vec![a, b, (a.0, b.1), (b.0, a.1)]; }
                }
                let pts = pts.into_iter().map(|(x, y)| (x, my(y)));
                match layer {
                    "Fab" => {
                        fp.fab.extend(pts);
                        if let Some(ci) = circle { if fp.fab_circle.map(|o| o.2 < ci.2).unwrap_or(true) { fp.fab_circle = Some(ci); } }
                    }
                    "CrtYd" => fp.courtyard.extend(pts),
                    "SilkS" => { if fp.fab.is_empty() { if let Some(ci) = circle { if fp.fab_circle.map(|o| o.2 < ci.2).unwrap_or(true) { fp.fab_circle = Some(ci); } } } }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // thermal vias: small drilled pads sharing the number of a surface pad (an exposed pad's vias) carry no lead
    let smd_nums: std::collections::HashSet<String> = fp.pads.iter().filter(|p| p.drill.is_none() && p.copper).map(|p| p.num.clone()).collect();
    for p in fp.pads.iter_mut() {
        if p.drill.map(|d| d <= 0.6).unwrap_or(false) && (p.num.is_empty() || smd_nums.contains(&p.num)) { p.copper = false; }
    }
    // no attribute (an old file): through-hole if any copper pad is drilled
    if !fp.smd && !fp.tht { if fp.pads.iter().any(|p| p.copper && p.drill.is_some()) { fp.tht = true; } else { fp.smd = true; } }
    fp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_library_and_board_footprints() {
        let lib = r#"(footprint "SOIC-8_3.9x4.9mm_P1.27mm" (version 20240108) (layer "F.Cu") (descr "SOIC, 8 Pin (JEDEC MS-012AA, https://www.analog.com/media/en/package-pcb-resources/package/pkg_pdf/soic_narrow-r/r_8.pdf)") (attr smd)
          (fp_line (start -1.95 -2.45) (end 1.95 -2.45) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
          (fp_line (start 1.95 2.45) (end -1.95 2.45) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
          (fp_rect (start -3.7 -2.7) (end 3.7 2.7) (layer "F.CrtYd"))
          (pad "1" smd roundrect (at -2.475 -1.905) (size 1.95 0.6) (layers "F.Cu" "F.Paste" "F.Mask"))
          (pad "8" smd roundrect (at 2.475 -1.905) (size 1.95 0.6) (layers "F.Cu" "F.Paste" "F.Mask")))"#;
        let fp = parse(lib).unwrap();
        assert!(fp.smd && !fp.tht);
        assert_eq!(fp.pads.len(), 2);
        assert_eq!((fp.pads[0].x, fp.pads[0].y), (-2.475, 1.905));   // y up
        let fab = fp.fab_box().unwrap();
        assert!((fab.w() - 3.9).abs() < 1e-9 && (fab.h() - 4.9).abs() < 1e-9);
        assert!((fp.courtyard_box().unwrap().w() - 7.4).abs() < 1e-9);
        // the same pads on a board, the footprint turned a quarter and on the back
        let board = r#"(footprint "Package_SO:SOIC-8" (layer "B.Cu") (at 10 20 90)
          (property "Reference" "U3") (property "Datasheet" "https://x/y.pdf")
          (pad "1" smd roundrect (at -2.475 1.905 180) (size 1.95 0.6) (layers "B.Cu")))"#;
        let fp = parse(board).unwrap();
        assert_eq!((fp.pads[0].x, fp.pads[0].y), (-2.475, 1.905));
        assert_eq!((fp.pads[0].w, fp.pads[0].h), (0.6, 1.95));
        assert_eq!(fp.reference_prefix(), "U");
        assert_eq!(fp.field("datasheet"), Some("https://x/y.pdf"));
    }
}
