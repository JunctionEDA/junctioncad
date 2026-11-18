//! The server side of generated models.
//!
//! - `POST /api/models/generate` `{footprint, datasheet?}` — the STEP model of a footprint (a board's
//!   `(footprint …)` or a `.kicad_mod`), drawn from it.  Kept in `generated_models` for everybody under a
//!   hash of the footprint's geometry and the datasheet.  Headers: `X-Model-Generated` (the package
//!   family), `X-Model-Sources` (where each number came from), `X-Model-Refining: 1` while the datasheet
//!   is still being read in the background (ask again later for the better model).  `?info=1` answers JSON.
//! - kicadlib.rs `GET /api/kicad-lib/model?fallback=1` draws one for a KiCad library footprint whose model
//!   the library lacks (`for_library`), so desktop Junction gets them too with no change of its own.
//!
//! The datasheet is read once per package (family, pin count, pitch) and datasheet: its text tables
//! first (dims.rs), then a free vision model (ai.rs) when one is configured.  Every answer is checked
//! against the pads (package::apply_dims); `package_dims` keeps the outcome, a miss included.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::AppState;

use super::footprint::{self, Footprint};
use super::package::{self, Dims};
use super::{ai, dims, generate_for, GENERATOR_VERSION};

const MAX_FOOTPRINT_BYTES: usize = 2 * 1024 * 1024;

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

/// What a model is drawn from, written out plainly: name, pads, outlines (not the reference or values,
/// so every R_0603 on every board shares one model).
fn canonical(fp: &Footprint) -> String {
    let r = |v: f64| (v * 1000.0).round() as i64;
    let mut s = format!("{}|{}|{}|{}|{}", fp.name, fp.smd, fp.tht, fp.reference_prefix(), fp.id.split(':').next().unwrap_or(""));
    for p in &fp.pads { s.push_str(&format!("|p{},{},{},{},{},{:?},{}", p.num, r(p.x), r(p.y), r(p.w), r(p.h), p.drill.map(r), p.copper)); }
    for (x, y) in &fp.fab { s.push_str(&format!("|f{},{}", r(*x), r(*y))); }
    if let Some((x, y, c)) = fp.fab_circle { s.push_str(&format!("|c{},{},{}", r(x), r(y), r(c))); }
    for (x, y) in &fp.courtyard { s.push_str(&format!("|y{},{}", r(*x), r(*y))); }
    s
}

/// The datasheet a footprint points at: its Datasheet field, else a PDF link in its description
/// (KiCad's library footprints name their package drawing there).
pub fn datasheet_of(fp: &Footprint) -> Option<String> {
    let ok = |u: &str| { let u = u.trim(); (u.starts_with("https://") || u.starts_with("http://")) && u.len() < 600 };
    // the reader fetches over https only; most http datasheet links answer there too
    let https = |u: &str| match u.trim().strip_prefix("http://") { Some(rest) => format!("https://{rest}"), None => u.trim().to_string() };
    if let Some(d) = fp.field("Datasheet").filter(|d| ok(d)) { return Some(https(d)); }
    for word in fp.descr.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',') {
        if ok(word) && word.to_ascii_lowercase().contains(".pdf") { return Some(https(word.trim_end_matches(['.', ';']))); }
    }
    None
}

/// A package's identity for reading its datasheet once: the datasheet, family, pin count, pitch.
fn package_key(url: &str, fp: &Footprint, family: package::Family) -> String {
    let pins = fp.copper_pads().map(|p| p.num.as_str()).collect::<HashSet<_>>().len();
    let pitch = package::pad_pitch(fp).map(|p| (p * 100.0).round() as i64).unwrap_or(0);
    hex(&Sha256::digest(format!("{url}|{family:?}|{pins}|{pitch}").as_bytes()))
}

/// The words a datasheet uses for this package: the name's first part (SOIC-8, VSON-10) and its family word.
fn package_words(fp: &Footprint) -> Vec<String> {
    let first = fp.name.split('_').next().unwrap_or("").to_string();
    let fam: String = first.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let mut w = vec![first.clone()];
    if fam.len() >= 2 && fam != first { w.push(fam); }
    w
}

fn refining() -> &'static Mutex<HashSet<String>> {
    static R: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The dimensions kept for this package, if it has been read: Some(None) when it was read and nothing fit.
async fn kept_dims(state: &AppState, key: &str) -> AppResult<Option<Option<Dims>>> {
    let row = sqlx::query("SELECT dims FROM package_dims WHERE key = $1 AND created_at > now() - CASE WHEN how = 'unreadable' THEN interval '1 day' ELSE interval '30 days' END").bind(key).fetch_optional(&state.pool).await?;
    Ok(row.map(|r| r.get::<Option<Value>, _>("dims").and_then(|v| serde_json::from_value(v).ok())))
}

/// Reads the datasheet for numbers that fit the footprint: text tables, then the free model.
pub async fn find_dims(state: &AppState, url: &str, fp: &Footprint) -> (Option<Dims>, String, Option<usize>, String) {
    let Some(spec) = package::spec_of(fp) else { return (None, "none".into(), None, "no package".into()) };
    let doc = match crate::datasheet::pages(state, url).await { Ok(d) => d, Err(e) => return (None, "unreadable".into(), None, format!("{e:?}")) };
    let words = package_words(fp);
    let pins = fp.copper_pads().map(|p| p.num.as_str()).collect::<HashSet<_>>().len();
    let mut notes = Vec::new();
    for c in dims::candidates(&doc, &words, pins).into_iter().take(8) {
        let mut s = spec.clone();
        let why = package::apply_dims(&mut s, fp, &c.dims);
        if why.is_empty() && c.dims.a.is_some() { return (Some(c.dims), "table".into(), Some(c.page), String::new()); }
        notes.push(format!("page {}: {}", c.page, if why.is_empty() { "no height".to_string() } else { why.join("; ") }));
    }
    if !ai::configured() { return (None, "none".into(), None, format!("no table fits ({}); no AI key configured", notes.join(" | "))); }
    // the free vision model: the two pages most like a package drawing of this package
    let query = format!("package outline mechanical dimensions millimeters {} {}", words.join(" "), pins);
    let pages: Vec<usize> = crate::datasheet::rank_pages(&doc, &query).into_iter().take(2).collect();
    if pages.is_empty() { return (None, "none".into(), None, "no package drawing page".into()); }
    let images = match crate::datasheet::page_images(state, url, Some(pages.clone()), None, 1600).await { Ok((imgs, _, _)) => imgs, Err(e) => { notes.push(e); Vec::new() } };
    let texts: Vec<(usize, String)> = pages.iter().map(|&n| (n, doc.get(n - 1).cloned().unwrap_or_default())).collect();
    let pb = fp.pad_box().map(|b| (b.w(), b.h())).unwrap_or((0.0, 0.0));
    let fam = format!("{:?}", spec.family);
    let ask = ai::Ask { family: &fam, package_words: &words.join(" / "), pins, pitch: package::pad_pitch(fp), pad_span: pb };
    let mut because: Option<String> = None;
    for _ in 0..2 {
        match ai::ask(&ask, &images, &texts, because.as_deref()).await {
            Ok((d, pkg, model)) => {
                let mut s = spec.clone();
                let why = package::apply_dims(&mut s, fp, &d);
                if why.is_empty() && d.a.is_some() { return (Some(d), format!("ai:{model}"), pages.first().copied(), pkg.unwrap_or_default()); }
                because = Some(if why.is_empty() { "no seated height A".into() } else { why.join("; ") });
                notes.push(format!("{model}: {}", because.clone().unwrap_or_default()));
            }
            Err(e) => { notes.push(e); break; }
        }
    }
    (None, "none".into(), None, notes.join(" | "))
}

async fn store(state: &AppState, key: &str, g: &super::Generated, refined: bool) {
    let info = serde_json::to_value(g).unwrap_or(Value::Null);
    let _ = sqlx::query("INSERT INTO generated_models (key, step, info, refined) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO UPDATE SET step = EXCLUDED.step, info = EXCLUDED.info, refined = EXCLUDED.refined, created_at = now()")
        .bind(key).bind(&g.step).bind(&info).bind(refined).execute(&state.pool).await;
}

pub struct Answer { pub step: Vec<u8>, pub info: Value, pub refining: bool }

/// The model for `fp` (with its datasheet `url`, if any): from the cache, else drawn now.  A datasheet not
/// read yet is read in the background; this answer is the footprint-only drawing meanwhile.
pub async fn model_for(state: &AppState, fp: &Footprint, url: Option<String>) -> AppResult<Option<Answer>> {
    let Some(spec) = package::spec_of(fp) else { return Ok(None) };
    let key = format!("gen:{GENERATOR_VERSION}:{}", hex(&Sha256::digest(format!("{}|{}", canonical(fp), url.as_deref().unwrap_or("")).as_bytes())));
    if let Some(row) = sqlx::query("SELECT step, info, refined FROM generated_models WHERE key = $1").bind(&key).fetch_optional(&state.pool).await? {
        let refined: bool = row.get("refined");
        let busy = refining().lock().map(|r| r.contains(&key)).unwrap_or(false);
        if refined || url.is_none() || busy { return Ok(Some(Answer { step: row.get("step"), info: row.get("info"), refining: !refined && busy })); }
    }
    let pkey = url.as_deref().map(|u| package_key(u, fp, spec.family));
    let kept = match &pkey { Some(k) => kept_dims(state, k).await?, None => None };
    let dims = kept.clone().flatten();
    let Some(g) = generate_for(fp, dims.as_ref()) else { return Ok(None) };
    let done = url.is_none() || kept.is_some();
    store(state, &key, &g, done).await;
    let info = serde_json::to_value(&g).unwrap_or(Value::Null);
    let mut refining_now = false;
    if !done {
        let (url, pkey) = (url.clone().unwrap(), pkey.clone().unwrap());
        let fresh = refining().lock().map(|mut r| r.insert(key.clone())).unwrap_or(false);
        if fresh {
            refining_now = true;
            let (state, fp, key) = (state.clone(), fp.clone(), key.clone());
            tokio::spawn(async move {
                // one datasheet at a time per server: they are big, and the free model has a rate limit
                static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
                let _slot = GATE.get_or_init(|| tokio::sync::Semaphore::new(2)).acquire().await;
                let (d, how, page, notes) = find_dims(&state, &url, &fp).await;
                tracing::info!("modelgen: {} via {how} (page {page:?}) {notes}", fp.name);
                let _ = sqlx::query("INSERT INTO package_dims (key, datasheet, dims, how, page, notes) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO UPDATE SET dims = EXCLUDED.dims, how = EXCLUDED.how, page = EXCLUDED.page, notes = EXCLUDED.notes, created_at = now()")
                    .bind(&pkey).bind(&url).bind(d.as_ref().and_then(|d| serde_json::to_value(d).ok())).bind(&how).bind(page.map(|p| p as i32)).bind(&notes).execute(&state.pool).await;
                if let Some(g) = generate_for(&fp, d.as_ref()) { store(&state, &key, &g, true).await; }
                if let Ok(mut r) = refining().lock() { r.remove(&key); }
            });
        }
    }
    Ok(Some(Answer { step: g.step, info, refining: refining_now }))
}

fn reply(a: Answer, info: bool) -> Response {
    if info { return Json(json!({ "model": a.info, "refining": a.refining })).into_response(); }
    let mut resp = ([(header::CONTENT_TYPE, "model/step"), (header::CACHE_CONTROL, if a.refining { "no-store" } else { "private, max-age=86400" })], a.step).into_response();
    let h = resp.headers_mut();
    if let Some(f) = a.info.get("family").and_then(|v| v.as_str()) { if let Ok(v) = header::HeaderValue::from_str(f) { h.insert("x-model-generated", v); } }
    if let Some(s) = a.info.get("sources") { if let Ok(v) = header::HeaderValue::from_str(&s.to_string()) { h.insert("x-model-sources", v); } }
    if a.refining { h.insert("x-model-refining", header::HeaderValue::from_static("1")); }
    resp
}

#[derive(Deserialize)]
pub struct GenerateReq { footprint: String, #[serde(default)] datasheet: Option<String> }
#[derive(Deserialize)]
pub struct GenerateQuery { #[serde(default)] info: Option<String> }

/// `POST /api/models/generate`
pub async fn generate(State(state): State<AppState>, AuthUser(_user): AuthUser, Query(q): Query<GenerateQuery>, Json(req): Json<GenerateReq>) -> AppResult<Response> {
    if req.footprint.len() > MAX_FOOTPRINT_BYTES { return Err(AppError::BadRequest("footprint too large".into())); }
    let fp = footprint::parse(&req.footprint).ok_or_else(|| AppError::BadRequest("no (footprint …) in the request".into()))?;
    let url = req.datasheet.filter(|u| u.starts_with("https://") || u.starts_with("http://")).or_else(|| datasheet_of(&fp));
    let a = model_for(&state, &fp, url).await?.ok_or(AppError::NotFound)?;
    Ok(reply(a, q.info.as_deref().map(|v| v == "1" || v == "true").unwrap_or(false)))
}

/// A KiCad library footprint's generated model (kicadlib.rs's last fallback): `(step, family)`.
pub async fn for_library(state: &AppState, text: &str) -> AppResult<Option<Response>> {
    let Some(fp) = footprint::parse(text) else { return Ok(None) };
    let url = datasheet_of(&fp);
    Ok(model_for(state, &fp, url).await?.map(|a| reply(a, false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datasheet_links_and_package_words() {
        let fp = footprint::parse(r#"(footprint "Package_SON:VSON-10-1EP_3x3mm_P0.5mm_EP1.65x2.4mm" (descr "VSON, 10 Pin (http://www.ti.com/lit/ds/symlink/tps63000.pdf#page=25)") (attr smd) (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu)))"#).unwrap();
        assert_eq!(datasheet_of(&fp).as_deref(), Some("https://www.ti.com/lit/ds/symlink/tps63000.pdf#page=25"));
        assert_eq!(package_words(&fp), vec!["VSON-10-1EP".to_string(), "VSON".to_string()]);
        // the same geometry under another reference shares its model
        let a = footprint::parse(r#"(footprint "R_0603" (property "Reference" "R1") (pad 1 smd rect (at -0.8 0) (size 0.8 0.9) (layers F.Cu)))"#).unwrap();
        let b = footprint::parse(r#"(footprint "R_0603" (property "Reference" "R7") (pad 1 smd rect (at -0.8 0) (size 0.8 0.9) (layers F.Cu)))"#).unwrap();
        assert_eq!(canonical(&a), canonical(&b));
    }
}

// ---------------------------------------------------------------- footprints from datasheets

/// The land pattern style a package name asks for.
pub fn style_of(package: &str) -> Option<super::footgen::Style> {
    use super::footgen::Style;
    let up = package.to_ascii_uppercase();
    if up.contains("QFN") || up.contains("LGA") || up.contains("LFCSP") || up.contains("MLF") { return Some(Style::NoLead4); }
    if up.contains("DFN") || up.contains("SON") { return Some(Style::NoLead2); }
    if up.contains("QFP") { return Some(Style::GullWing4); }
    if ["SOIC", "SSOP", "TSSOP", "MSOP", "VSSOP", "QSOP", "SOP", "SO-", "SOT", "SC-70", "SC70", "TSOT"].iter().any(|k| up.contains(k)) { return Some(Style::GullWing2); }
    if ["R_", "C_", "L_", "RES", "CAP", "IND"].iter().any(|k| up.starts_with(k)) || ["0201", "0402", "0603", "0805", "1206", "1210"].iter().any(|k| up.contains(k)) { return Some(Style::Chip); }
    None
}

#[derive(Deserialize)]
pub struct FootprintReq { datasheet: String, package: String, pins: usize, #[serde(default)] style: Option<super::footgen::Style> }

/// `POST /api/footprints/generate` `{datasheet, package, pins, style?}` — a footprint made from the
/// datasheet's package dimensions: `{name, kicad_mod, dims, how, page}`, or 422 with the reasons when no
/// drawing in the datasheet gives numbers that hang together for `pins` pins.  The pin count is the
/// symbol's, which is the check a footprint cannot do for itself.
pub async fn generate_footprint(State(state): State<AppState>, AuthUser(_user): AuthUser, Json(req): Json<FootprintReq>) -> AppResult<Response> {
    use super::footgen;
    let style = req.style.or_else(|| style_of(&req.package)).ok_or_else(|| AppError::BadRequest(format!("which land pattern does {} take? give style: gull_wing2, gull_wing4, no_lead2, no_lead4 or chip", req.package)))?;
    if req.pins == 0 || req.pins > 1024 { return Err(AppError::BadRequest("pins: the symbol's pin count".into())); }
    let url = req.datasheet.trim().replace("http://", "https://");
    let doc = crate::datasheet::pages(&state, &url).await?;
    let package = req.package.trim().to_string();
    let fam: String = package.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let words = vec![package.clone(), fam];
    let mut notes: Vec<String> = Vec::new();
    for c in dims::candidates(&doc, &words, req.pins).into_iter().take(8) {
        match footgen::land(style, req.pins, &c.dims, &package) {
            Ok(l) => return Ok(Json(json!({ "name": l.name, "kicad_mod": l.kicad_mod, "pads": l.pads, "courtyard": l.courtyard, "dims": c.dims, "how": "table", "page": c.page })).into_response()),
            Err(why) => notes.push(format!("page {}: {}", c.page, why.join("; "))),
        }
    }
    if ai::configured() {
        let query = format!("package outline mechanical dimensions millimeters {} {}", words.join(" "), req.pins);
        let pages: Vec<usize> = crate::datasheet::rank_pages(&doc, &query).into_iter().take(2).collect();
        let images = crate::datasheet::page_images(&state, &url, Some(pages.clone()), None, 1600).await.map(|(i, _, _)| i).unwrap_or_default();
        let texts: Vec<(usize, String)> = pages.iter().map(|&n| (n, doc.get(n - 1).cloned().unwrap_or_default())).collect();
        let ask = ai::Ask { family: &format!("{style:?}"), package_words: &words.join(" / "), pins: req.pins, pitch: None, pad_span: (0.0, 0.0) };
        let mut because: Option<String> = None;
        for _ in 0..2 {
            match ai::ask(&ask, &images, &texts, because.as_deref()).await {
                Ok((d, _, model)) => match footgen::land(style, req.pins, &d, &package) {
                    Ok(l) => return Ok(Json(json!({ "name": l.name, "kicad_mod": l.kicad_mod, "pads": l.pads, "courtyard": l.courtyard, "dims": d, "how": format!("ai:{model}"), "page": pages.first() })).into_response()),
                    Err(why) => { because = Some(why.join("; ")); notes.push(format!("{model}: {}", why.join("; "))); }
                },
                Err(e) => { notes.push(e); break; }
            }
        }
    } else { notes.push("no AI key configured for drawings without a text table".into()); }
    Err(AppError::Api(axum::http::StatusCode::UNPROCESSABLE_ENTITY, "no_dimensions", format!("No package drawing in the datasheet gives numbers that make a {}-pin {package}: {}", req.pins, notes.join(" | "))))
}
