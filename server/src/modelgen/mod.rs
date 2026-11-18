//! Generated 3D models: when a footprint has no model anywhere (not in the project, not in KiCad's
//! library, not from the part's vendor), one is drawn from the footprint itself instead of a plain box.
//!
//! No AI is needed for most parts.  The footprint's pads say where every lead lands, its name (KiCad's
//! and EasyEDA's naming conventions) and fabrication outline give the body, and typical JEDEC heights
//! fill in the rest (package.rs).  When the part's datasheet is known, its package dimension table
//! (A, A1, D, E1, E, e, b, L) is read from the PDF's text (dims.rs) and used only when it agrees with
//! the pads; a free language model (ai.rs) is asked only when no table can be read, and its answer goes
//! through the same check.  The drawing (build.rs) is written as a STEP file (step.rs) that KiCad desktop
//! and the web viewer both read, and kept for everybody under a hash of what it was drawn from.

pub mod ai;
pub mod build;
pub mod dims;
pub mod footgen;
pub mod footprint;
pub mod package;
pub mod solid;
pub mod service;
pub mod step;

use serde::Serialize;

pub use package::{Dims, Family};

/// A version for the cache key: bump it when the drawing changes, so old models are drawn again.
pub const GENERATOR_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
pub struct Generated {
    #[serde(skip)]
    pub step: Vec<u8>,
    pub family: Family,
    /// body size and seated height, millimetres
    pub body: [f64; 2],
    pub height: f64,
    /// where each number came from (datasheet, name, fab, courtyard, pads, typical)
    pub sources: Vec<(String, package::From)>,
    /// why a datasheet's numbers were not used, when they were not
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refused: Vec<String>,
    pub solids: usize,
}

/// Draws the model of the footprint in `text` (a .kicad_mod, or a board's (footprint …)), with a
/// datasheet's numbers when given.
#[allow(dead_code)]
pub fn generate(text: &str, dims: Option<&Dims>) -> Option<Generated> {
    let fp = footprint::parse(text)?;
    generate_for(&fp, dims)
}

pub fn generate_for(fp: &footprint::Footprint, dims: Option<&Dims>) -> Option<Generated> {
    let mut spec = package::spec_of(fp)?;
    let mut refused = Vec::new();
    if let Some(d) = dims.filter(|d| !d.is_empty()) { refused = package::apply_dims(&mut spec, fp, d); }
    let solids = build::solids(&spec, fp);
    if solids.is_empty() { return None; }
    let name = if fp.name.is_empty() { "part".to_string() } else { fp.name.clone() };
    let step = step::write(&name, &solids);
    Some(Generated { step, family: spec.family, body: [round(spec.body.w()), round(spec.body.h())], height: round(spec.height), sources: spec.sources, refused, solids: solids.len() })
}

fn round(v: f64) -> f64 { (v * 1000.0).round() / 1000.0 }

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes a model for every footprint file listed in MODELGEN_EVAL_LIST into MODELGEN_EVAL_OUT
    /// (scripts/modelgen-eval.mjs compares them with KiCad's own models).
    #[test]
    #[ignore]
    fn eval_dump() {
        let list = std::env::var("MODELGEN_EVAL_LIST").expect("MODELGEN_EVAL_LIST");
        let out = std::env::var("MODELGEN_EVAL_OUT").expect("MODELGEN_EVAL_OUT");
        let mut report = Vec::new();
        for line in std::fs::read_to_string(list).unwrap().lines() {
            let path = line.trim();
            if path.is_empty() { continue; }
            let text = std::fs::read_to_string(path).unwrap_or_default();
            let stem = std::path::Path::new(path).file_stem().unwrap().to_string_lossy().to_string();
            let lib = std::path::Path::new(path).parent().and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            match generate(&text, None) {
                Some(g) => {
                    let file = format!("{out}/{lib}__{stem}.step");
                    std::fs::write(&file, &g.step).unwrap();
                    report.push(serde_json::json!({ "lib": lib, "name": stem, "file": file, "family": g.family, "body": g.body, "height": g.height, "sources": g.sources }));
                }
                None => report.push(serde_json::json!({ "lib": lib, "name": stem, "file": null })),
            }
        }
        std::fs::write(format!("{out}/report.json"), serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }

    #[test]
    fn draws_a_soic() {
        let text = r#"(footprint "SOIC-8_3.9x4.9mm_P1.27mm" (attr smd)
          (pad 1 smd rect (at -2.475 -1.905) (size 1.95 0.6) (layers F.Cu)) (pad 2 smd rect (at -2.475 -0.635) (size 1.95 0.6) (layers F.Cu))
          (pad 3 smd rect (at -2.475 0.635) (size 1.95 0.6) (layers F.Cu)) (pad 4 smd rect (at -2.475 1.905) (size 1.95 0.6) (layers F.Cu))
          (pad 5 smd rect (at 2.475 1.905) (size 1.95 0.6) (layers F.Cu)) (pad 6 smd rect (at 2.475 0.635) (size 1.95 0.6) (layers F.Cu))
          (pad 7 smd rect (at 2.475 -0.635) (size 1.95 0.6) (layers F.Cu)) (pad 8 smd rect (at 2.475 -1.905) (size 1.95 0.6) (layers F.Cu)))"#;
        let g = generate(text, None).unwrap();
        assert_eq!(g.family, Family::GullWing);
        assert_eq!(g.body, [3.9, 4.9]);
        assert!(g.solids >= 10, "body and 8 leads");
        assert!(g.step.starts_with(b"ISO-10303-21"));
        if let Ok(p) = std::env::var("MODELGEN_SAMPLE") { std::fs::write(p, &g.step).unwrap(); }
    }
}
