//! Solids for generated models: closed polyhedra with flat faces and one colour each.  Everything a
//! package drawing needs is built from extrusions (a flat outline pushed along a direction: bodies,
//! leads, pins, round parts as many-sided prisms) and frusta (an outline and a smaller copy of it above,
//! for moulded bodies whose top edge is drawn in).  Millimetres, in KiCad's model frame: X right, Y up
//! (a footprint file's Y runs down: flip it), Z up from the face the part sits on.

pub type V3 = [f64; 3];
pub type P2 = [f64; 2];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb(pub f64, pub f64, pub f64);

/// Colours after KiCad's own library models (kicad-packages3D-generator's cq_parameters colour names).
pub mod colour {
    use super::Rgb;
    pub const BODY_BLACK: Rgb = Rgb(0.148, 0.145, 0.145);
    pub const PIN1_GREY: Rgb = Rgb(0.42, 0.42, 0.44);
    pub const METAL_TIN: Rgb = Rgb(0.824, 0.820, 0.781);
    pub const METAL_GOLD: Rgb = Rgb(0.859, 0.738, 0.496);
    pub const METAL_STEEL: Rgb = Rgb(0.70, 0.71, 0.73);
    pub const CERAMIC: Rgb = Rgb(0.738, 0.580, 0.400);
    pub const RESISTOR_TOP: Rgb = Rgb(0.10, 0.10, 0.11);
    pub const RESISTOR_BODY: Rgb = Rgb(0.95, 0.95, 0.93);
    pub const LED_WHITE: Rgb = Rgb(0.90, 0.89, 0.82);
    pub const LED_LENS: Rgb = Rgb(0.95, 0.93, 0.70);
    pub const TANTALUM: Rgb = Rgb(0.84, 0.62, 0.20);
    pub const SLEEVE_BLUE: Rgb = Rgb(0.12, 0.15, 0.28);
    pub const CAN: Rgb = Rgb(0.78, 0.78, 0.80);
    pub const PLASTIC_DARK: Rgb = Rgb(0.20, 0.20, 0.21);
    pub const PLASTIC_WHITE: Rgb = Rgb(0.92, 0.92, 0.90);
    pub const TERMINAL_GREEN: Rgb = Rgb(0.20, 0.45, 0.26);
    pub const SUBSTRATE: Rgb = Rgb(0.30, 0.42, 0.30);
    pub const INDUCTOR: Rgb = Rgb(0.28, 0.28, 0.30);
    pub const BUTTON: Rgb = Rgb(0.30, 0.30, 0.32);
    pub const RED_LED: Rgb = Rgb(0.80, 0.20, 0.16);
    pub const BEIGE: Rgb = Rgb(0.80, 0.70, 0.52);
    pub const GLASS: Rgb = Rgb(0.74, 0.33, 0.20);
    #[allow(dead_code)]
    pub const TRIMMER_BLUE: Rgb = Rgb(0.22, 0.32, 0.58);
}

/// A closed polyhedron: faces list vertex indices counter-clockwise seen from outside.
#[derive(Clone, Debug)]
pub struct Solid {
    pub name: String,
    pub verts: Vec<V3>,
    pub faces: Vec<Vec<usize>>,
    pub colour: Rgb,
}

fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }

/// Twice the signed area (counter-clockwise positive).
pub fn area2(p: &[P2]) -> f64 {
    let n = p.len();
    (0..n).map(|i| { let (a, b) = (p[i], p[(i + 1) % n]); a[0] * b[1] - b[0] * a[1] }).sum()
}

/// Drops repeated corners (and a closing copy of the first) that would make a degenerate edge.
fn clean(p: &[P2]) -> Vec<P2> {
    let mut out: Vec<P2> = Vec::with_capacity(p.len());
    for &q in p {
        if let Some(l) = out.last() { if (l[0] - q[0]).abs() < 1e-6 && (l[1] - q[1]).abs() < 1e-6 { continue; } }
        out.push(q);
    }
    while out.len() > 2 { let (f, l) = (out[0], out[out.len() - 1]); if (f[0] - l[0]).abs() < 1e-6 && (f[1] - l[1]).abs() < 1e-6 { out.pop(); } else { break; } }
    out
}

impl Solid {
    /// `outline` (in the plane through `origin` spanned by `u`, `v`) pushed along `w`.
    pub fn extrude(name: &str, outline: &[P2], origin: V3, u: V3, v: V3, w: V3, colour: Rgb) -> Option<Solid> {
        Solid::loft(name, outline, outline, origin, u, v, w, colour)
    }

    /// A vertical prism over `outline` (model X/Y) from height z0 to z1.
    pub fn prism(name: &str, outline: &[P2], z0: f64, z1: f64, colour: Rgb) -> Option<Solid> {
        if z1 - z0 < 1e-4 { return None; }
        Solid::extrude(name, outline, [0.0, 0.0, z0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, z1 - z0], colour)
    }

    /// A box between two corners (x0, y0) and (x1, y1), from z0 to z1.
    pub fn cuboid(name: &str, x0: f64, y0: f64, x1: f64, y1: f64, z0: f64, z1: f64, colour: Rgb) -> Option<Solid> {
        let (a, b) = ((x0.min(x1), y0.min(y1)), (x0.max(x1), y0.max(y1)));
        if b.0 - a.0 < 1e-4 || b.1 - a.1 < 1e-4 { return None; }
        Solid::prism(name, &rect(a.0, a.1, b.0, b.1), z0, z1, colour)
    }

    /// From `bottom` (in the plane at `origin`) to `top` (the same number of corners, in the plane at
    /// `origin + w`): a frustum when `top` is `bottom` drawn in.  Each side face must stay flat, which it
    /// does when every top edge is parallel to its bottom edge (an inset rectangle, a scaled polygon).
    pub fn loft(name: &str, bottom: &[P2], top: &[P2], origin: V3, u: V3, v: V3, w: V3, colour: Rgb) -> Option<Solid> {
        let (mut b, mut t) = (clean(bottom), clean(top));
        if b.len() < 3 || b.len() != t.len() { return None; }
        if area2(&b).abs() < 1e-8 { return None; }
        // the outline counter-clockwise about u x v, and w on the side u x v points to
        let n = cross(u, v);
        let (mut u, mut origin, mut w) = (u, origin, w);
        if dot(n, w) < 0.0 { origin = [origin[0] + w[0], origin[1] + w[1], origin[2] + w[2]]; w = [-w[0], -w[1], -w[2]]; std::mem::swap(&mut b, &mut t); }
        if area2(&b) < 0.0 {
            // mirror the outline's u axis, which turns it counter-clockwise
            u = [-u[0], -u[1], -u[2]];
            for p in b.iter_mut().chain(t.iter_mut()) { p[0] = -p[0]; }
            // mirroring u flips u x v: put w back on the positive side by swapping the ends
            origin = [origin[0] + w[0], origin[1] + w[1], origin[2] + w[2]]; w = [-w[0], -w[1], -w[2]]; std::mem::swap(&mut b, &mut t);
        }
        let at = |p: P2, lift: bool| -> V3 {
            let o = if lift { [origin[0] + w[0], origin[1] + w[1], origin[2] + w[2]] } else { origin };
            [o[0] + u[0] * p[0] + v[0] * p[1], o[1] + u[1] * p[0] + v[1] * p[1], o[2] + u[2] * p[0] + v[2] * p[1]]
        };
        let k = b.len();
        let mut verts: Vec<V3> = b.iter().map(|&p| at(p, false)).collect();
        verts.extend(t.iter().map(|&p| at(p, true)));
        let mut faces: Vec<Vec<usize>> = Vec::with_capacity(k + 2);
        faces.push((0..k).rev().collect());                 // bottom, seen from below
        faces.push((k..2 * k).collect());                   // top
        for i in 0..k { let j = (i + 1) % k; faces.push(vec![i, j, k + j, k + i]); }
        let s = Solid { name: name.to_string(), verts, faces, colour };
        if s.volume() <= 1e-9 { return None; }
        Some(s)
    }

    /// A cylinder (a `sides`-gon prism) along `a` -> `b` of radius r.
    pub fn cylinder(name: &str, a: V3, b: V3, r: f64, sides: usize, colour: Rgb) -> Option<Solid> {
        let w = sub(b, a);
        let len = dot(w, w).sqrt();
        if len < 1e-4 || r < 1e-4 { return None; }
        let d = [w[0] / len, w[1] / len, w[2] / len];
        let helper = if d[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
        let u = norm(cross(helper, d));
        let v = cross(d, u);
        Solid::extrude(name, &circle(0.0, 0.0, r, sides), a, u, v, w, colour)
    }

    /// The enclosed volume (positive for a correctly wound solid).
    pub fn volume(&self) -> f64 {
        let mut vol = 0.0;
        for f in &self.faces {
            let p0 = self.verts[f[0]];
            for i in 1..f.len() - 1 { vol += dot(p0, cross(self.verts[f[i]], self.verts[f[i + 1]])); }
        }
        vol / 6.0
    }

    #[allow(dead_code)]
    pub fn bounds(&self) -> (V3, V3) {
        let mut lo = [f64::MAX; 3];
        let mut hi = [f64::MIN; 3];
        for p in &self.verts { for k in 0..3 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } }
        (lo, hi)
    }
}

fn norm(a: V3) -> V3 { let l = dot(a, a).sqrt().max(1e-12); [a[0] / l, a[1] / l, a[2] / l] }

/// A rectangle's corners, counter-clockwise.
pub fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<P2> { vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }

/// A circle as a `sides`-gon, counter-clockwise.
pub fn circle(cx: f64, cy: f64, r: f64, sides: usize) -> Vec<P2> {
    (0..sides).map(|i| { let a = std::f64::consts::TAU * i as f64 / sides as f64; [cx + r * a.cos(), cy + r * a.sin()] }).collect()
}

/// A rectangle with its corners cut at 45 degrees (`c` along each side), counter-clockwise.
pub fn chamfered(x0: f64, y0: f64, x1: f64, y1: f64, c: f64) -> Vec<P2> {
    let c = c.min((x1 - x0) / 2.0 - 1e-3).min((y1 - y0) / 2.0 - 1e-3).max(0.0);
    if c < 1e-3 { return rect(x0, y0, x1, y1); }
    vec![[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]]
}

/// A moulded body: straight sides up to `z1 - draft` and a top drawn in by `draft` all round (the
/// look of KiCad's generated packages), as one or two solids.
pub fn moulded(name: &str, x0: f64, y0: f64, x1: f64, y1: f64, z0: f64, z1: f64, draft: f64, colour: Rgb) -> Vec<Solid> {
    let mut out = Vec::new();
    let d = draft.min((x1 - x0) * 0.2).min((y1 - y0) * 0.2).min((z1 - z0) * 0.4).max(0.0);
    if d < 0.01 {
        out.extend(Solid::cuboid(name, x0, y0, x1, y1, z0, z1, colour));
        return out;
    }
    out.extend(Solid::cuboid(name, x0, y0, x1, y1, z0, z1 - d, colour));
    out.extend(Solid::loft(name, &rect(x0, y0, x1, y1), &rect(x0 + d, y0 + d, x1 - d, y1 - d), [0.0, 0.0, z1 - d], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, d], colour));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solids_are_closed_and_outward() {
        let b = Solid::cuboid("b", 0.0, 0.0, 2.0, 1.0, 0.0, 0.5, colour::BODY_BLACK).unwrap();
        assert!((b.volume() - 1.0).abs() < 1e-9);
        // a clockwise outline and a downward push give the same, correctly wound solid
        let cw: Vec<P2> = rect(0.0, 0.0, 2.0, 1.0).into_iter().rev().collect();
        let d = Solid::extrude("d", &cw, [0.0, 0.0, 0.5], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -0.5], colour::BODY_BLACK).unwrap();
        assert!((d.volume() - 1.0).abs() < 1e-9);
        let c = Solid::cylinder("c", [0.0, 0.0, 0.0], [3.0, 0.0, 0.0], 1.0, 64, colour::METAL_TIN).unwrap();
        assert!((c.volume() - std::f64::consts::PI * 3.0).abs() < 0.02);
        let m = moulded("m", 0.0, 0.0, 4.0, 4.0, 0.0, 1.0, 0.1, colour::BODY_BLACK);
        assert_eq!(m.len(), 2);
        assert!(m.iter().all(|s| s.volume() > 0.0));
        // every edge is shared by exactly two faces, in opposite directions
        for s in [&b, &d, &c, &m[1]] {
            let mut seen = std::collections::HashMap::new();
            for f in &s.faces { for i in 0..f.len() { *seen.entry((f[i], f[(i + 1) % f.len()])).or_insert(0) += 1; } }
            for (&(a, b), &n) in &seen { assert_eq!(n, 1); assert_eq!(seen.get(&(b, a)), Some(&1)); }
        }
    }
}
