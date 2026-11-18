//! A vendor's STEP model moved so that the (model …) entry Junction writes for it places it as EasyEDA does.
//!
//! EasyEDA puts a part's 3D model by its bounding box, not by the file's own origin: the box is centred in X and Y
//! and stood on Z = 0, then moved by the 3D outline's c_origin and z and turned by its c_rotation.  The footprints
//! Junction converts carry that move and turn as their (model (offset …) (rotate …)) — `Model3d::offset` is
//! (x, y, -z), Y up, as KiCad writes it.  KiCad reads such an entry as R · p + offset on the file as it is, so the
//! file served is moved by
//!
//! ```text
//!     T = (x, y, z) - (box centre x, box centre y, box bottom) - R⁻¹ · offset
//! ```
//!
//! which makes KiCad's R · (p + T) + offset equal EasyEDA's R · (p - box + (x, y, z)), in every viewer and exporter
//! that reads the file: the web viewer, the desktop app and stock KiCad with a downloaded library alike.
//!
//! Moving every CARTESIAN_POINT by the same T moves the whole model by T, also through an assembly's placements
//! (each ITEM_DEFINED_TRANSFORMATION maps one placement onto another, both moved by T, so the move passes through it
//! once).  A shape representation's own frame (an AXIS2_PLACEMENT_3D among its items that no transformation uses)
//! stays where it is: OpenCASCADE, and so KiCad, places the shapes by that frame, and moving it as well moves the
//! model twice (LCSC C456018 came out 6.5 mm off and 3.7 mm sunk into the board).  The box is the box of the points: exact at the vertices that bound most parts, a little short of a round
//! face that bulges past its edges' vertices.

/// Length unit of the file: millimetres per file unit.
fn unit_mm(text: &str) -> f64 {
    let up = text.to_ascii_uppercase();
    if up.contains("'INCH'") {
        25.4
    } else if up.contains(".MILLI.,.METRE.") || up.contains(".MILLI., .METRE.") {
        1.0
    } else if up.contains(".CENTI.,.METRE.") {
        10.0
    } else if up.contains("SI_UNIT($,.METRE.)") || up.contains("SI_UNIT( $, .METRE. )") {
        1000.0
    } else {
        1.0
    }
}

/// Every 3D CARTESIAN_POINT's coordinate list as a byte range of the text, with its numbers.
fn points(text: &str) -> Vec<(std::ops::Range<usize>, [f64; 3])> {
    triples(text, "CARTESIAN_POINT")
}

/// Every 3D `key` entity's (… , (x, y, z)) list as a byte range of the text, with its numbers.
fn triples(text: &str, key: &str) -> Vec<(std::ops::Range<usize>, [f64; 3])> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut from = 0;
    while let Some(i) = text[from..].find(key) {
        let at = from + i + key.len();
        from = at;
        // CARTESIAN_POINT ( 'name' , ( x , y , z ) )
        let mut j = at;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= b.len() || b[j] != b'(' {
            continue;
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < b.len() && b[j] == b'\'' {
            j += 1;
            // a quote inside a STEP string is written twice
            while j < b.len() {
                if b[j] == b'\'' {
                    if j + 1 < b.len() && b[j + 1] == b'\'' {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            j += 1;
        }
        let Some(open) = text[j..].find('(').map(|k| j + k) else { continue };
        let Some(close) = text[open..].find(')').map(|k| open + k) else { continue };
        let nums: Vec<f64> = text[open + 1..close].split(',').filter_map(|s| s.trim().parse::<f64>().ok()).collect();
        if nums.len() == 3 && text[open + 1..close].split(',').count() == 3 {
            out.push((open + 1..close, [nums[0], nums[1], nums[2]]));
        }
        from = close;
    }
    out
}

/// The points the box is taken over: the solid's vertices (VERTEX_POINT), which bound it as its faces do; a curve's
/// control points and a placement's origin can lie well outside the part.  Every 3D point when the file names no vertex.
fn corners(text: &str) -> Vec<[f64; 3]> {
    let mut at: std::collections::HashMap<&str, [f64; 3]> = std::collections::HashMap::new();
    for (range, p) in points(text) {
        // the entity's own #id: "#123 = CARTESIAN_POINT ( ..." before the coordinate list
        let head = &text[..range.start];
        let Some(eq) = head.rfind("CARTESIAN_POINT").and_then(|i| head[..i].rfind('=')) else { continue };
        let Some(hash) = head[..eq].rfind('#') else { continue };
        at.insert(head[hash + 1..eq].trim(), p);
    }
    let mut out = Vec::new();
    let key = "VERTEX_POINT";
    let mut from = 0;
    while let Some(i) = text[from..].find(key) {
        let start = from + i + key.len();
        from = start;
        let Some(end) = text[start..].find(';').map(|e| start + e) else { break };
        if let Some(h) = text[start..end].rfind('#') {
            let id: String = text[start + h + 1..end].chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Some(p) = at.get(id.as_str()) {
                out.push(*p);
            }
        }
    }
    if out.is_empty() {
        out = points(text).into_iter().map(|(_, p)| p).collect();
    }
    out
}

/// KiCad's model rotation (3d-viewer: rotateZ(-rz) · rotateY(-ry) · rotateX(-rx)) applied to `v`; `inverse` undoes it.
fn turn(v: [f64; 3], rot: [f64; 3], inverse: bool) -> [f64; 3] {
    let r = |a: f64| (-a).to_radians();
    let (rx, ry, rz) = (r(rot[0]), r(rot[1]), r(rot[2]));
    let about_x = |v: [f64; 3], a: f64| [v[0], v[1] * a.cos() - v[2] * a.sin(), v[1] * a.sin() + v[2] * a.cos()];
    let about_y = |v: [f64; 3], a: f64| [v[0] * a.cos() + v[2] * a.sin(), v[1], -v[0] * a.sin() + v[2] * a.cos()];
    let about_z = |v: [f64; 3], a: f64| [v[0] * a.cos() - v[1] * a.sin(), v[0] * a.sin() + v[1] * a.cos(), v[2]];
    if inverse {
        about_x(about_y(about_z(v, -rz), -ry), -rx)
    } else {
        about_z(about_y(about_x(v, rx), ry), rz)
    }
}

/// The move T (millimetres) for a model with these points, offset and rotate; None when the file has no 3D point.
pub fn fit_move(text: &str, offset: [f64; 3], rotate: [f64; 3]) -> Option<[f64; 3]> {
    let k = unit_mm(text);
    let pts = corners(text);
    if pts.is_empty() {
        return None;
    }
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for p in &pts {
        for a in 0..3 {
            lo[a] = lo[a].min(p[a] * k);
            hi[a] = hi[a].max(p[a] * k);
        }
    }
    let back = turn(offset, rotate, true);
    let target = [offset[0], offset[1], -offset[2]];
    let box_at = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, lo[2]];
    Some([0, 1, 2].map(|a| target[a] - box_at[a] - back[a]))
}

/// The #id of the entity a byte offset of the text lies in: "#123 = KEY ( ..." before it.
fn owner(text: &str, at: usize) -> Option<&str> {
    let head = &text[..at];
    let eq = head.rfind('=')?;
    let hash = head[..eq].rfind('#')?;
    Some(head[hash + 1..eq].trim())
}

/// Every entity's body (after its "#id =", up to its ';'), by id; strings may hold ';' and are skipped over.
fn entities(text: &str) -> std::collections::HashMap<&str, &str> {
    let b = text.as_bytes();
    let mut out = std::collections::HashMap::new();
    let (mut i, mut start, mut quoted) = (0, 0, false);
    while i < b.len() {
        match b[i] {
            b'\'' => quoted = !quoted,
            b';' if !quoted => {
                let stmt = &text[start..i];
                if let Some(eq) = stmt.find('=') {
                    let id = stmt[..eq].trim();
                    if let Some(id) = id.strip_prefix('#') {
                        out.insert(id, &stmt[eq + 1..]);
                    }
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// The #ids referenced in `body`, strings left out.
fn refs(body: &str) -> Vec<&str> {
    let b = body.as_bytes();
    let (mut out, mut i, mut quoted) = (Vec::new(), 0, false);
    while i < b.len() {
        if b[i] == b'\'' {
            quoted = !quoted;
        } else if !quoted && b[i] == b'#' {
            let s = i + 1;
            let mut e = s;
            while e < b.len() && b[e].is_ascii_digit() {
                e += 1;
            }
            out.push(&body[s..e]);
            i = e;
            continue;
        }
        i += 1;
    }
    out
}

/// The points and directions of each shape representation's own frame (an AXIS2_PLACEMENT_3D among its items that
/// no ITEM_DEFINED_TRANSFORMATION uses), which a move or turn of the model must leave alone.
fn frames(text: &str) -> std::collections::HashSet<String> {
    let all = entities(text);
    let mut placed_by: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut items: Vec<&str> = Vec::new();
    for body in all.values() {
        if body.contains("ITEM_DEFINED_TRANSFORMATION") {
            placed_by.extend(refs(body));
            continue;
        }
        let mut from = 0;
        while let Some(i) = body[from..].find("SHAPE_REPRESENTATION") {
            let at = from + i + "SHAPE_REPRESENTATION".len();
            from = at;
            if body[at..].starts_with('_') || body[..at - "SHAPE_REPRESENTATION".len()].ends_with("CONTEXT_DEPENDENT_") {
                continue;
            }
            // KEY ( 'name' , ( #a , #b ) , #context ): the list after the name
            let rest = &body[at..];
            let Some(q1) = rest.find('\'') else { continue };
            let Some(q2) = rest[q1 + 1..].find('\'').map(|k| q1 + 1 + k) else { continue };
            let Some(open) = rest[q2..].find('(').map(|k| q2 + k) else { continue };
            let Some(close) = rest[open..].find(')').map(|k| open + k) else { continue };
            items.extend(refs(&rest[open..close]));
        }
    }
    let mut out = std::collections::HashSet::new();
    for id in items {
        if placed_by.contains(id) {
            continue;
        }
        let Some(body) = all.get(id) else { continue };
        if body.trim_start().starts_with("AXIS2_PLACEMENT_3D") {
            out.extend(refs(body).into_iter().map(str::to_string));
        }
    }
    out
}

/// The file with every 3D point moved by `t` millimetres (a shape representation's own frame left alone).
pub fn moved(text: &str, t: [f64; 3]) -> String {
    let k = unit_mm(text);
    let keep = frames(text);
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut last = 0;
    for (range, p) in points(text) {
        if owner(text, range.start).is_some_and(|id| keep.contains(id)) {
            continue;
        }
        out.push_str(&text[last..range.start]);
        let n = [0, 1, 2].map(|a| p[a] + t[a] / k);
        out.push_str(&format!("{},{},{}", real(n[0]), real(n[1]), real(n[2])));
        last = range.end;
    }
    out.push_str(&text[last..]);
    out
}

/// The file turned by KiCad's model rotation `rotate` and then moved by `t` millimetres: every point and direction,
/// which turns and moves the whole model, through an assembly's placements too.
pub fn transformed(text: &str, rotate: [f64; 3], t: [f64; 3]) -> String {
    let k = unit_mm(text);
    let keep = frames(text);
    let kept = |r: &std::ops::Range<usize>| owner(text, r.start).is_some_and(|id| keep.contains(id));
    let mut edits: Vec<(std::ops::Range<usize>, [f64; 3])> = Vec::new();
    for (range, p) in points(text) {
        if kept(&range) {
            continue;
        }
        let r = turn(p, rotate, false);
        edits.push((range, [0, 1, 2].map(|a| r[a] + t[a] / k)));
    }
    for (range, d) in triples(text, "DIRECTION") {
        if kept(&range) {
            continue;
        }
        edits.push((range, turn(d, rotate, false)));
    }
    edits.sort_by_key(|(r, _)| r.start);
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut last = 0;
    for (range, n) in edits {
        out.push_str(&text[last..range.start]);
        out.push_str(&format!("{},{},{}", real(n[0]), real(n[1]), real(n[2])));
        last = range.end;
    }
    out.push_str(&text[last..]);
    out
}

/// The file's bytes as text, one character per byte: a STEP file is ASCII but its names may hold any bytes (Latin-1,
/// GBK from a Chinese CAD tool), which must come back out exactly as they went in.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

fn unlatin1(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u32 as u8).collect()
}

/// The vendor's file placed as EasyEDA places it on its footprint, for an entry with no offset or turn of its own
/// (easyeda2kicad's .wrl, whose own copy has the move built in): the lined-up file with the vendor's turn and offset.
pub fn placed(bytes: &[u8], offset: [f64; 3], rotate: [f64; 3]) -> Vec<u8> {
    let text = &latin1(bytes);
    let Some(t) = fit_move(text, offset, rotate) else { return bytes.to_vec() };
    unlatin1(&transformed(&moved(text, t), rotate, offset))
}

/// A STEP REAL: always with a decimal point.
fn real(v: f64) -> String {
    let s = format!("{:.6}", if v.abs() < 5e-7 { 0.0 } else { v });
    let s = s.trim_end_matches('0');
    if s.ends_with('.') { format!("{s}0") } else { s.to_string() }
}

/// The vendor's STEP file lined up for its (model …) entry; the file as it is when it cannot be read as text.
pub fn fitted(bytes: &[u8], offset: [f64; 3], rotate: [f64; 3]) -> Vec<u8> {
    let text = &latin1(bytes);
    match fit_move(text, offset, rotate) {
        Some(t) => unlatin1(&moved(text, t)),
        None => bytes.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: &str = "ISO-10303-21;\nDATA;\n#1=SI_UNIT(.MILLI.,.METRE.);\n#2=CARTESIAN_POINT('',(-7.75,-13.5,-3.87));\n#3=CARTESIAN_POINT('it''s',(7.75,0.5,7.64));\n#4=CARTESIAN_POINT('',(3.5,-0.25,-3.87));\n#5=CARTESIAN_POINT('',(1.,2.));\n#7=CARTESIAN_POINT('',(40.,40.,40.));\n#8=VERTEX_POINT('',#2);\n#9=VERTEX_POINT('',#3);\nENDSEC;\n";

    fn pts(text: &str) -> Vec<[f64; 3]> {
        points(text).into_iter().map(|(_, p)| p).collect()
    }

    #[test]
    fn usb_a_leads_land_on_their_pads() {
        // LCSC C456018: EasyEDA's offset 0,-4.9,3.8; KiCad then adds the same offset
        let out = String::from_utf8(fitted(BOX.as_bytes(), [0.0, -4.9, 3.8], [0.0; 3])).unwrap();
        let p = pts(&out);
        assert_eq!(p.len(), 4, "the 2D point is left alone");
        let lead = [p[2][0], p[2][1] - 4.9, p[2][2] + 3.8];
        for (a, want) in [3.5, 1.35, -3.8].iter().enumerate() {
            assert!((lead[a] - want).abs() < 1e-4, "{a}: {lead:?}");
        }
        assert!(out.contains("CARTESIAN_POINT('it''s',("), "names are kept");
        assert!(out.contains("(1.,2.)"));
    }

    #[test]
    fn the_shapes_own_frame_stays_put() {
        // EasyEDA's C456018: ADVANCED_BREP_SHAPE_REPRESENTATION('…',(#solid,#frame),#ctx); OpenCASCADE places the
        // solid by #frame, so moving it too moved the model twice
        let file = BOX.replace(
            "ENDSEC;",
            "#10=ADVANCED_BREP_SHAPE_REPRESENTATION('a;b',(#9,#11),#1);\n#11=AXIS2_PLACEMENT_3D('',#12,#13,#14);\n#12=CARTESIAN_POINT('',(0.,0.,0.));\n#13=DIRECTION('',(0.,0.,1.));\n#14=DIRECTION('',(1.,0.,0.));\nENDSEC;",
        );
        for out in [fitted(file.as_bytes(), [0.0, -4.9, 3.8], [0.0; 3]), placed(file.as_bytes(), [0.0, -4.9, 3.8], [0.0, 0.0, 90.0])] {
            let out = String::from_utf8(out).unwrap();
            assert!(out.contains("#12=CARTESIAN_POINT('',(0.,0.,0.))"), "{out}");
            assert!(out.contains("#14=DIRECTION('',(1.,0.,0.))"), "{out}");
            assert!(!out.contains("(3.5,-0.25,-3.87)"), "the solid moves");
        }
    }

    #[test]
    fn turned_model() {
        let out = String::from_utf8(fitted(BOX.as_bytes(), [0.0, -4.9, 3.8], [0.0, 0.0, 90.0])).unwrap();
        let p = pts(&out)[2];
        // KiCad: rotateZ(-90°) then the offset
        let r = turn(p, [0.0, 0.0, 90.0], false);
        let at = [r[0], r[1] - 4.9, r[2] + 3.8];
        // EasyEDA: the box moved, then turned
        let want = turn([3.5, 1.35, -3.8], [0.0, 0.0, 90.0], false);
        for a in 0..3 {
            assert!((at[a] - want[a]).abs() < 1e-4, "{a}: {at:?} vs {want:?}");
        }
    }

    #[test]
    fn placed_for_an_entry_without_offset() {
        let text = format!("{BOX}#6=DIRECTION('',(1.,0.,0.));\n");
        let out = String::from_utf8(placed(text.as_bytes(), [0.0, -4.9, 3.8], [0.0, 0.0, 90.0])).unwrap();
        let p = pts(&out)[2];
        let want = turn([3.5, 1.35, -3.8], [0.0, 0.0, 90.0], false);
        for a in 0..3 {
            assert!((p[a] - want[a]).abs() < 1e-4, "{a}: {p:?} vs {want:?}");
        }
        let d = triples(&out, "DIRECTION")[0].1;
        assert!((d[0]).abs() < 1e-9 && (d[1] + 1.0).abs() < 1e-9, "directions turn with the model: {d:?}");
    }

    #[test]
    fn inch_files_move_in_inches() {
        let inch = BOX.replace("#1=SI_UNIT(.MILLI.,.METRE.);", "#1=CONVERSION_BASED_UNIT('INCH',#9);");
        let t = fit_move(&inch, [0.0; 3], [0.0; 3]).unwrap();
        assert!((t[2] - 3.87 * 25.4).abs() < 1e-6);
        let p = pts(&moved(&inch, t))[0];
        assert!((p[2] * 25.4).abs() < 1e-4, "the box stands on 0: {p:?}");
    }

    #[test]
    fn names_that_are_not_utf8_are_kept() {
        let mut bytes = BOX.replace("'it''s'", "'\u{1}'").into_bytes();
        let at = bytes.iter().position(|&b| b == 1).unwrap();
        bytes[at] = 0xC4; // a GBK lead byte: not UTF-8 on its own
        let out = fitted(&bytes, [0.0, -4.9, 3.8], [0.0; 3]);
        assert_ne!(out, bytes, "the file is moved");
        assert!(out.windows(2).any(|w| w == [b'\'', 0xC4]), "the name's byte is kept");
    }

    #[test]
    fn reals_have_a_point() {
        assert_eq!(real(2.0), "2.0");
        assert_eq!(real(-0.0000001), "0.0");
        assert_eq!(real(1.25), "1.25");
    }
}
