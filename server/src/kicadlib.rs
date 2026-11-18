//! KiCad's official symbol and footprint libraries, read on demand from where the KiCad
//! project publishes them (gitlab.com/kicad/libraries).  Nothing is bundled or copied into
//! the database: a listing or an item is fetched when someone asks for it and kept in
//! memory for a while, so the design assistant (and anything else in the web editor) can
//! place `Device:R` or `MCU_RaspberryPi:RP2040` on a sheet that has never used it.
//!
//! - `GET /api/kicad-lib/list?kind=symbol|footprint[&lib=NAME]` — the libraries, or one
//!   library's items.
//! - `GET /api/kicad-lib/item?kind=…&lib=NAME&name=ITEM` — the item's file text.
//! - `GET /api/kicad-lib/model?lib=NAME&name=ITEM` — the STEP file of KiCad's 3D model library
//!   (`kind=model` in `list` names a library's models).
//! - `GET /api/kicad-lib/search?kind=…&q=WORDS` — items whose name holds every word, across
//!   all libraries.  The first search of a kind reads the whole listing (a few hundred small
//!   requests, about half a minute) and keeps it for a day.
//!
//! `KICAD_LIBS_URL` points at another host with the same layout (a mirror, or the test
//! stand-in); `KICAD_LIBS_REF` picks the branch or tag (default `master`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::AppState;

const LIST_TTL: Duration = Duration::from_secs(6 * 3600);
const ITEM_TTL: Duration = Duration::from_secs(24 * 3600);
const MAX_ITEM_BYTES: usize = 4 * 1024 * 1024;
const MAX_CACHED: usize = 4000;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).ok().map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default.into())
}
fn base() -> &'static str {
    static V: OnceLock<String> = OnceLock::new();
    V.get_or_init(|| env("KICAD_LIBS_URL", "https://gitlab.com"))
}
fn git_ref() -> &'static str {
    static V: OnceLock<String> = OnceLock::new();
    V.get_or_init(|| env("KICAD_LIBS_REF", "master"))
}
fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder().user_agent("kicad-collab-server").connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(25)).build().expect("http client")
    })
}
fn cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cached(key: &str, ttl: Duration) -> Option<Value> {
    let c = cache().lock().ok()?;
    c.get(key).filter(|(at, _)| at.elapsed() < ttl).map(|(_, v)| v.clone())
}
fn remember(key: String, v: &Value) {
    if let Ok(mut c) = cache().lock() {
        if c.len() >= MAX_CACHED { c.clear(); }
        c.insert(key, (Instant::now(), v.clone()));
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind { Symbol, Footprint, Model }
impl Kind {
    fn parse(s: &str) -> AppResult<Kind> {
        match s { "symbol" => Ok(Kind::Symbol), "footprint" => Ok(Kind::Footprint), "model" => Ok(Kind::Model), _ => Err(AppError::BadRequest("kind is symbol, footprint or model".into())) }
    }
    fn repo(self) -> &'static str { match self { Kind::Symbol => "kicad-symbols", Kind::Footprint => "kicad-footprints", Kind::Model => "kicad-packages3D" } }
    fn dir_ext(self) -> &'static str { match self { Kind::Symbol => ".kicad_symdir", Kind::Footprint => ".pretty", Kind::Model => ".3dshapes" } }
    fn file_ext(self) -> &'static str { match self { Kind::Symbol => ".kicad_sym", Kind::Footprint => ".kicad_mod", Kind::Model => ".step" } }
    fn word(self) -> &'static str { match self { Kind::Symbol => "symbol", Kind::Footprint => "footprint", Kind::Model => "model" } }
}

/// A library or item name as it may appear in a path: no separators, nothing that climbs.
fn safe(name: &str) -> AppResult<&str> {
    let ok = !name.is_empty() && name.len() <= 200 && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "_-+.,()= ".contains(c));
    if ok { Ok(name) } else { Err(AppError::BadRequest("bad library or item name".into())) }
}
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"_-.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
fn unreachable(what: &str) -> AppError {
    AppError::Api(StatusCode::BAD_GATEWAY, "kicad_libs_unreachable", format!("KiCad's library server could not be reached for {what}."))
}

/// Every entry name under `path` in the library repository (GitLab's tree API, all pages).
async fn tree(kind: Kind, path: &str) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    for page in 1..=40 {
        let url = format!("{}/api/v4/projects/kicad%2Flibraries%2F{}/repository/tree?ref={}&per_page=100&page={page}{}",
            base(), kind.repo(), enc(git_ref()), if path.is_empty() { String::new() } else { format!("&path={}", enc(path)) });
        let resp = http().get(&url).send().await.map_err(|_| unreachable("a library listing"))?;
        if resp.status() == StatusCode::NOT_FOUND { return Err(AppError::NotFound); }
        if !resp.status().is_success() { return Err(unreachable("a library listing")); }
        let rows: Vec<Value> = resp.json().await.map_err(|_| unreachable("a library listing"))?;
        let n = rows.len();
        names.extend(rows.iter().filter_map(|r| r.get("name").and_then(Value::as_str).map(str::to_string)));
        if n < 100 { break; }
    }
    Ok(names)
}

#[derive(Deserialize)]
pub struct ListQuery { kind: String, lib: Option<String> }

pub async fn list(AuthUser(_user): AuthUser, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let kind = Kind::parse(&q.kind)?;
    let lib = q.lib.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let key = format!("list:{}:{}", kind.word(), lib.unwrap_or(""));
    if let Some(v) = cached(&key, LIST_TTL) { return Ok(Json(v)); }
    let out = match lib {
        None => {
            let mut libs: Vec<String> = tree(kind, "").await?.into_iter().filter_map(|n| n.strip_suffix(kind.dir_ext()).map(str::to_string)).collect();
            libs.sort();
            json!({ "kind": kind.word(), "libraries": libs })
        }
        Some(lib) => {
            let lib = safe(lib)?;
            let mut items: Vec<String> = tree(kind, &format!("{lib}{}", kind.dir_ext())).await?.into_iter().filter_map(|n| n.strip_suffix(kind.file_ext()).map(str::to_string)).collect();
            if items.is_empty() { return Err(AppError::NotFound); }
            items.sort();
            json!({ "kind": kind.word(), "library": lib, "items": items })
        }
    };
    remember(key, &out);
    Ok(Json(out))
}

/// Every item of every library of a kind, as "Library:Name", sorted.
async fn index(kind: Kind) -> AppResult<std::sync::Arc<Vec<String>>> {
    type Slot = tokio::sync::Mutex<Option<(Instant, std::sync::Arc<Vec<String>>)>>;
    static SYM: OnceLock<Slot> = OnceLock::new();
    static FP: OnceLock<Slot> = OnceLock::new();
    static MODEL: OnceLock<Slot> = OnceLock::new();
    let slot = match kind { Kind::Symbol => &SYM, Kind::Footprint => &FP, Kind::Model => &MODEL }.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut guard = slot.lock().await;   // one build at a time; later callers wait for it and then read
    if let Some((at, v)) = guard.as_ref() { if at.elapsed() < ITEM_TTL { return Ok(v.clone()); } }
    let page_url = |page: usize| format!("{}/api/v4/projects/kicad%2Flibraries%2F{}/repository/tree?ref={}&recursive=true&per_page=100&page={page}", base(), kind.repo(), enc(git_ref()));
    let take = |rows: &[Value], out: &mut Vec<String>| {
        for r in rows {
            let Some(path) = r.get("path").and_then(Value::as_str) else { continue };
            let Some((dir, file)) = path.split_once('/') else { continue };
            if let (Some(lib), Some(name)) = (dir.strip_suffix(kind.dir_ext()), file.strip_suffix(kind.file_ext())) { out.push(format!("{lib}:{name}")); }
        }
    };
    // Eight pages at a time until one comes back short: the listing does not say how long it is
    // through every mirror, and a short page is the end either way.
    let mut items = Vec::new(); let mut page = 1usize; let mut done = false;
    while !done && page <= 800 {
        let batch: Vec<Option<Vec<Value>>> = futures_util::stream::iter(page..page + 8).map(|p| { let url = page_url(p); async move {
            let resp = http().get(&url).send().await.ok()?; if !resp.status().is_success() { return None; }
            resp.json::<Vec<Value>>().await.ok()
        } }).buffered(8).collect().await;
        for rows in batch {
            let rows = rows.ok_or_else(|| unreachable("the library index"))?;
            take(&rows, &mut items);
            if rows.len() < 100 { done = true; }
        }
        page += 8;
    }
    if items.is_empty() { return Err(unreachable("the library index")); }
    items.sort(); items.dedup();
    let v = std::sync::Arc::new(items);
    *guard = Some((Instant::now(), v.clone()));
    Ok(v)
}

#[derive(Deserialize)]
pub struct SearchQuery { kind: String, q: String }

pub async fn search(AuthUser(_user): AuthUser, Query(q): Query<SearchQuery>) -> AppResult<Json<Value>> {
    let kind = Kind::parse(&q.kind)?;
    let words: Vec<String> = q.q.to_lowercase().split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).map(str::to_string).collect();
    if words.is_empty() || q.q.len() > 200 { return Err(AppError::BadRequest("q is a few words of a library or item name".into())); }
    let all = index(kind).await?;
    let mut hits: Vec<&String> = all.iter().filter(|id| { let l = id.to_lowercase(); words.iter().all(|w| l.contains(w.as_str())) }).collect();
    let total = hits.len();
    // the closest names first: an exact item name, then the shortest
    let exact = |id: &str| words.len() == 1 && id.rsplit(':').next().map(|n| n.eq_ignore_ascii_case(&words[0])).unwrap_or(false);
    hits.sort_by(|a, b| exact(b).cmp(&exact(a)).then(a.len().cmp(&b.len())).then(a.cmp(b)));
    hits.truncate(80);
    Ok(Json(json!({ "kind": kind.word(), "query": q.q, "total": total, "items": hits })))
}

#[derive(Deserialize)]
pub struct ItemQuery { kind: String, lib: String, name: String }

pub async fn item(AuthUser(_user): AuthUser, Query(q): Query<ItemQuery>) -> AppResult<Json<Value>> {
    let kind = Kind::parse(&q.kind)?;
    if kind == Kind::Model { return Err(AppError::BadRequest("a 3D model is read from /api/kicad-lib/model".into())); }
    let (lib, name) = (safe(q.lib.trim())?, safe(q.name.trim())?);
    let key = format!("item:{}:{lib}:{name}", kind.word());
    if let Some(v) = cached(&key, ITEM_TTL) { return Ok(Json(v)); }
    let url = format!("{}/kicad/libraries/{}/-/raw/{}/{}{}/{}{}", base(), kind.repo(), enc(git_ref()), enc(lib), kind.dir_ext(), enc(name), kind.file_ext());
    let resp = http().get(&url).send().await.map_err(|_| unreachable("a library item"))?;
    if resp.status() == StatusCode::NOT_FOUND { return Err(AppError::NotFound); }
    if !resp.status().is_success() { return Err(unreachable("a library item")); }
    let text = resp.text().await.map_err(|_| unreachable("a library item"))?;
    let head = text.trim_start();
    if text.len() > MAX_ITEM_BYTES || !(head.starts_with("(kicad_symbol_lib") || head.starts_with("(footprint") || head.starts_with("(module")) {
        return Err(AppError::NotFound);   // a sign-in page or an error page, not a library file
    }
    let out = json!({ "kind": kind.word(), "library": lib, "name": name, "id": format!("{lib}:{name}"), "sexpr": text });
    remember(key, &out);
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ModelQuery { lib: String, name: String, fallback: Option<String>, generate: Option<String> }

/// A footprint file of KiCad's library (kept like `item`), for drawing its model.
async fn footprint_text(lib: &str, name: &str) -> Option<String> {
    let key = format!("item:footprint:{lib}:{name}");
    if let Some(v) = cached(&key, ITEM_TTL) { return v.get("sexpr").and_then(|s| s.as_str()).map(str::to_string); }
    let url = format!("{}/kicad/libraries/{}/-/raw/{}/{}{}/{}{}", base(), Kind::Footprint.repo(), enc(git_ref()), enc(lib), Kind::Footprint.dir_ext(), enc(name), Kind::Footprint.file_ext());
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let text = resp.text().await.ok()?;
    let head = text.trim_start();
    if text.len() > MAX_ITEM_BYTES || !(head.starts_with("(footprint") || head.starts_with("(module")) { return None; }
    remember(key, &json!({ "kind": "footprint", "library": lib, "name": name, "id": format!("{lib}:{name}"), "sexpr": text }));
    Some(text)
}

const MAX_MODEL_BYTES: usize = 24 * 1024 * 1024;

fn name_tokens(name: &str) -> Vec<String> {
    name.to_ascii_lowercase().split('_').filter(|t| !t.is_empty()).map(str::to_string).collect()
}

/// The model to show for a part whose own model (`lib`/`name`) KiCad's 3D library does not have,
/// out of `all` ("Library:Name", every model of the library).  In order:
/// the same name in another library; the longest model name that is the start of the wanted one
/// (a footprint variant such as `..._HandSolder` or `..._ThermalVias` shares its base package's
/// model); the shortest model name the wanted one is the start of (`SOIC-8` → `SOIC-8_3.9x4.9mm_P1.27mm`);
/// then, in the same library only, the model sharing the most leading words, when that is at least
/// three and at least half of the wanted name (another make of the same connector family).
/// The second value says how close it is: "same", "base", "variant" or "similar".
pub fn pick_replacement(lib: &str, name: &str, all: &[String]) -> Option<(String, String, &'static str)> {
    let want = name_tokens(name);
    if want.is_empty() { return None; }
    let split = |id: &'_ String| id.split_once(':').map(|(l, n)| (l.to_string(), n.to_string()));
    let same_lib = |l: &str| l.eq_ignore_ascii_case(lib);
    // 1. the very name, in another library (or this one under another letter case)
    let mut same: Vec<(String, String)> = all.iter().filter_map(split).filter(|(_, n)| n.eq_ignore_ascii_case(name)).collect();
    same.sort_by_key(|(l, _)| (!same_lib(l), l.clone()));
    if let Some((l, n)) = same.into_iter().next() { return Some((l, n, "same")); }
    let mut base: Option<(usize, bool, String, String)> = None;       // longest prefix of the wanted name
    let mut variant: Option<(usize, bool, String, String)> = None;    // shortest name the wanted one starts
    let mut similar: Option<(usize, usize, String, String)> = None;   // most shared leading words, same library
    for id in all {
        let Some((l, n)) = split(id) else { continue };
        let have = name_tokens(&n);
        if have.is_empty() { continue; }
        let common = want.iter().zip(have.iter()).take_while(|(a, b)| a == b).count();
        let here = same_lib(&l);
        // one word alone names a package only when it carries a number (SOIC-8, 0603), never "R" or "USB"
        let telling = |t: &[String]| t.len() >= 2 || t[0].chars().any(|c| c.is_ascii_digit());
        if common == have.len() && have.len() < want.len() && telling(&have) {
            let better = match &base { None => true, Some((len, h, ..)) => have.len() > *len || (have.len() == *len && here && !*h) };
            if better { base = Some((have.len(), here, l.clone(), n.clone())); }
        } else if common == want.len() && have.len() > want.len() && telling(&want) {
            let better = match &variant { None => true, Some((len, h, ..)) => (here && !*h) || (here == *h && have.len() < *len) };
            if better { variant = Some((have.len(), here, l.clone(), n.clone())); }
        } else if here && common >= 3 && common * 2 >= want.len() {
            let gap = have.len().abs_diff(want.len());
            let better = match &similar { None => true, Some((c, g, ..)) => common > *c || (common == *c && gap < *g) };
            if better { similar = Some((common, gap, l.clone(), n.clone())); }
        }
    }
    if let Some((_, _, l, n)) = base { return Some((l, n, "base")); }
    if let Some((_, _, l, n)) = variant { return Some((l, n, "variant")); }
    similar.map(|(_, _, l, n)| (l, n, "similar"))
}

/// The STEP file of `lib`/`name`: from the store, else from KiCad's library (and then stored).
/// `Ok(None)` when the library has no such model.
async fn model_bytes(state: &AppState, lib: &str, name: &str) -> AppResult<Option<Vec<u8>>> {
    let key = format!("kicad:{}:{lib}/{name}", git_ref());
    if let Some(bytes) = sqlx::query_scalar::<_, Vec<u8>>("SELECT step FROM part_models WHERE uuid = $1").bind(&key).fetch_optional(&state.pool).await? {
        return Ok(Some(bytes));
    }
    let miss = format!("model-miss:{key}");
    if cached(&miss, ITEM_TTL).is_some() { return Ok(None); }
    let url = format!("{}/kicad/libraries/{}/-/raw/{}/{}{}/{}{}", base(), Kind::Model.repo(), enc(git_ref()), enc(lib), Kind::Model.dir_ext(), enc(name), Kind::Model.file_ext());
    let resp = http().get(&url).send().await.map_err(|_| unreachable("a 3D model"))?;
    if resp.status() == StatusCode::NOT_FOUND { remember(miss, &Value::Bool(true)); return Ok(None); }
    if !resp.status().is_success() { return Err(unreachable("a 3D model")); }
    let bytes = resp.bytes().await.map_err(|_| unreachable("a 3D model"))?.to_vec();
    if bytes.len() > MAX_MODEL_BYTES || !bytes.starts_with(b"ISO-10303-21") {
        remember(miss, &Value::Bool(true));
        return Ok(None);   // a sign-in page or an error page, not a STEP file
    }
    sqlx::query("INSERT INTO part_models (uuid, step) VALUES ($1, $2) ON CONFLICT (uuid) DO NOTHING").bind(&key).bind(&bytes).execute(&state.pool).await?;
    Ok(Some(bytes))
}

/// The replacement for a model the library does not have, remembered per name (the answer only
/// changes when the library does).
async fn replacement(lib: &str, name: &str) -> AppResult<Option<(String, String, String)>> {
    let key = format!("model-match:{}:{lib}/{name}", git_ref());
    if let Some(v) = cached(&key, ITEM_TTL) {
        return Ok(v.as_array().and_then(|a| Some((a.first()?.as_str()?.to_string(), a.get(1)?.as_str()?.to_string(), a.get(2)?.as_str()?.to_string()))));
    }
    let all = index(Kind::Model).await?;
    let hit = pick_replacement(lib, name, &all).map(|(l, n, how)| (l, n, how.to_string()));
    remember(key, &match &hit { Some((l, n, how)) => json!([l, n, how]), None => Value::Null });
    Ok(hit)
}

/// `GET /api/kicad-lib/model?lib=NAME&name=ITEM[&fallback=1]` — the STEP model of KiCad's 3D library
/// (`NAME.3dshapes/ITEM.step`), for the 3D viewer.  Fetched once and kept beside the vendor
/// models, since a model never changes under its name and a board asks for the same few
/// dozen again and again; a model the library does not have is remembered for a while too.
/// With `fallback`, a model the library does not have is answered with the closest one it does
/// have (see `pick_replacement`), named in the `X-Model-Replacement` header as `Library/Name`.
pub async fn model(State(state): State<AppState>, AuthUser(_user): AuthUser, Query(q): Query<ModelQuery>) -> AppResult<Response> {
    let (lib, name) = (safe(q.lib.trim())?, safe(q.name.trim())?);
    let reply = |bytes: Vec<u8>| ([(header::CONTENT_TYPE, "model/step"), (header::CACHE_CONTROL, "private, max-age=604800")], bytes).into_response();
    if let Some(bytes) = model_bytes(&state, lib, name).await? { return Ok(reply(bytes)); }
    if q.fallback.as_deref().map(|v| !v.is_empty() && v != "0").unwrap_or(false) {
        let hit = replacement(lib, name).await?;
        // another make of the same family ("similar") can sit wrong on these pads: a model drawn from the
        // footprint itself (modelgen) comes first, when the footprint is KiCad's own
        let close = hit.as_ref().map(|(_, _, how)| how != "similar").unwrap_or(false);
        if !close && q.generate.as_deref() != Some("0") {
            if let Some(text) = footprint_text(lib, name).await {
                if let Some(mut resp) = crate::modelgen::service::for_library(&state, &text).await? {
                    resp.headers_mut().insert("x-model-match", header::HeaderValue::from_static("generated"));
                    return Ok(resp);
                }
            }
        }
        if let Some((l, n, how)) = hit {
            if let (Ok(l), Ok(n)) = (safe(&l), safe(&n)) {
                if let Some(bytes) = model_bytes(&state, l, n).await? {
                    let mut resp = reply(bytes);
                    if let Ok(v) = header::HeaderValue::from_str(&format!("{l}/{n}")) { resp.headers_mut().insert("x-model-replacement", v); }
                    if let Ok(v) = header::HeaderValue::from_str(&how) { resp.headers_mut().insert("x-model-match", v); }
                    return Ok(resp);
                }
            }
        }
    }
    Err(AppError::NotFound)
}

/// `GET /api/kicad-lib/model-match?lib=NAME&name=ITEM` — which model the 3D view shows for that
/// name: `{library, name, match}` with match "exact" when the library has it, else the kind of
/// replacement ("same", "base", "variant", "similar"); 404 when nothing comes close.
pub async fn model_match(State(_state): State<AppState>, AuthUser(_user): AuthUser, Query(q): Query<ModelQuery>) -> AppResult<Json<Value>> {
    let (lib, name) = (safe(q.lib.trim())?, safe(q.name.trim())?);
    let all = index(Kind::Model).await?;
    let id = format!("{lib}:{name}");
    if all.binary_search(&id).is_ok() { return Ok(Json(json!({ "library": lib, "name": name, "match": "exact" }))); }
    match replacement(lib, name).await? {
        Some((l, n, how)) => Ok(Json(json!({ "library": l, "name": n, "match": how }))),
        None => Err(AppError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_models() {
        let all: Vec<String> = ["Resistor_SMD:R_0603_1608Metric", "Resistor_SMD:R_0805_2012Metric", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "Package_SO:SOIC-8_5.3x5.3mm_P1.27mm_Wide",
            "Connector_USB:USB_C_Receptacle_GCT_USB4085", "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal", "Connector_USB:USB_Micro-B_Molex_47346-0001", "Button_Switch_SMD:SW_SPST_B3U-1000P"]
            .iter().map(|s| s.to_string()).collect();
        let pick = |l: &str, n: &str| pick_replacement(l, n, &all).map(|(l, n, how)| format!("{l}/{n} {how}"));
        // a hand-solder variant of a footprint shares the base package's model
        assert_eq!(pick("Resistor_SMD", "R_0603_1608Metric_Pad0.98x0.95mm_HandSolder").as_deref(), Some("Resistor_SMD/R_0603_1608Metric base"));
        // the same name under a library of the project's own
        assert_eq!(pick("MyParts", "SW_SPST_B3U-1000P").as_deref(), Some("Button_Switch_SMD/SW_SPST_B3U-1000P same"));
        // a short package name: the plainest model that begins with it
        assert_eq!(pick("Package_SO", "SOIC-8").as_deref(), Some("Package_SO/SOIC-8_3.9x4.9mm_P1.27mm variant"));
        // another make of the same connector family, in the same library only
        assert_eq!(pick("Connector_USB", "USB_C_Receptacle_HRO_TYPE-C-31-M-12").as_deref(), Some("Connector_USB/USB_C_Receptacle_GCT_USB4085 similar"));
        assert_eq!(pick("Other", "USB_C_Receptacle_HRO_TYPE-C-31-M-12"), None);
        // one word without a number names nothing, and a different size is never offered
        assert_eq!(pick("Resistor_SMD", "R"), None);
        assert_eq!(pick("Resistor_SMD", "R_1206_3216Metric"), None);
        assert_eq!(pick("LCSC", "C2040_QFN-56"), None);
    }

    #[test]
    fn names_cannot_leave_the_library() {
        assert!(safe("Device").is_ok());
        assert!(safe("QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm").is_ok());
        assert!(safe("USB_C_Receptacle_USB2.0_14P").is_ok());
        assert!(safe("../etc").is_err());
        assert!(safe("a/b").is_err());
        assert!(safe("").is_err());
        assert_eq!(enc("C_0402 (1005)"), "C_0402%20%281005%29");
    }
}
