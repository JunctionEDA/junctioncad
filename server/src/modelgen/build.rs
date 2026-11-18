//! Draws a package from its spec (package.rs) over its footprint's pads: the body, then a lead or a
//! terminal for every pad, each where the pad is, so the model lands on the footprint by construction.
//! Shapes follow KiCad's own generated library models (kicad-packages3D-generator): moulded bodies with
//! a drawn-in top edge, gull-wing leads bent down onto the pads, terminals in the underside of leadless
//! parts, tinned end caps on chips, a pin 1 dimple.

use super::footprint::{Footprint, Pad, Rect};
use super::package::{Family, Spec};
use super::solid::{chamfered, circle, colour as C, moulded, rect, Rgb, Solid, P2, V3};

/// Through-hole leads reach this far below the board's top face (a 1.6 mm board plus the clinched end).
const LEAD_BELOW: f64 = 3.0;

pub fn solids(spec: &Spec, fp: &Footprint) -> Vec<Solid> {
    let mut out: Vec<Solid> = Vec::new();
    let pads: Vec<&Pad> = fp.copper_pads().collect();
    match spec.family {
        Family::Chip => chip(spec, &pads, &mut out),
        Family::Molded2 => molded2(spec, fp, &pads, &mut out),
        Family::Melf => melf(spec, &pads, &mut out),
        Family::GullWing => gull_wing(spec, fp, &pads, &mut out),
        Family::NoLead => no_lead(spec, &pads, &mut out),
        Family::Bga => bga(spec, &pads, &mut out),
        Family::Crystal => crystal(spec, &pads, &mut out),
        Family::ElectrolyticSmd => electrolytic(spec, &pads, &mut out),
        Family::LedPackage => led_package(spec, &pads, &mut out),
        Family::Inductor => inductor(spec, &pads, &mut out),
        Family::Switch => switch(spec, &pads, &mut out),
        Family::UsbC => usb_c(spec, &pads, &mut out),
        Family::Dip => dip(spec, &pads, &mut out),
        Family::Header => header(spec, fp, &pads, &mut out),
        Family::Axial => axial(spec, fp, &pads, &mut out),
        Family::Radial => radial(spec, fp, &pads, &mut out),
        Family::To220 => to220(spec, fp, &pads, &mut out),
        Family::To92 => to92(spec, &pads, &mut out),
        Family::Generic => generic(spec, fp, &pads, &mut out),
    }
    out
}

fn pad_rect(p: &Pad) -> Rect { Rect::centred(p.x, p.y, p.w, p.h) }

fn inter(a: &Rect, b: &Rect) -> Option<Rect> {
    let r = Rect { x0: a.x0.max(b.x0), y0: a.y0.max(b.y0), x1: a.x1.min(b.x1), y1: a.y1.min(b.y1) };
    if r.w() > 0.02 && r.h() > 0.02 { Some(r) } else { None }
}

fn pad_one<'a>(pads: &[&'a Pad]) -> Option<&'a Pad> {
    pads.iter().copied().find(|p| p.num == "1" || p.num.eq_ignore_ascii_case("A1")).or_else(|| pads.first().copied())
}

/// A shallow pin 1 dimple on the body's top, in the corner nearest pad 1.
fn pin_one(body: &Rect, top: f64, pads: &[&Pad], out: &mut Vec<Solid>) {
    let Some(p1) = pad_one(pads) else { return };
    let r = (body.w().min(body.h()) * 0.07).clamp(0.12, 0.5);
    let x = if p1.x < body.cx() - 0.01 { body.x0 + 2.2 * r } else if p1.x > body.cx() + 0.01 { body.x1 - 2.2 * r } else { body.cx() };
    let y = if p1.y < body.cy() - 0.01 { body.y0 + 2.2 * r } else if p1.y > body.cy() + 0.01 { body.y1 - 2.2 * r } else { body.cy() };
    out.extend(Solid::prism("pin1", &circle(x, y, r, 20), top, top + 0.01, C::PIN1_GREY));
}

/// Which side of `body` a pad lies beyond: outward unit vector, or None when it is under the body.
fn side_of(body: &Rect, p: &Pad) -> Option<(f64, f64)> {
    let dx = if p.x > body.x1 { p.x - body.x1 } else if p.x < body.x0 { body.x0 - p.x } else { 0.0 };
    let dy = if p.y > body.y1 { p.y - body.y1 } else if p.y < body.y0 { body.y0 - p.y } else { 0.0 };
    if dx <= 0.0 && dy <= 0.0 {
        // the pad centre is under the body; still a side pad if its outer edge sticks out
        let ox = (p.x + p.w / 2.0 - body.x1).max(body.x0 - (p.x - p.w / 2.0));
        let oy = (p.y + p.h / 2.0 - body.y1).max(body.y0 - (p.y - p.h / 2.0));
        if ox <= 0.02 && oy <= 0.02 { return None; }
        return Some(if ox >= oy { (if p.x >= body.cx() { 1.0 } else { -1.0 }, 0.0) } else { (0.0, if p.y >= body.cy() { 1.0 } else { -1.0 }) });
    }
    Some(if dx >= dy { (if p.x > body.cx() { 1.0 } else { -1.0 }, 0.0) } else { (0.0, if p.y > body.cy() { 1.0 } else { -1.0 }) })
}

/// Distance from the body edge on side `d` to the pad's far end, the pad's length along d and its width across.
fn reach(body: &Rect, p: &Pad, d: (f64, f64)) -> (f64, f64, f64) {
    if d.0 != 0.0 {
        let edge = if d.0 > 0.0 { body.x1 } else { body.x0 };
        ((p.x - edge) * d.0 + p.w / 2.0, p.w, p.h)
    } else {
        let edge = if d.1 > 0.0 { body.y1 } else { body.y0 };
        ((p.y - edge) * d.1 + p.h / 2.0, p.h, p.w)
    }
}

/// A gull-wing lead: out of the body's side at mid height, bent down, its foot on the pad.
fn gull_lead(body: &Rect, p: &Pad, z_exit: f64, thick: f64, width: Option<f64>, foot: Option<f64>, cap: f64, colour: Rgb, out: &mut Vec<Solid>) {
    let Some(d) = side_of(body, p) else { return };
    let (far, len, across) = reach(body, p, d);
    let w = width.unwrap_or(across * 0.6).min(across * 0.95).max(0.1);
    // the tip stops short of the pad's far end (the toe fillet), and no further out than the package's
    // leads reach (a hand-soldering footprint's long pads do not make the leads longer)
    let tip = (far - (0.18 * len).clamp(0.05, 0.4)).min(cap).max((far - len).max(0.0) + 0.15).max(0.15);
    let foot = foot.unwrap_or((0.55 * len).clamp(0.25, 1.1)).min(tip * 0.75);
    let c = thick;
    let zt = z_exit.max(c * 2.2);
    let (origin, u, a): (V3, V3, V3) = if d.0 != 0.0 {
        let edge = if d.0 > 0.0 { body.x1 } else { body.x0 };
        ([edge, p.y - w / 2.0 * d.0, 0.0], [d.0, 0.0, 0.0], [0.0, d.0, 0.0])
    } else {
        let edge = if d.1 > 0.0 { body.y1 } else { body.y0 };
        ([p.x + w / 2.0 * d.1, edge, 0.0], [0.0, d.1, 0.0], [-d.1, 0.0, 0.0])
    };
    let z: V3 = [0.0, 0.0, 1.0];
    let back = -0.05;
    let prof: Vec<P2> = if tip - foot < 2.0 * c + 0.05 {
        // too short to bend: a flat stub from the body to the pad
        vec![[back, 0.0], [tip, 0.0], [tip, c.max(zt * 0.5)], [back, c.max(zt * 0.5)]]
    } else {
        let tb = (tip - foot) * 0.35;
        let tf = tip - foot;
        vec![[back, zt - c], [tb - 0.2 * c, zt - c], [tf - 0.5 * c, 0.0], [tip, 0.0], [tip, c], [tf + 0.5 * c, c], [tb + 0.2 * c, zt], [back, zt]]
    };
    out.extend(Solid::extrude("lead", &prof, origin, u, z, [a[0] * w, a[1] * w, a[2] * w], colour));
}

/// The part of a pad outside the body as a flat terminal, plus where it meets the body, up its side.
fn flat_tab(body: &Rect, p: &Pad, thick: f64, up: f64, colour: Rgb, out: &mut Vec<Solid>) { flat_tab_cap(body, p, thick, up, f64::MAX, colour, out) }

fn flat_tab_cap(body: &Rect, p: &Pad, thick: f64, up: f64, cap: f64, colour: Rgb, out: &mut Vec<Solid>) {
    let Some(d) = side_of(body, p) else { return };
    let (far, len, across) = reach(body, p, d);
    let w = (across * 0.85).max(0.1);
    let tip = (far - (0.12 * len).clamp(0.03, 0.3)).min(cap).max((far - len).max(0.0) + 0.1).max(0.1);
    let r = if d.0 != 0.0 {
        let e = if d.0 > 0.0 { body.x1 } else { body.x0 };
        Rect { x0: e.min(e + d.0 * tip), x1: e.max(e + d.0 * tip), y0: p.y - w / 2.0, y1: p.y + w / 2.0 }
    } else {
        let e = if d.1 > 0.0 { body.y1 } else { body.y0 };
        Rect { y0: e.min(e + d.1 * tip), y1: e.max(e + d.1 * tip), x0: p.x - w / 2.0, x1: p.x + w / 2.0 }
    };
    out.extend(Solid::cuboid("terminal", r.x0, r.y0, r.x1, r.y1, 0.0, thick, colour));
    if up > thick {
        let s = if d.0 != 0.0 {
            let e = if d.0 > 0.0 { body.x1 } else { body.x0 };
            Rect { x0: e.min(e + d.0 * thick), x1: e.max(e + d.0 * thick), y0: r.y0, y1: r.y1 }
        } else {
            let e = if d.1 > 0.0 { body.y1 } else { body.y0 };
            Rect { y0: e.min(e + d.1 * thick), y1: e.max(e + d.1 * thick), x0: r.x0, x1: r.x1 }
        };
        out.extend(Solid::cuboid("terminal", s.x0, s.y0, s.x1, s.y1, thick, up, colour));
    }
}

/// A pad under the body (an exposed pad, a terminal of a leadless or J-lead part): a thin metal layer
/// where the pad is, so the model has metal on every pad as a real part does.
fn slab_under(body: &Rect, p: &Pad, out: &mut Vec<Solid>) {
    let r = inter(&pad_rect(p), body).unwrap_or_else(|| pad_rect(p));
    let m = 0.04 * r.w().min(r.h());
    out.extend(Solid::cuboid("pad", r.x0 + m, r.y0 + m, r.x1 - m, r.y1 - m, 0.0, 0.05, C::METAL_TIN));
}

/// A through-hole lead: a round wire (or a square post) from `top` down through the board.
fn tht_lead(p: &Pad, top: f64, square: bool, colour: Rgb, out: &mut Vec<Solid>) {
    let d = p.drill.unwrap_or(p.w.min(p.h) * 0.5);
    let s = (d * 0.75).clamp(0.3, 1.2);
    if square { out.extend(Solid::cuboid("pin", p.x - s / 2.0, p.y - s / 2.0, p.x + s / 2.0, p.y + s / 2.0, -LEAD_BELOW, top, colour)); }
    else { out.extend(Solid::prism("lead", &circle(p.x, p.y, s / 2.0, 12), -LEAD_BELOW, top, colour)); }
}

// ---------------------------------------------------------------- SMD families

fn chip(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let along_x = b.w() >= b.h();
    let l = b.w().max(b.h());
    let cap = (0.22 * l).clamp(0.08, 0.6);
    let (body_c, top_c) = match spec.kind.as_str() {
        "R" | "FB" => (C::RESISTOR_BODY, Some(C::RESISTOR_TOP)),
        "C" => (C::CERAMIC, None),
        "L" => (C::INDUCTOR, None),
        "LED" => (C::LED_WHITE, Some(C::LED_LENS)),
        "D" => (C::BODY_BLACK, None),
        "F" => (C::PLASTIC_WHITE, None),
        _ => (C::BODY_BLACK, None),
    };
    let mid = if along_x { Rect { x0: b.x0 + cap, x1: b.x1 - cap, ..b } } else { Rect { y0: b.y0 + cap, y1: b.y1 - cap, ..b } };
    let coat = if top_c.is_some() { (0.08 * h).clamp(0.02, 0.06) } else { 0.0 };
    out.extend(Solid::cuboid("body", mid.x0, mid.y0, mid.x1, mid.y1, 0.0, h - coat, body_c));
    if let Some(tc) = top_c {
        out.extend(Solid::cuboid("top", mid.x0, mid.y0 + if along_x { 0.0 } else { 0.0 }, mid.x1, mid.y1, h - coat, h, tc));
    }
    let (e0, e1) = if along_x { (Rect { x1: b.x0 + cap, ..b }, Rect { x0: b.x1 - cap, ..b }) } else { (Rect { y1: b.y0 + cap, ..b }, Rect { y0: b.y1 - cap, ..b }) };
    // the end caps stand a hair proud of the body, as plated terminations do
    for e in [e0, e1] { let g = e.grow(0.01); out.extend(Solid::cuboid("terminal", g.x0, g.y0, g.x1, g.y1, 0.0, h + 0.01, C::METAL_TIN)); }
    // a chip diode's cathode band (KiCad: pad 1 is the cathode)
    if spec.kind == "D" {
        if let Some(p1) = pad_one(pads) {
            let w = (0.12 * l).max(0.05);
            let r = if along_x { let x = if p1.x < b.cx() { mid.x0 + w } else { mid.x1 - 2.0 * w }; Rect { x0: x, x1: x + w, ..mid } } else { let y = if p1.y < b.cy() { mid.y0 + w } else { mid.y1 - 2.0 * w }; Rect { y0: y, y1: y + w, ..mid } };
            out.extend(Solid::cuboid("band", r.x0, r.y0, r.x1, r.y1, h, h + 0.005, C::PIN1_GREY));
        }
    }
}

fn molded2(spec: &Spec, fp: &Footprint, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let up = fp.name.to_ascii_uppercase();
    let tantalum = up.contains("EIA") || up.starts_with("CP_") || fp.reference_prefix() == "C";
    let colour = if tantalum { C::TANTALUM } else { C::BODY_BLACK };
    let lift = if up.contains("SOD-123") || up.contains("SOD-323") || up.contains("SOD-523") { 0.05 } else { 0.0 };
    out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, lift, h, 0.06 * h, colour));
    let cap = (0.18 * b.w().max(b.h())).clamp(0.2, 0.6);
    for p in pads {
        if side_of(&b, p).is_some() {
            if up.contains("SOD-123") && !up.contains("SOD-123F") { gull_lead(&b, p, h * 0.35, 0.12, None, None, cap, C::METAL_TIN, out); }
            else { flat_tab_cap(&b, p, 0.12, (h * 0.45).min(1.0), cap, C::METAL_TIN, out); }
        } else {
            // a terminal under the body (SMA's J-bend, PowerDI's tab): show its edge
            if let Some(r) = inter(&pad_rect(p), &b.grow(0.02)) { out.extend(Solid::cuboid("terminal", r.x0, r.y0, r.x1, r.y1, 0.0, 0.05, C::METAL_TIN)); }
        }
    }
    // polarity band at pad 1's end: the cathode of a diode, the anode of a tantalum
    if let Some(p1) = pad_one(pads) {
        let along_x = b.w() >= b.h();
        let w = (0.14 * b.w().max(b.h())).max(0.08);
        let inset = 0.06 * h;
        let r = if along_x { let x = if p1.x < b.cx() { b.x0 + inset + 0.6 * w } else { b.x1 - inset - 1.6 * w }; Rect { x0: x, x1: x + w, y0: b.y0 + inset, y1: b.y1 - inset } } else { let y = if p1.y < b.cy() { b.y0 + inset + 0.6 * w } else { b.y1 - inset - 1.6 * w }; Rect { y0: y, y1: y + w, x0: b.x0 + inset, x1: b.x1 - inset } };
        out.extend(Solid::cuboid("band", r.x0, r.y0, r.x1, r.y1, h, h + 0.005, if tantalum { Rgb(0.55, 0.38, 0.12) } else { C::PIN1_GREY }));
    }
}

fn melf(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let r = spec.height / 2.0;
    let along_x = b.w() >= b.h();
    let (a, z) = (if along_x { [[b.x0, b.cy()], [b.x1, b.cy()]] } else { [[b.cx(), b.y0], [b.cx(), b.y1]] }, r);
    let l = b.w().max(b.h());
    let cap = (0.15 * l).clamp(0.2, 0.8);
    let dir = if along_x { [1.0, 0.0] } else { [0.0, 1.0] };
    let at = |t: f64| -> V3 { [a[0][0] + dir[0] * t, a[0][1] + dir[1] * t, z] };
    out.extend(Solid::cylinder("cap", at(0.0), at(cap), r, 24, C::METAL_TIN));
    out.extend(Solid::cylinder("body", at(cap), at(l - cap), r * 0.97, 24, C::GLASS));
    out.extend(Solid::cylinder("cap", at(l - cap), at(l), r, 24, C::METAL_TIN));
    if let Some(p1) = pad_one(pads) {
        let near0 = if along_x { p1.x < b.cx() } else { p1.y < b.cy() };
        let t = if near0 { cap + 0.1 } else { l - cap - 0.1 - 0.25 * l * 0.3 };
        out.extend(Solid::cylinder("band", at(t), at(t + 0.075 * l), r * 0.99, 24, C::BODY_BLACK));
    }
}

fn gull_wing(spec: &Spec, fp: &Footprint, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let (z0, h) = (spec.z0, spec.height);
    let up = fp.name.to_ascii_uppercase();
    out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, z0, h, (0.08 * (h - z0)).clamp(0.03, 0.15), C::BODY_BLACK));
    let thick = ((h - z0) * 0.12).clamp(0.1, 0.2);
    let z_exit = z0 + (h - z0) * 0.42;
    let areas: Vec<f64> = pads.iter().map(|p| p.w * p.h).collect();
    let mut sorted = areas.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let cap = (0.3 * b.w().min(b.h()) + 0.15).clamp(0.4, 1.1);
    let dpak = up.contains("TO-252") || up.contains("TO-263") || up.contains("DPAK") || up.contains("TO-268");
    for (p, area) in pads.iter().zip(areas) {
        let big = area > 3.0 * median && pads.len() > 2;
        if big && dpak {
            // the heat tab: a plate out of the back of the body onto its pad
            if let Some(d) = side_of(&b, p) {
                let (far, ..) = reach(&b, p, d);
                let tip = far - 0.2;
                let r = if d.0 != 0.0 { let e = if d.0 > 0.0 { b.x1 } else { b.x0 }; Rect { x0: (e - d.0 * 1.0).min(e + d.0 * tip), x1: (e - d.0 * 1.0).max(e + d.0 * tip), y0: p.y - p.h * 0.45, y1: p.y + p.h * 0.45 } }
                        else { let e = if d.1 > 0.0 { b.y1 } else { b.y0 }; Rect { y0: (e - d.1 * 1.0).min(e + d.1 * tip), y1: (e - d.1 * 1.0).max(e + d.1 * tip), x0: p.x - p.w * 0.45, x1: p.x + p.w * 0.45 } };
                out.extend(Solid::cuboid("tab", r.x0, r.y0, r.x1, r.y1, 0.0, 0.55, C::METAL_TIN));
            } else { slab_under(&b, p, out); }
            continue;
        }
        if side_of(&b, p).is_some() {
            let width = if big { None } else { spec.lead_w };
            gull_lead(&b, p, z_exit, thick, width, spec.foot, if big { cap.max(1.5) } else { cap }, C::METAL_TIN, out);
        } else {
            // an exposed pad under the body
            slab_under(&b, p, out);
        }
    }
    if pads.len() > 4 && !up.starts_with("SOT") && !up.starts_with("TSOT") && !up.starts_with("SC-") { pin_one(&b, h, pads, out); }
}

fn no_lead(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let t = (0.2f64).min(h * 0.3);
    out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, 0.0, h, (0.05 * h).min(0.05), C::BODY_BLACK));
    for p in pads {
        let pr = pad_rect(p);
        let Some(mut r) = inter(&pr, &b) else { slab_under(&b, p, out); continue };
        let touches = [(pr.x0 <= b.x0 + 0.02, 0), (pr.x1 >= b.x1 - 0.02, 1), (pr.y0 <= b.y0 + 0.02, 2), (pr.y1 >= b.y1 - 0.02, 3)];
        if !touches.iter().any(|(t, _)| *t) { slab_under(&b, p, out); continue; }   // an exposed or inner pad
        for (t, side) in touches { if t { match side { 0 => r.x0 = b.x0 - 0.02, 1 => r.x1 = b.x1 + 0.02, 2 => r.y0 = b.y0 - 0.02, _ => r.y1 = b.y1 + 0.02 } } }
        // keep the terminal narrower than its pad, as the metal is
        let shrink = |lo: f64, hi: f64, keep: bool| if keep { (lo, hi) } else { let m = (hi - lo) * 0.08; (lo + m, hi - m) };
        let (x0, x1) = shrink(r.x0, r.x1, r.x0 < b.x0 || r.x1 > b.x1);
        let (y0, y1) = shrink(r.y0, r.y1, r.y0 < b.y0 || r.y1 > b.y1);
        out.extend(Solid::cuboid("terminal", x0, y0, x1, y1, 0.0, t, C::METAL_TIN));
    }
    if pads.len() > 4 { pin_one(&b, h, pads, out); }
}

fn bga(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let d = pads.iter().map(|p| p.w.min(p.h)).fold(f64::MAX, f64::min).clamp(0.15, 0.8) * 1.15;
    let wlcsp = h <= 0.7;
    let ball_h = (d * 0.65).min(h * 0.4);
    for p in pads { out.extend(Solid::prism("ball", &circle(p.x, p.y, d / 2.0, 12), 0.0, ball_h + 0.01, C::METAL_TIN)); }
    if wlcsp {
        out.extend(Solid::cuboid("die", b.x0, b.y0, b.x1, b.y1, ball_h, h, Rgb(0.10, 0.10, 0.14)));
    } else {
        let sub = ((h - ball_h) * 0.3).clamp(0.15, 0.4);
        out.extend(Solid::cuboid("substrate", b.x0, b.y0, b.x1, b.y1, ball_h, ball_h + sub, C::SUBSTRATE));
        let m = (b.w().min(b.h()) * 0.04).clamp(0.05, 0.4);
        out.extend(moulded("mould", b.x0 + m, b.y0 + m, b.x1 - m, b.y1 - m, ball_h + sub, h, 0.05, C::BODY_BLACK));
    }
    pin_one(&b, h, pads, out);
}

fn crystal(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let base = (h * 0.35).clamp(0.12, 0.6);
    out.extend(Solid::prism("base", &chamfered(b.x0, b.y0, b.x1, b.y1, 0.0), 0.0, base, C::CERAMIC));
    let m = (b.w().min(b.h()) * 0.06).clamp(0.08, 0.3);
    out.extend(Solid::prism("lid", &chamfered(b.x0 + m, b.y0 + m, b.x1 - m, b.y1 - m, m), base, h, C::METAL_STEEL));
    for p in pads {
        if side_of(&b, p).is_some() { flat_tab(&b, p, 0.05, base * 0.8, C::METAL_GOLD, out); } else { slab_under(&b, p, out); }
    }
}

fn electrolytic(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let s = b.w().min(b.h());
    let base_h = (0.18 * h).clamp(0.4, 1.0);
    out.extend(Solid::prism("base", &chamfered(b.x0, b.y0, b.x1, b.y1, s * 0.18), 0.0, base_h, C::BODY_BLACK));
    let r = s * 0.47;
    out.extend(Solid::prism("can", &circle(b.cx(), b.cy(), r, 40), base_h, h - 0.15, C::CAN));
    out.extend(Solid::loft("can", &circle(0.0, 0.0, r, 40), &circle(0.0, 0.0, r - 0.15, 40), [b.cx(), b.cy(), h - 0.15], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.15], C::CAN));
    // the polarity marking on the sleeve: a dark segment of the top on the minus side (pad 2)
    if let Some(minus) = pads.iter().find(|p| p.num == "2") {
        let dx = minus.x - b.cx();
        let dy = minus.y - b.cy();
        let pts: Vec<P2> = if dx.abs() >= dy.abs() { let sx = dx.signum(); vec![[b.cx() + sx * r * 0.55, b.cy() - r * 0.6], [b.cx() + sx * r * 0.85, b.cy() - r * 0.3], [b.cx() + sx * r * 0.85, b.cy() + r * 0.3], [b.cx() + sx * r * 0.55, b.cy() + r * 0.6]] }
            else { let sy = dy.signum(); vec![[b.cx() - r * 0.6, b.cy() + sy * r * 0.55], [b.cx() + r * 0.6, b.cy() + sy * r * 0.55], [b.cx() + r * 0.3, b.cy() + sy * r * 0.85], [b.cx() - r * 0.3, b.cy() + sy * r * 0.85]] };
        out.extend(Solid::prism("mark", &pts, h, h + 0.01, C::SLEEVE_BLUE));
    }
    for p in pads { flat_tab(&b, p, 0.15, 0.15, C::METAL_TIN, out); }
}

fn led_package(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    out.extend(Solid::cuboid("body", b.x0, b.y0, b.x1, b.y1, 0.0, h, C::PLASTIC_WHITE));
    let s = b.w().min(b.h());
    let m = (s * 0.12).max(0.1);
    let lens: Vec<P2> = if (b.w() - b.h()).abs() < 0.2 * s { circle(b.cx(), b.cy(), s / 2.0 - m, 32) } else { rect(b.x0 + m, b.y0 + m, b.x1 - m, b.y1 - m) };
    out.extend(Solid::prism("lens", &lens, h, h + 0.01, C::LED_LENS));
    for p in pads {
        if side_of(&b, p).is_some() { flat_tab(&b, p, 0.1, (h * 0.5).min(0.4), C::METAL_TIN, out); }
        else { slab_under(&b, p, out); }
    }
    // the corner chamfer marking pin 1
    if let Some(p1) = pad_one(pads) {
        let c = s * 0.18;
        let (x, y) = (if p1.x < b.cx() { b.x0 } else { b.x1 }, if p1.y < b.cy() { b.y0 } else { b.y1 });
        let (sx, sy) = (if p1.x < b.cx() { 1.0 } else { -1.0 }, if p1.y < b.cy() { 1.0 } else { -1.0 });
        out.extend(Solid::prism("pin1", &[[x, y], [x + sx * c, y], [x, y + sy * c]], h, h + 0.012, C::PIN1_GREY));
    }
}

fn inductor(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let s = b.w().min(b.h());
    out.extend(Solid::prism("body", &chamfered(b.x0, b.y0, b.x1, b.y1, s * 0.08), 0.0, h, C::INDUCTOR));
    for p in pads {
        if side_of(&b, p).is_some() { flat_tab(&b, p, 0.12, (h * 0.35).min(1.5), C::METAL_TIN, out); }
        else { slab_under(&b, p, out); }
    }
}

fn switch(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let s = b.w().min(b.h());
    let base = h * 0.55;
    out.extend(Solid::cuboid("base", b.x0, b.y0, b.x1, b.y1, 0.0, base, C::BODY_BLACK));
    out.extend(Solid::cuboid("plate", b.x0, b.y0, b.x1, b.y1, base, base + (0.08 * h).clamp(0.05, 0.25), C::METAL_STEEL));
    let r = s * 0.28;
    out.extend(Solid::prism("actuator", &circle(b.cx(), b.cy(), r, 28), base, h, C::BUTTON));
    for p in pads { if side_of(&b, p).is_some() { flat_tab(&b, p, 0.12, (base * 0.6).min(0.8), C::METAL_STEEL, out); } else { slab_under(&b, p, out); } }
}

/// A stadium (flat top and bottom, round ends) `w` wide and `h` high standing on z0, split down the
/// middle into its left and right halves so a tube of it is two simple outlines.
fn stadium_half(w: f64, h: f64, z0: f64, right: bool, inner: Option<(f64, f64, f64)>) -> Vec<P2> {
    let r = h / 2.0;
    let n = 10;
    let s = if right { 1.0 } else { -1.0 };
    let arc = |w: f64, h: f64, z0: f64| -> Vec<P2> {
        let r = h / 2.0;
        let cx = (w / 2.0 - r).max(0.0);
        let mut pts = vec![[0.0, z0 + h]];
        for i in 0..=n { let a = std::f64::consts::FRAC_PI_2 - std::f64::consts::PI * i as f64 / n as f64; pts.push([s * (cx + r * a.cos()), z0 + r + r * a.sin()]); }
        pts.push([0.0, z0]);
        pts
    };
    let _ = r;
    let mut outer = arc(w, h, z0);
    if let Some((iw, ih, iz)) = inner {
        let mut inn = arc(iw, ih, iz);
        inn.reverse();
        outer.extend(inn);
    }
    if !right { outer.reverse(); }
    outer
}

fn usb_c(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let sig: Vec<&&Pad> = pads.iter().filter(|p| p.drill.is_none()).collect();
    let stakes: Vec<&&Pad> = pads.iter().filter(|p| p.drill.is_some()).collect();
    let (fx, fy) = (b.cx(), b.cy());
    let (mut sx, mut sy) = (0.0, 0.0);
    for p in &sig { sx += p.x; sy += p.y; }
    if !sig.is_empty() { sx /= sig.len() as f64; sy /= sig.len() as f64; }
    // the mouth faces away from the signal pads
    let along_y = (sy - fy).abs() >= (sx - fx).abs();
    let dir: [f64; 2] = if along_y { [0.0, if sy > fy { -1.0 } else { 1.0 }] } else { [if sx > fx { -1.0 } else { 1.0 }, 0.0] };
    let half = (if along_y { b.h() } else { b.w() }) / 2.0;
    let across: [f64; 2] = [-dir[1], dir[0]];
    let at = |t: f64| -> V3 { [fx + dir[0] * t, fy + dir[1] * t, 0.0] };
    let (w, h, wall) = (8.94, 3.16, 0.3);
    let (back, mouth) = (-half, half);
    let mid = back + 0.42 * 2.0 * half;
    let u: V3 = [across[0], across[1], 0.0];
    let z: V3 = [0.0, 0.0, 1.0];
    let push = |a: f64, bb: f64| -> V3 { [dir[0] * (bb - a), dir[1] * (bb - a), 0.0] };
    for right in [false, true] {
        out.extend(Solid::extrude("shell", &stadium_half(w, h, 0.0, right, Some((w - 2.0 * wall, h - 2.0 * wall, wall))), at(back + 0.3), u, z, push(back + 0.3, mouth), C::METAL_STEEL));
        out.extend(Solid::extrude("back", &stadium_half(w, h, 0.0, right, None), at(back), u, z, push(back, back + 0.3), C::METAL_STEEL));
        out.extend(Solid::extrude("insert", &stadium_half(w - 2.0 * wall - 0.04, h - 2.0 * wall - 0.04, wall + 0.02, right, None), at(back + 0.3), u, z, push(back + 0.3, mid), C::BODY_BLACK));
    }
    let (tz0, tz1, tip) = (h / 2.0 - 0.35, h / 2.0 + 0.35, mouth - 0.75);
    out.extend(Solid::extrude("tongue", &rect(-3.345, tz0, 3.345, tz1), at(mid), u, z, push(mid, tip), C::PLASTIC_DARK));
    for i in 0..12 {
        let c = (i as f64 - 5.5) * 0.5;
        let long = if [0, 3, 8, 11].contains(&i) { 0.25 } else { 0.75 };
        for (z0, z1) in [(tz1, tz1 + 0.03), (tz0 - 0.03, tz0)] {
            out.extend(Solid::extrude("contact", &rect(c - 0.13, z0, c + 0.13, z1), at(mid), u, z, push(mid, tip - long), C::METAL_GOLD));
        }
    }
    for p in stakes { out.extend(Solid::cuboid("stake", p.x - if along_y { 0.15 } else { 0.5 }, p.y - if along_y { 0.5 } else { 0.15 }, p.x + if along_y { 0.15 } else { 0.5 }, p.y + if along_y { 0.5 } else { 0.15 }, -1.3, 1.3, C::METAL_STEEL)); }
    for p in sig {
        let (lw, ll) = if along_y { (p.w * 0.55, p.h * 0.9) } else { (p.w * 0.9, p.h * 0.55) };
        out.extend(Solid::cuboid("lead", p.x - lw / 2.0, p.y - ll / 2.0, p.x + lw / 2.0, p.y + ll / 2.0, 0.0, 0.14, C::METAL_TIN));
    }
    let _ = spec;
}

// ---------------------------------------------------------------- through-hole families

fn dip(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let pb = Rect::of(pads.iter().filter(|p| p.drill.is_some()).map(|p| (p.x, p.y))).or_else(|| spec_body_inside(spec, pads)).unwrap_or(spec.body);
    let rows_y = { let mut xs: Vec<i64> = pads.iter().map(|p| (p.x * 100.0).round() as i64).collect(); xs.sort(); xs.dedup(); xs.len() == 2 };
    let body = if rows_y { Rect { x0: pb.x0 + 0.65, x1: pb.x1 - 0.65, y0: pb.y0 - 1.27, y1: pb.y1 + 1.27 } } else { Rect { y0: pb.y0 + 0.65, y1: pb.y1 - 0.65, x0: pb.x0 - 1.27, x1: pb.x1 + 1.27 } };
    let (z0, z1) = (0.5, 0.5 + spec.height);
    out.extend(moulded("body", body.x0, body.y0, body.x1, body.y1, z0, z1, 0.2, C::BODY_BLACK));
    for p in pads {
        if p.drill.is_none() { gull_lead(&body, p, z0 + 0.6, 0.25, Some(0.5), None, 1.5, C::METAL_TIN, out); continue; }
        tht_lead(p, z0 + 0.6, false, C::METAL_TIN, out);
        // the shoulder from the body's side out over the hole
        let (lo, hi) = if rows_y { if p.x < body.cx() { (p.x - 0.25, body.x0 + 0.05) } else { (body.x1 - 0.05, p.x + 0.25) } } else if p.y < body.cy() { (p.y - 0.25, body.y0 + 0.05) } else { (body.y1 - 0.05, p.y + 0.25) };
        if rows_y { out.extend(Solid::cuboid("lead", lo, p.y - 0.75, hi, p.y + 0.75, z0 + 0.3, z0 + 0.6, C::METAL_TIN)); }
        else { out.extend(Solid::cuboid("lead", p.x - 0.75, lo, p.x + 0.75, hi, z0 + 0.3, z0 + 0.6, C::METAL_TIN)); }
    }
    if let Some(p1) = pad_one(pads) {
        let r = (body.w().min(body.h()) * 0.12).min(0.9);
        let (x, y) = if rows_y { (body.cx(), if p1.y < body.cy() { body.y0 + 0.01 } else { body.y1 - 0.01 }) } else { (if p1.x < body.cx() { body.x0 + 0.01 } else { body.x1 - 0.01 }, body.cy()) };
        out.extend(Solid::prism("notch", &circle(x, y, r, 20), z1, z1 + 0.01, C::PIN1_GREY));
    }
}

/// An SMD DIP's pin centres: the pads pulled in to where a through-hole DIP's holes would be.
fn spec_body_inside(spec: &Spec, pads: &[&Pad]) -> Option<Rect> {
    let r = Rect::of(pads.iter().map(|p| (p.x, p.y)))?;
    let inset = ((r.w().min(r.h()) - spec.body.w().min(spec.body.h())) / 2.0).max(0.0);
    let _ = inset;
    let rows_y = r.h() >= r.w();
    let w = (r.w().min(r.h()) - 2.0).max(r.w().min(r.h()) * 0.6);
    Some(if rows_y { Rect::centred(r.cx(), r.cy(), w, r.h()) } else { Rect::centred(r.cx(), r.cy(), r.w(), w) })
}

fn header(spec: &Spec, fp: &Footprint, pads: &[&Pad], out: &mut Vec<Solid>) {
    let n = &fp.name;
    let pitch = mm_after(n, "P").or_else(|| super::package::pad_pitch(fp)).unwrap_or(2.54);
    let k = pitch / 2.54;
    let socket = n.contains("Socket");
    let rows: usize = n.split('_').find_map(|t| t.split_once('x').and_then(|(a, b)| if a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit()) { a.parse().ok() } else { None })).unwrap_or(1).max(1);
    let smd = pads.iter().all(|p| p.drill.is_none());
    let colour = if socket { C::PLASTIC_DARK } else { C::PLASTIC_DARK };
    if n.contains("Horizontal") && !smd {
        // lying on the board: the plastic strip beyond the holes, the pins running out of it
        let pb = Rect::of(pads.iter().map(|p| (p.x, p.y))).unwrap_or(spec.body);
        let body = spec.body;
        let h = rows as f64 * pitch;
        let (dx, dy) = if (body.cx() - pb.cx()).abs() >= (body.cy() - pb.cy()).abs() { ((body.cx() - pb.cx()).signum(), 0.0) } else { (0.0, (body.cy() - pb.cy()).signum()) };
        let near = if dx != 0.0 { if dx > 0.0 { pb.x1 + pitch / 2.0 } else { pb.x0 - pitch / 2.0 } } else if dy > 0.0 { pb.y1 + pitch / 2.0 } else { pb.y0 - pitch / 2.0 };
        let depth = if socket { 8.5 * k } else { 2.5 * k };
        let b = if dx != 0.0 { Rect { x0: near.min(near + dx * depth), x1: near.max(near + dx * depth), y0: pb.y0 - pitch / 2.0, y1: pb.y1 + pitch / 2.0 } } else { Rect { y0: near.min(near + dy * depth), y1: near.max(near + dy * depth), x0: pb.x0 - pitch / 2.0, x1: pb.x1 + pitch / 2.0 } };
        out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, 0.0, h, 0.1, colour));
        let s = 0.64 * k;
        let reach = if socket { 0.0 } else { 6.0 * k };
        for p in pads {
            let row = if dx != 0.0 { ((p.x - pb.x0) / pitch).round().abs() } else { ((p.y - pb.y0) / pitch).round().abs() };
            let row = if (dx > 0.0) || (dy > 0.0) { (rows as f64 - 1.0) - row.min(rows as f64 - 1.0) } else { row.min(rows as f64 - 1.0) };
            let z = (row + 0.5) * pitch;
            out.extend(Solid::cuboid("pin", p.x - s / 2.0, p.y - s / 2.0, p.x + s / 2.0, p.y + s / 2.0, -LEAD_BELOW, z + s / 2.0, C::METAL_GOLD));
            let (a, e) = if dx != 0.0 { let e = if dx > 0.0 { b.x1 + reach } else { b.x0 - reach }; ((p.x.min(e), p.y - s / 2.0), (p.x.max(e), p.y + s / 2.0)) } else { let e = if dy > 0.0 { b.y1 + reach } else { b.y0 - reach }; ((p.x - s / 2.0, p.y.min(e)), (p.x + s / 2.0, p.y.max(e))) };
            out.extend(Solid::cuboid("pin", a.0, a.1, e.0, e.1, z - s / 2.0, z + s / 2.0, C::METAL_GOLD));
        }
        return;
    }
    if smd {
        // the pins stand in a strip down the middle; their feet are bent out onto the pads
        let pb = fp.pad_box().unwrap_or(spec.body);
        let along_y = pb.h() >= pb.w();
        let (cx, cy) = (pb.cx(), pb.cy());
        let width = rows as f64 * pitch;
        let ys: Vec<f64> = pads.iter().map(|p| if along_y { p.y } else { p.x }).collect();
        let (lo, hi) = (ys.iter().cloned().fold(f64::MAX, f64::min) - pitch / 2.0, ys.iter().cloned().fold(f64::MIN, f64::max) + pitch / 2.0);
        let b = if along_y { Rect { x0: cx - width / 2.0, x1: cx + width / 2.0, y0: lo, y1: hi } } else { Rect { y0: cy - width / 2.0, y1: cy + width / 2.0, x0: lo, x1: hi } };
        let (body_h, top) = if socket { (if rows > 1 { 7.47 } else { 7.4 } * k, 0.0) } else { (2.5 * k, 9.3 * k) };
        out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, if socket { 0.0 } else { 0.8 * k }, body_h + if socket { 0.0 } else { 0.8 * k }, 0.1, colour));
        let s = 0.64 * k;
        for p in pads {
            let (px, py) = if along_y { (if rows > 1 { if p.x < cx { cx - pitch / 2.0 } else { cx + pitch / 2.0 } } else { cx }, p.y) } else { (p.x, if rows > 1 { if p.y < cy { cy - pitch / 2.0 } else { cy + pitch / 2.0 } } else { cy }) };
            if !socket { out.extend(Solid::cuboid("pin", px - s / 2.0, py - s / 2.0, px + s / 2.0, py + s / 2.0, 0.1, top, C::METAL_GOLD)); }
            let r = Rect::of([(px, py), (p.x, p.y)]).unwrap().grow(s / 2.0);
            out.extend(Solid::cuboid("foot", r.x0, r.y0, r.x1, r.y1, 0.0, 0.15, C::METAL_GOLD));
        }
        return;
    }
    let pb = Rect::of(pads.iter().map(|p| (p.x, p.y))).unwrap_or(spec.body).grow(pitch / 2.0);
    let (body_h, pin_top) = if socket { (8.5 * k, 0.0) } else { (2.5 * k, 8.5 * k) };
    out.extend(moulded("body", pb.x0, pb.y0, pb.x1, pb.y1, 0.0, body_h, 0.1, colour));
    for p in pads {
        if socket {
            let s = 0.9 * k;
            tht_lead(p, 1.0, true, C::METAL_GOLD, out);
            out.extend(Solid::cuboid("hole", p.x - s / 2.0, p.y - s / 2.0, p.x + s / 2.0, p.y + s / 2.0, body_h, body_h + 0.01, C::BODY_BLACK));
        } else {
            let s = 0.64 * k;
            out.extend(Solid::cuboid("pin", p.x - s / 2.0, p.y - s / 2.0, p.x + s / 2.0, p.y + s / 2.0, -LEAD_BELOW, pin_top, C::METAL_GOLD));
        }
    }
}

fn mm_after(name: &str, key: &str) -> Option<f64> {
    let i = name.find(&format!("_{key}"))? + key.len() + 1;
    let digits: String = name[i..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if name[i + digits.len()..].starts_with("mm") { digits.parse().ok() } else { None }
}

fn axial(spec: &Spec, fp: &Footprint, pads: &[&Pad], out: &mut Vec<Solid>) {
    if pads.len() < 2 { return generic(spec, fp, pads, out); }
    let (p0, p1) = (pads[0], pads[1]);
    let span = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt();
    if span < 1.0 { return generic(spec, fp, pads, out); }
    let (ux, uy) = ((p1.x - p0.x) / span, (p1.y - p0.y) / span);
    let n = &fp.name;
    let l = mm_after(n, "L").unwrap_or(spec.body.w().max(spec.body.h())).clamp(1.0, span - 0.8);
    let d = mm_after(n, "D").unwrap_or(spec.body.w().min(spec.body.h())).clamp(0.8, 12.0);
    let r = d / 2.0;
    let z = r + 0.15;
    let (mx, my) = ((p0.x + p1.x) / 2.0, (p0.y + p1.y) / 2.0);
    let a: V3 = [mx - ux * l / 2.0, my - uy * l / 2.0, z];
    let b: V3 = [mx + ux * l / 2.0, my + uy * l / 2.0, z];
    let up = n.to_ascii_uppercase();
    let diode = up.starts_with("D_") || up.contains("DO-") || fp.reference_prefix() == "D";
    let glass = up.contains("DO-35") || up.contains("DO-34");
    if n.contains("Vertical") {
        // standing on one lead, the other bent over its top and down
        let (stand, other) = if up.contains("ANODEUP") || up.contains("CATHODEUP") || true { (p0, p1) } else { (p1, p0) };
        let l = mm_after(n, "L").unwrap_or(if up.contains("DO-35") { 4.0 } else if up.contains("DO-41") { 5.2 } else if up.contains("DO-15") { 7.6 } else if up.contains("DO-201") || up.contains("DO-27") { 9.5 } else { l });
        let d = mm_after(n, "D").unwrap_or(if up.contains("DO-35") { 2.0 } else if up.contains("DO-41") { 2.7 } else if up.contains("DO-15") { 3.6 } else if up.contains("DO-201") || up.contains("DO-27") { 5.3 } else { d });
        let colour = if diode { if glass { C::GLASS } else { C::BODY_BLACK } } else if up.starts_with("C_") || up.starts_with("CP_") { Rgb(0.30, 0.42, 0.62) } else { C::BEIGE };
        out.extend(Solid::prism("body", &circle(stand.x, stand.y, d / 2.0, 24), 1.0, 1.0 + l, colour));
        let lr = (p0.drill.unwrap_or(0.8) * 0.35).clamp(0.2, 0.5);
        let top = 1.0 + l + 1.2;
        out.extend(Solid::prism("lead", &circle(stand.x, stand.y, lr, 10), -LEAD_BELOW, top, C::METAL_TIN));
        out.extend(Solid::prism("lead", &circle(other.x, other.y, lr, 10), -LEAD_BELOW, top, C::METAL_TIN));
        out.extend(Solid::cylinder("lead", [stand.x, stand.y, top], [other.x, other.y, top], lr, 10, C::METAL_TIN));
        return;
    }
    let colour = if diode { if glass { C::GLASS } else { C::BODY_BLACK } } else if up.starts_with("C_") || up.starts_with("CP_") { Rgb(0.30, 0.42, 0.62) } else { C::BEIGE };
    out.extend(Solid::cylinder("body", a, b, r, 24, colour));
    if diode {
        let k = if pad_one(pads).map(|p| p.num == p0.num).unwrap_or(true) { a } else { b };
        let s = if k == a { 1.0 } else { -1.0 };
        let w = (0.15 * l).min(0.6);
        out.extend(Solid::cylinder("band", [k[0] + s * ux * 0.25 * w, k[1] + s * uy * 0.25 * w, z], [k[0] + s * ux * 1.25 * w, k[1] + s * uy * 1.25 * w, z], r * 1.03, 24, if glass { C::BODY_BLACK } else { C::PIN1_GREY }));
    }
    let lr = (p0.drill.unwrap_or(0.8) * 0.35).clamp(0.2, 0.5);
    out.extend(Solid::cylinder("lead", [p0.x, p0.y, z], a, lr, 10, C::METAL_TIN));
    out.extend(Solid::cylinder("lead", b, [p1.x, p1.y, z], lr, 10, C::METAL_TIN));
    for p in [p0, p1] { out.extend(Solid::prism("lead", &circle(p.x, p.y, lr, 10), -LEAD_BELOW, z, C::METAL_TIN)); }
}

fn radial(spec: &Spec, fp: &Footprint, pads: &[&Pad], out: &mut Vec<Solid>) {
    let n = &fp.name;
    let pb = Rect::of(pads.iter().map(|p| (p.x, p.y))).unwrap_or(spec.body);
    let (cx, cy, r) = match fp.fab_circle { Some((x, y, r)) => (x, y, r), None => { let d = mm_after(n, "D").unwrap_or(pb.w().max(pb.h()) + 2.0); (pb.cx(), pb.cy(), d / 2.0) } };
    let d = mm_after(n, "D").unwrap_or(2.0 * r);
    let r = d / 2.0;
    if n.starts_with("R_Radial") {
        let b = spec.body;
        let l = mm_after(n, "L").unwrap_or(b.w().max(b.h()));
        out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, 0.0, 2.0 * l, 0.3, C::PLASTIC_WHITE));
        for p in pads { tht_lead(p, 0.5, false, C::METAL_TIN, out); }
        return;
    }
    if n.starts_with("LED") && n.contains("Horizontal") {
        // lying on its side: the lens points away from the leads, its axis Z above the board
        let b = spec.body;
        let zc = mm_after(n, "Z").unwrap_or(r) + 0.4;
        let pc = Rect::of(pads.iter().map(|p| (p.x, p.y))).unwrap_or(b);
        let (a, e): (V3, V3) = if b.w() >= b.h() { let far = if (b.x1 - pc.cx()).abs() > (b.x0 - pc.cx()).abs() { b.x1 } else { b.x0 }; let near = if far == b.x1 { b.x0 } else { b.x1 }; ([near, b.cy(), zc], [far, b.cy(), zc]) } else { let far = if (b.y1 - pc.cy()).abs() > (b.y0 - pc.cy()).abs() { b.y1 } else { b.y0 }; let near = if far == b.y1 { b.y0 } else { b.y1 }; ([b.cx(), near, zc], [b.cx(), far, zc]) };
        out.extend(Solid::cylinder("lens", a, e, r, 24, C::RED_LED));
        for p in pads { tht_lead(p, zc, true, C::METAL_TIN, out); }
        return;
    }
    if n.starts_with("LED") {
        let h = if d <= 3.2 { 1.9 * d + 1.6 } else { 5.6 + 1.2 * d };
        out.extend(Solid::prism("flange", &circle(cx, cy, r * 1.1, 32), 1.0, 2.0, C::RED_LED));
        out.extend(Solid::prism("lens", &circle(cx, cy, r, 32), 2.0, h - r * 0.6, C::RED_LED));
        out.extend(Solid::loft("dome", &circle(0.0, 0.0, r, 32), &circle(0.0, 0.0, r * 0.45, 32), [cx, cy, h - r * 0.6], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, r * 0.6], C::RED_LED));
        for p in pads { tht_lead(p, 1.0, true, C::METAL_TIN, out); }
        return;
    }
    let h = mm_after(n, "H").unwrap_or(if d <= 6.3 { 11.0 } else if d <= 8.0 { 11.5 } else if d <= 10.0 { 12.5 } else if d <= 13.0 { 13.5 } else { d });
    out.extend(Solid::prism("sleeve", &circle(cx, cy, r, 40), 0.4, h - 0.3, C::SLEEVE_BLUE));
    out.extend(Solid::loft("top", &circle(0.0, 0.0, r, 40), &circle(0.0, 0.0, r * 0.88, 40), [cx, cy, h - 0.3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.3], C::CAN));
    for p in pads { tht_lead(p, 0.4, false, C::METAL_TIN, out); }
}

fn to220(spec: &Spec, fp: &Footprint, pads: &[&Pad], out: &mut Vec<Solid>) {
    let pb = Rect::of(pads.iter().map(|p| (p.x, p.y))).unwrap_or(spec.body);
    let along = pb.w() >= pb.h();
    let (cx, cy) = (pb.cx(), pb.cy());
    if fp.name.contains("Horizontal") {
        let f = spec.body;
        out.extend(moulded("body", f.x0, f.y0, f.x1, f.y1, 0.0, 4.4, 0.25, C::BODY_BLACK));
        for p in pads { tht_lead(p, 1.5, true, C::METAL_TIN, out); }
        return;
    }
    let (w, t) = (10.2, 4.5);
    let body = if along { Rect::centred(cx, cy, w, t) } else { Rect::centred(cx, cy, t, w) };
    out.extend(moulded("body", body.x0, body.y0, body.x1, body.y1, 3.0, 12.2, 0.25, C::BODY_BLACK));
    let tab = if along { Rect { y0: body.y1 - 1.3, ..body } } else { Rect { x0: body.x1 - 1.3, ..body } };
    out.extend(Solid::cuboid("tab", tab.x0, tab.y0, tab.x1, tab.y1, 3.0, 18.5, C::METAL_TIN));
    for p in pads { tht_lead(p, 3.0, true, C::METAL_TIN, out); }
}

fn to92(spec: &Spec, pads: &[&Pad], out: &mut Vec<Solid>) {
    let pb = Rect::of(pads.iter().map(|p| (p.x, p.y))).unwrap_or(spec.body);
    if spec.kind == "horizontal" {
        let b = spec.body;
        out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, 0.0, 3.8, 0.2, C::BODY_BLACK));
        for p in pads { tht_lead(p, 1.9, true, C::METAL_TIN, out); }
        return;
    }
    let tall = if spec.kind == "L" { 8.0 } else { 4.8 };
    let along = pb.w() >= pb.h();
    let (cx, cy, r) = (pb.cx(), pb.cy(), 2.4);
    let mut pts: Vec<P2> = Vec::new();
    for i in 0..=16 {
        let a = std::f64::consts::PI * i as f64 / 16.0;
        pts.push(if along { [cx + r * a.cos(), cy + 0.6 - r * a.sin()] } else { [cx - 0.6 + r * a.sin(), cy + r * a.cos()] });
    }
    out.extend(Solid::prism("body", &pts, 2.5, 2.5 + tall, C::BODY_BLACK));
    for p in pads { tht_lead(p, 2.5, true, C::METAL_TIN, out); }
}

fn generic(spec: &Spec, fp: &Footprint, pads: &[&Pad], out: &mut Vec<Solid>) {
    let b = spec.body;
    let h = spec.height;
    let up = fp.name.to_ascii_uppercase();
    let conn = up.starts_with("CONN") || up.contains("JST") || up.contains("MOLEX") || up.contains("CONNECTOR") || fp.reference_prefix() == "J";
    let colour = if conn { if up.contains("TERMINAL") { C::TERMINAL_GREEN } else { C::PLASTIC_WHITE } } else { C::BODY_BLACK };
    out.extend(moulded("body", b.x0, b.y0, b.x1, b.y1, 0.0, h, (0.06 * h).min(0.2), colour));
    for p in pads {
        if p.drill.is_some() { tht_lead(p, 0.5_f64.min(h), !conn || true, if conn { C::METAL_GOLD } else { C::METAL_TIN }, out); continue; }
        if side_of(&b, p).is_some() { flat_tab(&b, p, 0.1, (h * 0.3).min(0.6), C::METAL_TIN, out); }
        else { slab_under(&b, p, out); }
    }
    if !conn && pads.len() > 4 { pin_one(&b, h, pads, out); }
}
