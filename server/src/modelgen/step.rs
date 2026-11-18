//! Writes solids as a STEP file (ISO 10303-21, AP214 "automotive design", the schema KiCad's own
//! library models use): one product, each solid a MANIFOLD_SOLID_BREP of flat faces bounded by
//! straight edges, coloured with STYLED_ITEMs the way OpenCascade's XCAF writer does, so KiCad
//! desktop and the web viewer (occt-import-js) both read the colours.

use std::fmt::Write as _;

use super::solid::{Rgb, Solid, V3};

struct W { out: String, n: usize }

impl W {
    fn put(&mut self, entity: impl AsRef<str>) -> usize {
        self.n += 1;
        let _ = writeln!(self.out, "#{}={};", self.n, entity.as_ref());
        self.n
    }
}

fn r(v: f64) -> String {
    let v = if v.abs() < 5e-10 { 0.0 } else { v };
    let s = format!("{v:.6}");
    let s = s.trim_end_matches('0');
    if s.ends_with('.') { format!("{s}0") } else { s.to_string() }
}

fn quote(s: &str) -> String { s.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()).collect::<String>().replace('\'', "''") }

fn unit(a: V3) -> V3 { let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-12); [a[0] / l, a[1] / l, a[2] / l] }

/// The whole file for `solids`, named `name`.
pub fn write(name: &str, solids: &[Solid]) -> Vec<u8> {
    let name = quote(name);
    let mut w = W { out: String::with_capacity(64 * 1024), n: 0 };
    let head = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Junction generated package model'),'2;1');\nFILE_NAME('{name}.step','2026-01-01T00:00:00',('Junction'),('Junction'),'Junction model generator','Junction','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN {{ 1 0 10303 214 1 1 1 1 }}'));\nENDSEC;\nDATA;\n"
    );
    let app = w.put("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
    w.put(format!("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#{app})"));
    let pctx = w.put(format!("PRODUCT_CONTEXT('',#{app},'mechanical')"));
    let pdctx = w.put(format!("PRODUCT_DEFINITION_CONTEXT('part definition',#{app},'design')"));
    let prod = w.put(format!("PRODUCT('{name}','{name}','',(#{pctx}))"));
    w.put(format!("PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#{prod}))"));
    let pdf = w.put(format!("PRODUCT_DEFINITION_FORMATION('','',#{prod})"));
    let pd = w.put(format!("PRODUCT_DEFINITION('design','',#{pdf},#{pdctx})"));
    let pds = w.put(format!("PRODUCT_DEFINITION_SHAPE('','',#{pd})"));
    let mm = w.put("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))");
    let rad = w.put("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))");
    let sr = w.put("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())");
    let unc = w.put(format!("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#{mm},'distance_accuracy_value','confusion accuracy')"));
    let ctx = w.put(format!("(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#{mm},#{rad},#{sr})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))"));
    let o = w.put("CARTESIAN_POINT('',(0.,0.,0.))");
    let z = w.put("DIRECTION('',(0.,0.,1.))");
    let x = w.put("DIRECTION('',(1.,0.,0.))");
    let axis = w.put(format!("AXIS2_PLACEMENT_3D('',#{o},#{z},#{x})"));

    let mut breps: Vec<usize> = Vec::new();
    let mut styled: Vec<usize> = Vec::new();
    let mut styles: Vec<(Rgb, usize)> = Vec::new();
    for s in solids {
        let brep = brep(&mut w, s);
        breps.push(brep);
        let psa = match styles.iter().find(|(c, _)| *c == s.colour) {
            Some(&(_, id)) => id,
            None => {
                let c = w.put(format!("COLOUR_RGB('',{},{},{})", r(s.colour.0), r(s.colour.1), r(s.colour.2)));
                let fac = w.put(format!("FILL_AREA_STYLE_COLOUR('',#{c})"));
                let fas = w.put(format!("FILL_AREA_STYLE('',(#{fac}))"));
                let ssfa = w.put(format!("SURFACE_STYLE_FILL_AREA(#{fas})"));
                let sss = w.put(format!("SURFACE_SIDE_STYLE('',(#{ssfa}))"));
                let ssu = w.put(format!("SURFACE_STYLE_USAGE(.BOTH.,#{sss})"));
                let psa = w.put(format!("PRESENTATION_STYLE_ASSIGNMENT((#{ssu}))"));
                styles.push((s.colour, psa));
                psa
            }
        };
        styled.push(w.put(format!("STYLED_ITEM('color',(#{psa}),#{brep})")));
    }
    let items = std::iter::once(axis).chain(breps.iter().copied()).map(|i| format!("#{i}")).collect::<Vec<_>>().join(",");
    let rep = w.put(format!("ADVANCED_BREP_SHAPE_REPRESENTATION('{name}',({items}),#{ctx})"));
    w.put(format!("SHAPE_DEFINITION_REPRESENTATION(#{pds},#{rep})"));
    let st = styled.iter().map(|i| format!("#{i}")).collect::<Vec<_>>().join(",");
    w.put(format!("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',({st}),#{ctx})"));
    let mut text = head;
    text.push_str(&w.out);
    text.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    text.into_bytes()
}

fn brep(w: &mut W, s: &Solid) -> usize {
    let pts: Vec<usize> = s.verts.iter().map(|p| w.put(format!("CARTESIAN_POINT('',({},{},{}))", r(p[0]), r(p[1]), r(p[2])))).collect();
    let vps: Vec<usize> = pts.iter().map(|p| w.put(format!("VERTEX_POINT('',#{p})"))).collect();
    // one EDGE_CURVE per pair of corners, running from the lower index to the higher
    let mut edges: std::collections::HashMap<(usize, usize), usize> = std::collections::HashMap::new();
    let mut faces: Vec<usize> = Vec::with_capacity(s.faces.len());
    for f in &s.faces {
        let mut oes: Vec<usize> = Vec::with_capacity(f.len());
        for i in 0..f.len() {
            let (a, b) = (f[i], f[(i + 1) % f.len()]);
            let key = (a.min(b), a.max(b));
            let edge = match edges.get(&key) {
                Some(&e) => e,
                None => {
                    let (p, q) = (s.verts[key.0], s.verts[key.1]);
                    let d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
                    let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                    let u = unit(d);
                    let dir = w.put(format!("DIRECTION('',({},{},{}))", r(u[0]), r(u[1]), r(u[2])));
                    let vec = w.put(format!("VECTOR('',#{dir},{})", r(len)));
                    let line = w.put(format!("LINE('',#{},#{vec})", pts[key.0]));
                    let e = w.put(format!("EDGE_CURVE('',#{},#{},#{line},.T.)", vps[key.0], vps[key.1]));
                    edges.insert(key, e);
                    e
                }
            };
            oes.push(w.put(format!("ORIENTED_EDGE('',*,*,#{edge},{})", if a < b { ".T." } else { ".F." })));
        }
        let list = oes.iter().map(|i| format!("#{i}")).collect::<Vec<_>>().join(",");
        let lp = w.put(format!("EDGE_LOOP('',({list}))"));
        let bound = w.put(format!("FACE_OUTER_BOUND('',#{lp},.T.)"));
        // the face's plane: through its first corner, normal outward (Newell's method), x along its first edge
        let mut n = [0.0f64; 3];
        for i in 0..f.len() {
            let (a, b) = (s.verts[f[i]], s.verts[f[(i + 1) % f.len()]]);
            n[0] += (a[1] - b[1]) * (a[2] + b[2]);
            n[1] += (a[2] - b[2]) * (a[0] + b[0]);
            n[2] += (a[0] - b[0]) * (a[1] + b[1]);
        }
        let n = unit(n);
        let e0 = { let (a, b) = (s.verts[f[0]], s.verts[f[1]]); unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) };
        // the reference direction must be square to the normal
        let k = e0[0] * n[0] + e0[1] * n[1] + e0[2] * n[2];
        let xr = unit([e0[0] - k * n[0], e0[1] - k * n[1], e0[2] - k * n[2]]);
        let nd = w.put(format!("DIRECTION('',({},{},{}))", r(n[0]), r(n[1]), r(n[2])));
        let xd = w.put(format!("DIRECTION('',({},{},{}))", r(xr[0]), r(xr[1]), r(xr[2])));
        let ax = w.put(format!("AXIS2_PLACEMENT_3D('',#{},#{nd},#{xd})", pts[f[0]]));
        let plane = w.put(format!("PLANE('',#{ax})"));
        faces.push(w.put(format!("ADVANCED_FACE('',(#{bound}),#{plane},.T.)")));
    }
    let list = faces.iter().map(|i| format!("#{i}")).collect::<Vec<_>>().join(",");
    let shell = w.put(format!("CLOSED_SHELL('',({list}))"));
    w.put(format!("MANIFOLD_SOLID_BREP('{}',#{shell})", quote(&s.name)))
}
