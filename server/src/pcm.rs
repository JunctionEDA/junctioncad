//! KiCad's official plugins for the web editor.
//!
//! The desktop installs plugins from KiCad's Plugin and Content Manager repository.  The web
//! editor runs the same Python packages inside the plugin sandbox (web/domains/pcb/plugins/pyruntime.ts:
//! CPython compiled to WebAssembly, with `pcbnew` and `wx` provided over the collaborative
//! board), so this module does the two things a browser cannot: read the repository's package
//! list, and download and unpack one package.  What it hands back goes through the same
//! consent sheet and the same per-account store as any other plugin (plugins.rs).
//!
//! The server only ever fetches the repository index and the download addresses that index
//! names; nothing in a request chooses an address.  `KC_PCM_REPOSITORY` points it at another
//! index (tests use a local one).
//!
//! Network access for an official plugin (`POST /api/plugins/pcm/{identifier}/fetch`): the
//! sandbox cannot open connections, so a plugin the person granted "network" has its HTTP
//! requests carried by this server.  The server decides where they may go, not the request:
//! only to the web addresses the plugin's own package names (read from KiCad's repository
//! here, never from the client), only over https, only to public addresses, with size and
//! rate limits.  `KC_PLUGIN_NETWORK=off` turns it off.  A self-hosted service (a library server
//! whose address the person types into the plugin) is reached only after the person approved that
//! host name for that plugin (`POST /api/plugins/pcm/{identifier}/hosts`, table plugin_net_hosts);
//! the https and public-address rules hold for it too.
//!
//! It also serves the Python runtime itself (`/static/pyodide/…`): the interpreter, its
//! standard library and our shim modules, readable from the sandbox's opaque origin.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::AppState;

const DEFAULT_REPOSITORY: &str = "https://repository.kicad.org/repository.json";
const INDEX_TTL: Duration = Duration::from_secs(3600);
const MAX_INDEX_BYTES: usize = 24 * 1024 * 1024;
const MAX_ZIP_BYTES: usize = 24 * 1024 * 1024;
/// What one Python plugin may hold once unpacked (plugins.rs enforces the same on install).
pub const MAX_PY_FILES: usize = 1500;
pub const MAX_PY_BYTES: usize = 40 * 1024 * 1024;
const MAX_ONE_FILE: usize = 4 * 1024 * 1024;

/// The permissions every KiCad Python plugin is given: what `pcbnew` and `wx` need.  One that talks to
/// web services is offered "network" as well (see `get`).
pub const PY_PERMISSIONS: &[&str] = &["design:read", "design:write", "view", "files:import", "files:export"];

/// How each official plugin fared against the web runtime (scripts/plugins-python.mjs).
const COMPAT: &str = include_str!("../plugins/python/compat.json");

fn bad(msg: impl Into<String>) -> AppError {
    AppError::BadRequest(msg.into())
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .user_agent("kicad-collab-server (plugin repository)")
            .build()
            .unwrap_or_default()
    })
}

/// For the one large download (the repository's icons), which may take minutes.
fn slow_http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .user_agent("kicad-collab-server (plugin repository)")
            .build()
            .unwrap_or_default()
    })
}

async fn fetch(url: &str, limit: usize) -> AppResult<Vec<u8>> {
    fetch_with(http(), url, limit).await
}

async fn fetch_with(client: &reqwest::Client, url: &str, limit: usize) -> AppResult<Vec<u8>> {
    let local = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if !url.starts_with("https://") && !(local && std::env::var("KC_PCM_REPOSITORY").is_ok()) {
        return Err(bad("the plugin repository named an address that is not https"));
    }
    let resp = client.get(url).send().await.map_err(|e| bad(format!("could not reach {}: {e}", host_of(url))))?;
    if !resp.status().is_success() {
        return Err(bad(format!("{} answered {}", host_of(url), resp.status().as_u16())));
    }
    let body = resp.bytes().await.map_err(|e| bad(format!("the download from {} was cut off: {e}", host_of(url))))?;
    if body.len() > limit {
        return Err(bad("that download is larger than the web editor accepts"));
    }
    Ok(body.to_vec())
}

fn host_of(url: &str) -> &str {
    url.split("//").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

/// The repository's plugin packages.
pub struct Repo {
    packages: Vec<Value>,
}
type Index = Arc<Repo>;
type Icons = Arc<HashMap<String, Arc<Vec<u8>>>>;

const MAX_ICON_BYTES: usize = 256 * 1024;
const MAX_RESOURCES_BYTES: usize = 96 * 1024 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The icons KiCad's Plugin and Content Manager shows, by plugin identifier.  They come from the repository's resources
/// archive, a large download that is fetched in the background so that it never holds the list back.
fn icon_store() -> &'static std::sync::RwLock<Icons> {
    static ICONS: OnceLock<std::sync::RwLock<Icons>> = OnceLock::new();
    ICONS.get_or_init(|| std::sync::RwLock::new(Arc::new(HashMap::new())))
}
static ICONS_LOADING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn icons() -> Icons {
    icon_store().read().map(|g| g.clone()).unwrap_or_default()
}

/// Read `<identifier>/icon.png` out of the resources archive.  Only real PNG files of a sane size are kept.
fn icons_in(raw: Vec<u8>) -> HashMap<String, Arc<Vec<u8>>> {
    let mut out = HashMap::new();
    let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(raw)) else { return out };
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else { continue };
        let name = entry.name().replace('\\', "/");
        let Some(identifier) = name.strip_suffix("/icon.png") else { continue };
        if identifier.is_empty() || identifier.contains('/') || entry.size() as usize > MAX_ICON_BYTES {
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if (&mut entry).take(MAX_ICON_BYTES as u64 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > MAX_ICON_BYTES || !bytes.starts_with(PNG_MAGIC) {
            continue;
        }
        out.insert(identifier.to_string(), Arc::new(bytes));
    }
    out
}

/// Fetch the icons in the background.  An archive that is missing, broken or does not match its checksum leaves the
/// icons as they were.
fn load_icons(repo: &Value) {
    use std::sync::atomic::Ordering;
    let Some(url) = repo.pointer("/resources/url").and_then(Value::as_str).map(str::to_string) else { return };
    let want = repo.pointer("/resources/sha256").and_then(Value::as_str).map(str::to_string);
    if ICONS_LOADING.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let got = tokio::time::timeout(Duration::from_secs(300), fetch_with(slow_http(), &url, MAX_RESOURCES_BYTES)).await;
        if let Ok(Ok(raw)) = got {
            if want.map_or(true, |w| w.eq_ignore_ascii_case(&hex(&Sha256::digest(&raw)))) {
                if let Ok(found) = tokio::task::spawn_blocking(move || icons_in(raw)).await {
                    if !found.is_empty() {
                        if let Ok(mut slot) = icon_store().write() {
                            *slot = Arc::new(found);
                        }
                    }
                }
            } else {
                tracing::warn!("the plugin repository's resources archive does not match its checksum");
            }
        } else {
            tracing::warn!("the plugin repository's icons could not be downloaded");
        }
        ICONS_LOADING.store(false, Ordering::SeqCst);
    });
}

async fn load_index() -> AppResult<Index> {
    let repo_url = std::env::var("KC_PCM_REPOSITORY").unwrap_or_else(|_| DEFAULT_REPOSITORY.to_string());
    let repo: Value = serde_json::from_slice(&fetch(&repo_url, MAX_INDEX_BYTES).await?).map_err(|_| bad("KiCad's plugin repository sent something that is not JSON"))?;
    let packages_url = repo.pointer("/packages/url").and_then(Value::as_str).ok_or_else(|| bad("KiCad's plugin repository names no package list"))?;
    let raw = fetch(packages_url, MAX_INDEX_BYTES).await?;
    if let Some(want) = repo.pointer("/packages/sha256").and_then(Value::as_str) {
        if !want.eq_ignore_ascii_case(&hex(&Sha256::digest(&raw))) {
            return Err(bad("KiCad's package list does not match its checksum"));
        }
    }
    let list: Value = serde_json::from_slice(&raw).map_err(|_| bad("KiCad's package list is not JSON"))?;
    let packages = list.get("packages").and_then(Value::as_array).cloned().unwrap_or_default();
    let packages = packages.into_iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("plugin")).collect();
    load_icons(&repo);
    Ok(Arc::new(Repo { packages }))
}

fn index_cache() -> &'static tokio::sync::Mutex<Option<(Instant, Index)>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<(Instant, Index)>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// The repository's plugin packages, cached for an hour.  Once there is a list, it is always answered at once: a list
/// that has grown old is refreshed in the background, and a repository that is briefly unreachable does not take it away.
async fn index() -> AppResult<Index> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static REFRESHING: AtomicBool = AtomicBool::new(false);
    let mut slot = index_cache().lock().await;
    if let Some((at, idx)) = slot.as_ref() {
        if at.elapsed() >= INDEX_TTL && !REFRESHING.swap(true, Ordering::SeqCst) {
            tokio::spawn(async {
                let loaded = tokio::time::timeout(Duration::from_secs(60), load_index()).await;
                let mut slot = index_cache().lock().await;
                match loaded {
                    Ok(Ok(idx)) => *slot = Some((Instant::now(), idx)),
                    // try again in five minutes, not on every request
                    _ => {
                        if let Some((at, _)) = slot.as_mut() {
                            *at = Instant::now() - INDEX_TTL + Duration::from_secs(300);
                        }
                    }
                }
                REFRESHING.store(false, Ordering::SeqCst);
            });
        }
        return Ok(idx.clone());
    }
    let idx = tokio::time::timeout(Duration::from_secs(40), load_index()).await.map_err(|_| bad("KiCad's plugin repository did not answer in time"))??;
    *slot = Some((Instant::now(), idx.clone()));
    Ok(idx)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The version of a package the web runtime should install: the newest listed one.
fn pick_version(pkg: &Value) -> Option<&Value> {
    let versions = pkg.get("versions").and_then(Value::as_array)?;
    versions.iter().rev().find(|v| v.get("download_url").and_then(Value::as_str).is_some() && v.get("status").and_then(Value::as_str) != Some("deprecated")).or_else(|| versions.iter().rev().find(|v| v.get("download_url").is_some()))
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", s[..end].trim_end())
}

fn runtime_of(version: &Value) -> &str {
    match version.get("runtime").and_then(Value::as_str) {
        Some("ipc") => "ipc",
        _ => "swig",
    }
}

fn compat_of(identifier: &str) -> Value {
    static TABLE: OnceLock<Value> = OnceLock::new();
    let table = TABLE.get_or_init(|| serde_json::from_str(COMPAT).unwrap_or(Value::Null));
    table.get(identifier).cloned().unwrap_or(Value::Null)
}

/// The manifest a PCM package gets in the web plugin store.
fn manifest_of(pkg: &Value, version: &Value) -> Value {
    let s = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    json!({
        "identifier": s(pkg, "identifier"),
        "name": clip(&s(pkg, "name"), 200),
        "description": clip(&s(pkg, "description"), 500),
        "version": clip(&s(version, "version"), 40),
        "author": clip(pkg.pointer("/author/name").and_then(Value::as_str).unwrap_or(""), 120),
        "homepage": pkg.pointer("/resources/homepage").and_then(Value::as_str).filter(|u| u.starts_with("https://")).unwrap_or(""),
        "license": clip(&s(pkg, "license"), 60),
        "runtime": { "type": "kicad-python", "api": runtime_of(version) },
        "permissions": PY_PERMISSIONS,
    })
}

/// The catalog entries for a repository's plugin packages, in name order.  `icon` says whether a package's icon is known
/// to exist (true), is worth asking for (null) or is missing (false); `compat` is KiCad's own repository's test labels.
fn entries_of(packages: &[Value], icon: impl Fn(&str) -> Value, compat: bool) -> Vec<Value> {
    let mut out = Vec::with_capacity(packages.len());
    for pkg in packages.iter() {
        let Some(version) = pick_version(pkg) else { continue };
        let identifier = pkg.get("identifier").and_then(Value::as_str).unwrap_or("");
        if identifier.is_empty() {
            continue;
        }
        out.push(json!({
            "identifier": identifier,
            "manifest": manifest_of(pkg, version),
            "details": clip(pkg.get("description_full").and_then(Value::as_str).unwrap_or(""), 1500),
            "size": version.get("download_size").and_then(Value::as_u64).unwrap_or(0),
            "compat": if compat { compat_of(identifier) } else { Value::Null },
            "icon": icon(identifier),
        }));
    }
    out.sort_by(|a, b| {
        let name = |v: &Value| v.pointer("/manifest/name").and_then(Value::as_str).unwrap_or("").to_lowercase();
        name(a).cmp(&name(b))
    });
    out
}

/// `GET /api/plugins/pcm` — KiCad's official plugins, with how each fares in the web editor.
pub async fn list() -> AppResult<Json<Value>> {
    let idx = index().await?;
    let have = icons();
    let alone = icon_base().is_some();
    let out = entries_of(&idx.packages, |id| if have.contains_key(id) { json!(true) } else if alone { Value::Null } else { json!(false) }, true);
    // "iconsPending": the icons are still being downloaded; the list is worth asking for again shortly
    Ok(Json(json!({ "plugins": out, "iconsPending": ICONS_LOADING.load(std::sync::atomic::Ordering::SeqCst) })))
}

/// Where one plugin's icon is kept when the resources archive has not delivered it: KiCad's metadata repository,
/// the source the archive is built from (`packages/<identifier>/icon.png`).  `KC_PCM_ICONS` names another base
/// address, or `off`.  With a repository of your own (`KC_PCM_REPOSITORY`) and no `KC_PCM_ICONS`, there is none.
const DEFAULT_ICONS: &str = "https://gitlab.com/kicad/addons/metadata/-/raw/main/packages";

fn icon_base() -> Option<String> {
    match std::env::var("KC_PCM_ICONS") {
        Ok(v) if v.eq_ignore_ascii_case("off") || v.is_empty() => None,
        Ok(v) => Some(v.trim_end_matches('/').to_string()),
        Err(_) if std::env::var("KC_PCM_REPOSITORY").is_ok() => None,
        Err(_) => Some(DEFAULT_ICONS.to_string()),
    }
}

/// One plugin's icon, fetched on its own and remembered (a miss is remembered for an hour too).
async fn icon_alone(identifier: &str) -> Option<Arc<Vec<u8>>> {
    type Slot = (Instant, Option<Arc<Vec<u8>>>);
    static ONE: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let table = ONE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, got)) = table.lock().ok()?.get(identifier) {
        if got.is_some() || at.elapsed() < INDEX_TTL {
            return got.clone();
        }
    }
    let base = icon_base()?;
    // only for a plugin the repository lists, so the address is never made from what a browser sent
    let idx = index().await.ok()?;
    if !idx.packages.iter().any(|p| p.get("identifier").and_then(Value::as_str) == Some(identifier)) {
        return None;
    }
    if !identifier.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) || identifier.contains("..") {
        return None;
    }
    let _turn = GATE.get_or_init(|| tokio::sync::Semaphore::new(8)).acquire().await.ok()?;
    if let Some((at, got)) = table.lock().ok()?.get(identifier) {
        if got.is_some() || at.elapsed() < INDEX_TTL {
            return got.clone();
        }
    }
    let got = match tokio::time::timeout(Duration::from_secs(20), fetch(&format!("{base}/{identifier}/icon.png"), MAX_ICON_BYTES)).await {
        Ok(Ok(bytes)) if bytes.starts_with(PNG_MAGIC) => Some(Arc::new(bytes)),
        _ => None,
    };
    if let Ok(mut t) = table.lock() {
        t.insert(identifier.to_string(), (Instant::now(), got.clone()));
    }
    got
}

/// `GET /api/plugins/pcm/{identifier}/icon` — the plugin's icon from KiCad's repository, a PNG.
pub async fn icon(Path(identifier): Path<String>) -> Response {
    let found = match icons().get(&identifier) {
        Some(bytes) => Some(bytes.clone()),
        None => icon_alone(&identifier).await,
    };
    match found {
        Some(bytes) => (
            [(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "public, max-age=3600"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
            bytes.as_ref().clone(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn is_text(path: &str, body: &[u8]) -> bool {
    const TEXT: &[&str] = &[
        "py", "pyi", "json", "txt", "md", "rst", "csv", "tsv", "xml", "xrc", "html", "htm", "css", "js", "yaml", "yml", "toml", "ini", "cfg", "conf", "fbp", "svg", "po", "pot", "lua",
        "sh", "bat", "in", "tpl", "template", "dru", "net", "cmp", "pro", "lib", "mod", "dcm", "kicad_pcb", "kicad_sch", "kicad_sym", "kicad_mod", "kicad_pro", "kicad_dru", "kicad_wks",
    ];
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    TEXT.contains(&ext.as_str()) && !body.contains(&0) && std::str::from_utf8(body).is_ok()
}

/// A compiled library or program for a desktop operating system.
fn is_native(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "so" | "pyd" | "dylib" | "dll" | "exe")
}

/// A file name the Python runtime can be handed (it only ever names a file in the sandbox's own memory).
pub fn valid_py_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 240 && !p.starts_with('/') && !p.contains("..") && !p.contains("//") && !p.contains('\\') && p.chars().all(|c| !c.is_control())
}

/// Unpack a PCM archive into the files the runtime needs: `plugins/`, `resources/` and `metadata.json`.
fn unpack(zip_bytes: Vec<u8>) -> AppResult<Map<String, Value>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|_| bad("the package is not a zip archive"))?;
    let mut files = Map::new();
    let mut total = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| bad("the package archive is damaged"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/")) else { continue };
        let wanted = name == "metadata.json" || name.starts_with("plugins/") || name.starts_with("resources/");
        if !wanted || !valid_py_path(&name) || name.contains("/__pycache__/") || name.ends_with(".pyc") || name.contains("/.git/") {
            continue;
        }
        // Machine code for Windows, macOS or Linux cannot load in a browser.  Its name is kept, empty, so a plugin that
        // looks for the file still finds one and the runtime can tell which compiled module the plugin expects.
        if is_native(&name) {
            files.insert(name, Value::String(String::new()));
            continue;
        }
        if entry.size() as usize > MAX_ONE_FILE {
            continue;
        }
        let mut body = Vec::with_capacity(entry.size() as usize);
        entry.by_ref().take(MAX_ONE_FILE as u64 + 1).read_to_end(&mut body).map_err(|_| bad("the package archive is damaged"))?;
        if body.len() > MAX_ONE_FILE {
            continue;
        }
        let stored = if is_text(&name, &body) { String::from_utf8(body).unwrap_or_default() } else { format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&body)) };
        total += stored.len();
        if total > MAX_PY_BYTES || files.len() >= MAX_PY_FILES {
            return Err(bad("this plugin is larger than the web editor can hold (40 MB unpacked)"));
        }
        files.insert(name, Value::String(stored));
    }
    if !files.keys().any(|k| k.starts_with("plugins/")) {
        return Err(bad("the package holds no plugin code"));
    }
    Ok(files)
}

/// Download and unpack one official package: its repository entry, the version picked, its files.
async fn load(identifier: &str) -> AppResult<(Value, Value, Map<String, Value>)> {
    let idx = index().await?;
    load_from(&idx.packages, identifier, false).await
}

/// Download and unpack one package of a repository's list.  `public`: the repository is one a person added, so every
/// address it names is checked to be on the public internet (`fetch_public`).
async fn load_from(packages: &[Value], identifier: &str, public: bool) -> AppResult<(Value, Value, Map<String, Value>)> {
    let pkg = packages.iter().find(|p| p.get("identifier").and_then(Value::as_str) == Some(identifier)).ok_or(AppError::NotFound)?;
    let version = pick_version(pkg).ok_or_else(|| bad("that plugin has no downloadable version"))?;
    let url = version.get("download_url").and_then(Value::as_str).unwrap_or("");
    let zip_bytes = if public { fetch_public(url, MAX_ZIP_BYTES).await? } else { fetch(url, MAX_ZIP_BYTES).await? };
    if let Some(want) = version.get("download_sha256").and_then(Value::as_str) {
        if !want.eq_ignore_ascii_case(&hex(&Sha256::digest(&zip_bytes))) {
            return Err(bad("the download does not match the checksum its repository lists for it"));
        }
    }
    let files = tokio::task::spawn_blocking(move || unpack(zip_bytes)).await.map_err(|_| bad("the package could not be unpacked"))??;
    Ok((pkg.clone(), version.clone(), files))
}

/// The manifest a downloaded package is installed with.  A plugin that talks to web services may ask for "network":
/// requests to the addresses its own code names (remembered under `key`, read back by `net_fetch`).
fn install_manifest(key: &str, pkg: &Value, version: &Value, files: &Map<String, Value>) -> Value {
    let mut manifest = manifest_of(pkg, version);
    let hosts = remember_hosts(key, files);
    if net_mode() != NetMode::Off && !hosts.is_empty() && uses_network(files) {
        let mut list: Vec<&String> = hosts.iter().collect();
        list.sort();
        if let Some(perms) = manifest.get_mut("permissions").and_then(Value::as_array_mut) {
            perms.push(json!("network"));
        }
        manifest["network"] = json!({ "hosts": list });
    }
    manifest
}

/// `GET /api/plugins/pcm/{identifier}` — download one official plugin and hand its manifest and files to the browser.
pub async fn get(AuthUser(_user): AuthUser, Path(identifier): Path<String>) -> AppResult<Json<Value>> {
    let (pkg, version, files) = load(&identifier).await?;
    let ver = version.get("version").and_then(Value::as_str).unwrap_or("");
    let manifest = install_manifest(&identifier, &pkg, &version, &files);
    Ok(Json(json!({ "manifest": manifest, "files": files, "source": format!("kicad:{ver}"), "compat": compat_of(&identifier) })))
}

// ---------------------------------------------------------------- network access for an official plugin

const NET_MAX_REQUEST: usize = 16 * 1024 * 1024;
const NET_MAX_RESPONSE: usize = 24 * 1024 * 1024;
const NET_PER_MINUTE: usize = 240;
const NET_MAX_HOSTS: usize = 200;

#[derive(Clone, Copy, PartialEq, Eq)]
enum NetMode {
    On,
    Off,
    /// Tests only: plain http and this machine's own addresses are allowed, so a test can stand in for a web service.
    Test,
}

fn net_mode() -> NetMode {
    match std::env::var("KC_PLUGIN_NETWORK").unwrap_or_default().to_ascii_lowercase().as_str() {
        "off" | "0" | "false" | "no" => NetMode::Off,
        "test" => NetMode::Test,
        _ => NetMode::On,
    }
}

/// The part of a host name that identifies whose it is: `api.nextpcb.com` and `www.nextpcb.com` are both `nextpcb.com`.
fn base_domain(host: &str) -> String {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.parse::<IpAddr>().is_ok() {
        return h;
    }
    let labels: Vec<&str> = h.split('.').collect();
    if labels.len() <= 2 {
        return h;
    }
    const SECOND: &[&str] = &["co", "com", "net", "org", "gov", "edu", "ac"];
    let n = if labels[labels.len() - 1].len() == 2 && SECOND.contains(&labels[labels.len() - 2]) { 3 } else { 2 };
    labels[labels.len() - n..].join(".")
}

/// The web addresses a package names in its own files, as base domains.
fn hosts_in(files: &Map<String, Value>) -> HashSet<String> {
    let mut out = HashSet::new();
    for (path, body) in files {
        let Some(text) = body.as_str() else { continue };
        if !path.starts_with("plugins/") || text.starts_with("base64:") {
            continue;
        }
        for marker in ["https://", "http://"] {
            let mut rest = text;
            while let Some(at) = rest.find(marker) {
                rest = &rest[at + marker.len()..];
                let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')).unwrap_or(rest.len());
                let host = rest[..end].trim_matches('.').to_ascii_lowercase();
                let named = host.contains('.') && host.rsplit('.').next().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
                let local = net_mode() == NetMode::Test && host.parse::<Ipv4Addr>().is_ok();
                if (named || local) && host.len() <= 253 && out.len() < NET_MAX_HOSTS {
                    out.insert(base_domain(&host));
                }
            }
        }
    }
    out
}

/// Whether the package's Python reaches for the network at all.
fn uses_network(files: &Map<String, Value>) -> bool {
    const MARKS: &[&str] = &["import requests", "from requests", "urllib.request", "urllib2", "http.client", "httplib", "import urllib3", "from urllib3", "import socket", "from socket", "aiohttp", "httpx"];
    files.iter().any(|(path, body)| path.ends_with(".py") && body.as_str().is_some_and(|t| MARKS.iter().any(|m| t.contains(m))))
}

fn host_table() -> &'static Mutex<HashMap<String, Arc<HashSet<String>>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Arc<HashSet<String>>>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_hosts(identifier: &str, files: &Map<String, Value>) -> Arc<HashSet<String>> {
    let hosts = Arc::new(hosts_in(files));
    if let Ok(mut t) = host_table().lock() {
        t.insert(identifier.to_string(), hosts.clone());
    }
    hosts
}

/// Where this plugin may send requests: read from its package in the repository it was installed from (KiCad's, or
/// one the person added), never from the client.
async fn allowed_hosts(state: &AppState, user_id: i64, identifier: &str) -> AppResult<Arc<HashSet<String>>> {
    let source: Option<String> = sqlx::query_scalar("SELECT source FROM plugins WHERE user_id = $1 AND identifier = $2").bind(user_id).bind(identifier).fetch_optional(&state.pool).await?;
    if let Some(repo) = source.as_deref().and_then(repo_of_source) {
        let key = format!("repo:{repo}/{identifier}");
        if let Some(h) = host_table().lock().ok().and_then(|t| t.get(&key).cloned()) {
            return Ok(h);
        }
        let url = repo_url(state, user_id, repo).await?;
        let r = custom_index(&url, false).await?;
        let (_, _, files) = load_from(&r.packages, identifier, true).await?;
        return Ok(remember_hosts(&key, &files));
    }
    if let Some(h) = host_table().lock().ok().and_then(|t| t.get(identifier).cloned()) {
        return Ok(h);
    }
    let (_, _, files) = load(identifier).await?;
    Ok(remember_hosts(identifier, &files))
}

/// An address on the public internet: not this machine, not a private network, not a cloud metadata service.
fn is_public(ip: IpAddr) -> bool {
    fn v4(a: Ipv4Addr) -> bool {
        let o = a.octets();
        !(a.is_private() || a.is_loopback() || a.is_link_local() || a.is_broadcast() || a.is_unspecified() || a.is_documentation() || a.is_multicast()
            || o[0] == 0
            || (o[0] == 100 && (o[1] & 0xc0) == 64)        // carrier-grade NAT
            || (o[0] == 192 && o[1] == 0 && o[2] == 0)     // protocol assignments
            || (o[0] == 198 && (o[1] & 0xfe) == 18)        // benchmarking
            || o[0] >= 240)
    }
    fn v6(a: Ipv6Addr) -> bool {
        if let Some(m) = a.to_ipv4_mapped() {
            return v4(m);
        }
        let s = a.segments();
        if s[0] == 0x64 && s[1] == 0xff9b {
            return v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8)); // NAT64
        }
        !(a.is_loopback() || a.is_unspecified() || a.is_multicast()
            || (s[0] & 0xfe00) == 0xfc00        // unique local
            || (s[0] & 0xffc0) == 0xfe80        // link local
            || (s[0] == 0x2001 && s[1] == 0xdb8) // documentation
            || s[0] == 0)
    }
    match ip {
        IpAddr::V4(a) => v4(a),
        IpAddr::V6(a) => v6(a),
    }
}

/// No more than NET_PER_MINUTE requests a minute for one person.
fn within_rate(user: &str) -> bool {
    static SEEN: OnceLock<Mutex<HashMap<String, (Instant, usize)>>> = OnceLock::new();
    let Ok(mut seen) = SEEN.get_or_init(|| Mutex::new(HashMap::new())).lock() else { return true };
    let now = Instant::now();
    if seen.len() > 10_000 {
        seen.retain(|_, (t, _)| now.duration_since(*t) < Duration::from_secs(60));
    }
    let e = seen.entry(user.to_string()).or_insert((now, 0));
    if now.duration_since(e.0) >= Duration::from_secs(60) {
        *e = (now, 0);
    }
    e.1 += 1;
    e.1 <= NET_PER_MINUTE
}

#[derive(serde::Deserialize)]
pub struct NetRequest {
    url: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    /// base64
    #[serde(default)]
    body: String,
}

fn refuse(msg: impl Into<String>) -> AppError {
    AppError::Api(StatusCode::FORBIDDEN, "plugin_network_refused", msg.into())
}

#[derive(serde::Deserialize)]
pub struct HostApproval {
    host: String,
}

/// A host name a person may let a plugin reach: a name on the public internet as people type it, not an
/// address, not this machine, not a name that only means something on a private network.
fn approvable_host(host: &str) -> Option<String> {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() || h.len() > 253 || h.parse::<IpAddr>().is_ok() || h.starts_with('[') {
        return None;
    }
    let labels: Vec<&str> = h.split('.').collect();
    let ok_label = |l: &&str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if labels.len() < 2 || !labels.iter().all(ok_label) {
        return None;
    }
    let tld = labels[labels.len() - 1];
    const PRIVATE: &[&str] = &["localhost", "local", "internal", "intranet", "lan", "home", "corp", "private", "test", "invalid", "example", "onion", "arpa"];
    if !tld.chars().all(|c| c.is_ascii_alphabetic()) || tld.len() < 2 || PRIVATE.contains(&tld) {
        return None;
    }
    Some(h)
}

/// `POST /api/plugins/pcm/{identifier}/hosts` — the person lets one of their plugins reach `host`.  Only for an
/// installed plugin they granted network access; the address must be a public host name.  Requests to it still go
/// through every check of `net_fetch` (https, public address at the time of the request, size and rate limits).
pub async fn approve_host(State(state): State<AppState>, AuthUser(user): AuthUser, Path(identifier): Path<String>, Json(req): Json<HostApproval>) -> AppResult<Json<Value>> {
    // tests stand a service in on this machine (KC_PLUGIN_NETWORK=test), as net_fetch then allows
    let test_local = net_mode() == NetMode::Test && req.host.trim().parse::<Ipv4Addr>().is_ok_and(|a| a.is_loopback());
    let host = (if test_local { Some(req.host.trim().to_string()) } else { approvable_host(&req.host) }).ok_or_else(|| bad("only a host name on the public internet can be allowed, not an address or a local name"))?;
    let granted: Option<Value> = sqlx::query_scalar("SELECT granted FROM plugins WHERE user_id = $1 AND identifier = $2")
        .bind(user.id)
        .bind(&identifier)
        .fetch_optional(&state.pool)
        .await?;
    let Some(granted) = granted else { return Err(AppError::NotFound) };
    if !granted.as_array().is_some_and(|a| a.iter().any(|g| g == "network")) {
        return Err(refuse("this plugin was not given network access"));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_net_hosts WHERE user_id = $1 AND identifier = $2")
        .bind(user.id)
        .bind(&identifier)
        .fetch_one(&state.pool)
        .await?;
    if count >= 20 {
        return Err(bad("this plugin already has as many allowed addresses as it can keep; remove one first"));
    }
    sqlx::query("INSERT INTO plugin_net_hosts (user_id, identifier, host) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(user.id)
        .bind(&identifier)
        .bind(&host)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "host": host, "approved": true })))
}

/// `GET /api/plugins/pcm/{identifier}/hosts` — the addresses the person let this plugin reach.
pub async fn list_hosts(State(state): State<AppState>, AuthUser(user): AuthUser, Path(identifier): Path<String>) -> AppResult<Json<Value>> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT host FROM plugin_net_hosts WHERE user_id = $1 AND identifier = $2 ORDER BY host")
        .bind(user.id)
        .bind(&identifier)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(json!({ "hosts": rows })))
}

/// `DELETE /api/plugins/pcm/{identifier}/hosts/{host}` — take an allowed address back.
pub async fn remove_host(State(state): State<AppState>, AuthUser(user): AuthUser, Path((identifier, host)): Path<(String, String)>) -> AppResult<Json<Value>> {
    let gone = sqlx::query("DELETE FROM plugin_net_hosts WHERE user_id = $1 AND identifier = $2 AND host = $3")
        .bind(user.id)
        .bind(&identifier)
        .bind(host.to_ascii_lowercase())
        .execute(&state.pool)
        .await?
        .rows_affected();
    Ok(Json(json!({ "removed": gone > 0 })))
}

/// `POST /api/plugins/pcm/{identifier}/fetch` — carry one HTTP request for an official plugin.
pub async fn net_fetch(State(state): State<AppState>, AuthUser(user): AuthUser, Path(identifier): Path<String>, Json(req): Json<NetRequest>) -> AppResult<Json<Value>> {
    let mode = net_mode();
    if mode == NetMode::Off {
        return Err(refuse("network access for plugins is turned off on this server"));
    }
    if !within_rate(&user.id.to_string()) {
        return Err(AppError::Api(StatusCode::TOO_MANY_REQUESTS, "plugin_network_busy", "this plugin is sending requests faster than the server carries them; try again in a minute".into()));
    }
    let url = reqwest::Url::parse(&req.url).map_err(|_| bad("that is not a web address"))?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let secure = url.scheme() == "https";
    if host.is_empty() || !(secure || (mode == NetMode::Test && url.scheme() == "http")) || !url.username().is_empty() || url.password().is_some() {
        return Err(refuse("plugins can only reach https addresses"));
    }
    if mode != NetMode::Test && url.port().is_some_and(|p| p != 443) {
        return Err(refuse("plugins can only reach the standard https port"));
    }
    let allowed = allowed_hosts(&state, user.id, &identifier).await?;
    if !allowed.contains(&base_domain(&host)) {
        let approved: Option<i32> = sqlx::query_scalar("SELECT 1 FROM plugin_net_hosts WHERE user_id = $1 AND identifier = $2 AND host = $3")
            .bind(user.id)
            .bind(&identifier)
            .bind(&host)
            .fetch_optional(&state.pool)
            .await?;
        if approved.is_none() {
            return Err(AppError::Api(
                StatusCode::FORBIDDEN,
                "plugin_host_unapproved",
                format!("{host} is not one of the web addresses this plugin names in its own code, and you have not let it reach that address"),
            ));
        }
    }
    let port = url.port_or_known_default().unwrap_or(443);
    // Resolve the name here and connect to exactly that address, so the check and the connection agree.
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| bad(format!("{host} could not be found")))?.collect();
    let addr = addrs.into_iter().find(|a| mode == NetMode::Test || is_public(a.ip())).ok_or_else(|| refuse(format!("{host} is not an address on the public internet")))?;
    let body = base64::engine::general_purpose::STANDARD.decode(req.body.as_bytes()).map_err(|_| bad("the request body is not base64"))?;
    if body.len() > NET_MAX_REQUEST {
        return Err(bad("that upload is larger than the server carries for a plugin (16 MB)"));
    }
    let method = reqwest::Method::from_bytes(if req.method.is_empty() { b"GET" } else { req.method.as_bytes() }).map_err(|_| bad("that is not an HTTP method"))?;
    if method == reqwest::Method::CONNECT || method == reqwest::Method::TRACE {
        return Err(refuse("that HTTP method is not carried"));
    }
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(60)).user_agent("kicad-collab-plugin");
    if host.parse::<IpAddr>().is_err() {
        builder = builder.resolve(&host, addr);
    }
    let client = builder.build().map_err(|_| bad("the request could not be prepared"))?;
    let mut out = client.request(method, url.clone());
    const DROP: &[&str] = &["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "upgrade", "te", "expect", "keep-alive", "proxy-authorization", "proxy-connection", "trailer"];
    for (name, value) in req.headers.iter().take(100) {
        let low = name.to_ascii_lowercase();
        if DROP.contains(&low.as_str()) || low.starts_with("proxy-") || low.starts_with("x-forwarded-") {
            continue;
        }
        if let (Ok(n), Ok(v)) = (reqwest::header::HeaderName::from_bytes(name.as_bytes()), reqwest::header::HeaderValue::from_str(value)) {
            out = out.header(n, v);
        }
    }
    out = out.header(reqwest::header::ACCEPT_ENCODING, "identity");
    if !body.is_empty() {
        out = out.body(body);
    }
    tracing::info!(user = %user.id, plugin = %identifier, host = %host, "plugin network request");
    let mut resp = out.send().await.map_err(|e| bad(format!("{host} could not be reached{}", if e.is_timeout() { " in time" } else { "" })))?;
    let status = resp.status();
    let headers: Vec<Value> = resp.headers().iter().map(|(k, v)| json!([k.as_str(), String::from_utf8_lossy(v.as_bytes())])).collect();
    let mut data: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| bad(format!("the answer from {host} was cut off")))? {
        if data.len() + chunk.len() > NET_MAX_RESPONSE {
            return Err(bad("that answer is larger than the server carries for a plugin (24 MB)"));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(Json(json!({
        "status": status.as_u16(),
        "reason": status.canonical_reason().unwrap_or(""),
        "headers": headers,
        "body": base64::engine::general_purpose::STANDARD.encode(&data),
        "url": url.as_str(),
    })))
}

// ---------------------------------------------------------------- repositories a person added

// KiCad's Plugin and Content Manager lets a person add other repositories (Manage Repositories: the address of a
// repository.json).  The web Plugin Manager does the same.  The server reads those repositories for the person, so
// the address does come from a request here: every download for them goes through `fetch_public`, which reaches only
// https addresses on the public internet (checked again after each redirect), with the same size limits as KiCad's.

const MAX_REPOSITORIES: i64 = 20;
const MAX_CUSTOM_RESOURCES_BYTES: usize = 32 * 1024 * 1024;

/// A repository a person added: its name and plugin packages as last read, and its icons once downloaded.
pub struct CustomRepo {
    name: String,
    maintainer: String,
    packages: Vec<Value>,
    icons: std::sync::RwLock<Icons>,
    icons_loading: std::sync::atomic::AtomicBool,
}

/// Download from an address a person typed (or one their repository names): https only, the standard port, public
/// addresses only, the name resolved here and connected to exactly, redirects followed by hand and checked again.
async fn fetch_public(url: &str, limit: usize) -> AppResult<Vec<u8>> {
    Ok(fetch_public_at(url, limit).await?.0)
}

/// `fetch_public`, and the address the download came from in the end (after redirects), which relative addresses in it
/// are read against.
async fn fetch_public_at(url: &str, limit: usize) -> AppResult<(Vec<u8>, reqwest::Url)> {
    let test = net_mode() == NetMode::Test;
    let mut url = reqwest::Url::parse(url.trim()).map_err(|_| bad("that is not a web address"))?;
    for _ in 0..6 {
        let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        if host.is_empty() || !(url.scheme() == "https" || (test && url.scheme() == "http")) || !url.username().is_empty() || url.password().is_some() {
            return Err(bad("plugin repositories are read over https only"));
        }
        if !test && url.port().is_some_and(|p| p != 443) {
            return Err(bad("plugin repositories are read on the standard https port only"));
        }
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| bad(format!("{host} could not be found")))?.collect();
        let addr = addrs.into_iter().find(|a| test || is_public(a.ip())).ok_or_else(|| bad(format!("{host} is not an address on the public internet")))?;
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120)).user_agent("kicad-collab-server (plugin repository)");
        if host.parse::<IpAddr>().is_err() {
            builder = builder.resolve(&host, addr);
        }
        let client = builder.build().map_err(|_| bad("the request could not be prepared"))?;
        let mut resp = client.get(url.clone()).send().await.map_err(|e| bad(format!("could not reach {host}{}", if e.is_timeout() { " in time" } else { "" })))?;
        if resp.status().is_redirection() {
            let next = resp.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).ok_or_else(|| bad(format!("{host} redirected nowhere")))?;
            url = url.join(next).map_err(|_| bad(format!("{host} redirected to something that is not a web address")))?;
            continue;
        }
        if !resp.status().is_success() {
            return Err(bad(format!("{host} answered {}", resp.status().as_u16())));
        }
        let mut data: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| bad(format!("the download from {host} was cut off")))? {
            if data.len() + chunk.len() > limit {
                return Err(bad("that download is larger than the web editor accepts"));
            }
            data.extend_from_slice(&chunk);
        }
        return Ok((data, url));
    }
    Err(bad("that address redirects too many times"))
}

/// Where a repository keeps its icons (its resources archive) and that archive's checksum.
type Resources = Option<(String, Option<String>)>;

/// Read a repository.json and its package list (KiCad's PCM format), keeping its plugins.
async fn load_custom(repo_url: &str) -> AppResult<(CustomRepo, Resources)> {
    let (raw, base) = fetch_public_at(repo_url, MAX_INDEX_BYTES).await?;
    let repo: Value = serde_json::from_slice(&raw).map_err(|_| bad("that address does not hold a repository.json: it is not JSON"))?;
    let packages_url = repo.pointer("/packages/url").and_then(Value::as_str).ok_or_else(|| bad("that is not a KiCad plugin repository: its repository.json names no package list (packages.url)"))?;
    let packages_url = base.join(packages_url).map_err(|_| bad("the repository's package list is not a web address"))?;
    let raw = fetch_public(packages_url.as_str(), MAX_INDEX_BYTES).await?;
    if let Some(want) = repo.pointer("/packages/sha256").and_then(Value::as_str) {
        if !want.eq_ignore_ascii_case(&hex(&Sha256::digest(&raw))) {
            return Err(bad("the repository's package list does not match its checksum"));
        }
    }
    let list: Value = serde_json::from_slice(&raw).map_err(|_| bad("the repository's package list is not JSON"))?;
    let packages: Vec<Value> = list.get("packages").and_then(Value::as_array).cloned().unwrap_or_default();
    let packages = packages.into_iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("plugin")).collect();
    let name = clip(repo.get("name").and_then(Value::as_str).unwrap_or("").trim(), 120);
    let maintainer = clip(repo.pointer("/maintainer/name").and_then(Value::as_str).unwrap_or("").trim(), 120);
    let resources = repo.pointer("/resources/url").and_then(Value::as_str).and_then(|u| base.join(u).ok()).map(|u| (u.to_string(), repo.pointer("/resources/sha256").and_then(Value::as_str).map(str::to_string)));
    let name = if name.is_empty() { host_of(base.as_str()).to_string() } else { name };
    Ok((CustomRepo { name, maintainer, packages, icons: Default::default(), icons_loading: Default::default() }, resources))
}

fn custom_cache() -> &'static Mutex<HashMap<String, (Instant, Arc<CustomRepo>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Arc<CustomRepo>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A repository a person added, cached for an hour (`fresh`: read it again now).  A repository that cannot be read when
/// its hour is up keeps its last list.
async fn custom_index(url: &str, fresh: bool) -> AppResult<Arc<CustomRepo>> {
    let cached = custom_cache().lock().ok().and_then(|c| c.get(url).cloned());
    if let Some((at, r)) = &cached {
        if !fresh && at.elapsed() < INDEX_TTL {
            return Ok(r.clone());
        }
    }
    let loaded = tokio::time::timeout(Duration::from_secs(60), load_custom(url)).await.map_err(|_| bad("the repository did not answer in time"));
    let (repo, resources) = match (loaded, cached) {
        (Ok(Ok((r, res))), _) => (Arc::new(r), res),
        (Ok(Err(_)) | Err(_), Some((_, old))) if !fresh => return Ok(old),
        (Ok(Err(e)), _) | (Err(e), _) => return Err(e),
    };
    if let Ok(mut c) = custom_cache().lock() {
        if c.len() > 2000 {
            c.retain(|_, (at, _)| at.elapsed() < INDEX_TTL);
        }
        c.insert(url.to_string(), (Instant::now(), repo.clone()));
    }
    if let Some((res_url, want)) = resources {
        load_custom_icons(repo.clone(), res_url, want);
    }
    Ok(repo)
}

fn load_custom_icons(repo: Arc<CustomRepo>, url: String, want: Option<String>) {
    use std::sync::atomic::Ordering;
    if repo.icons_loading.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        if let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(300), fetch_public(&url, MAX_CUSTOM_RESOURCES_BYTES)).await {
            if want.map_or(true, |w| w.eq_ignore_ascii_case(&hex(&Sha256::digest(&raw)))) {
                if let Ok(found) = tokio::task::spawn_blocking(move || icons_in(raw)).await {
                    if let Ok(mut slot) = repo.icons.write() {
                        *slot = Arc::new(found);
                    }
                }
            }
        }
        repo.icons_loading.store(false, Ordering::SeqCst);
    });
}

/// The repository an installed plugin came from: its source is `repo:<id>:<version>`.
fn repo_of_source(source: &str) -> Option<i64> {
    source.strip_prefix("repo:")?.split(':').next()?.parse().ok()
}

/// The address of one of this person's repositories.
async fn repo_url(state: &AppState, user_id: i64, id: i64) -> AppResult<String> {
    sqlx::query_scalar("SELECT url FROM plugin_repositories WHERE id = $1 AND user_id = $2").bind(id).bind(user_id).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)
}

/// `GET /api/plugins/repositories` — the repositories this person added, oldest first.
pub async fn repositories(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, (i64, String, String, String)>("SELECT id, url, name, maintainer FROM plugin_repositories WHERE user_id = $1 ORDER BY added_at, id")
        .bind(user.id)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(json!({ "repositories": rows.iter().map(|(id, url, name, maintainer)| json!({ "id": id, "url": url, "name": name, "maintainer": maintainer })).collect::<Vec<_>>() })))
}

#[derive(serde::Deserialize)]
pub struct AddRepository {
    url: String,
}

/// `POST /api/plugins/repositories` — add a repository: the address of its repository.json.  It is read before it is
/// kept, so an address that is not a KiCad plugin repository is refused with the reason.
pub async fn add_repository(State(state): State<AppState>, AuthUser(user): AuthUser, Json(req): Json<AddRepository>) -> AppResult<Json<Value>> {
    let url = req.url.trim().to_string();
    if url.len() > 2000 {
        return Err(bad("that address is too long"));
    }
    // a GitHub page of the file stands for the file itself, as "Install from an address" reads it
    let url = match url.strip_prefix("https://github.com/").and_then(|rest| {
        let mut p = rest.splitn(4, '/');
        let (owner, repo, kind, path) = (p.next()?, p.next()?, p.next()?, p.next()?);
        (kind == "blob" || kind == "raw").then(|| format!("https://raw.githubusercontent.com/{owner}/{repo}/{path}"))
    }) {
        Some(raw) => raw,
        None => url,
    };
    let parsed = reqwest::Url::parse(&url).map_err(|_| bad("give the https address of the repository's repository.json"))?;
    let url = parsed.to_string();
    if url == DEFAULT_REPOSITORY {
        return Err(bad("KiCad's official repository is always listed"));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_repositories WHERE user_id = $1").bind(user.id).fetch_one(&state.pool).await?;
    if count >= MAX_REPOSITORIES {
        return Err(bad("you have as many repositories as the Plugin Manager keeps; remove one first"));
    }
    let repo = custom_index(&url, true).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO plugin_repositories (user_id, url, name, maintainer) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, url) DO UPDATE SET name = EXCLUDED.name, maintainer = EXCLUDED.maintainer RETURNING id",
    )
    .bind(user.id)
    .bind(&url)
    .bind(&repo.name)
    .bind(&repo.maintainer)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({ "id": id, "url": url, "name": repo.name, "maintainer": repo.maintainer, "plugins": repo.packages.len() })))
}

/// `DELETE /api/plugins/repositories/{id}` — take a repository out of the catalog.  Plugins installed from it stay.
pub async fn remove_repository(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let gone = sqlx::query("DELETE FROM plugin_repositories WHERE id = $1 AND user_id = $2").bind(id).bind(user.id).execute(&state.pool).await?.rows_affected();
    Ok(Json(json!({ "removed": gone > 0 })))
}

/// `GET /api/plugins/repositories/{id}/plugins` — the plugins of one of this person's repositories.
pub async fn repository_plugins(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let url = repo_url(&state, user.id, id).await?;
    let repo = custom_index(&url, false).await?;
    let have = repo.icons.read().map(|g| g.clone()).unwrap_or_default();
    let out = entries_of(&repo.packages, |ident| json!(have.contains_key(ident)), false);
    Ok(Json(json!({ "plugins": out, "name": repo.name, "iconsPending": repo.icons_loading.load(std::sync::atomic::Ordering::SeqCst) })))
}

/// `GET /api/plugins/repositories/{id}/plugins/{identifier}` — download one plugin of that repository for the consent sheet.
pub async fn repository_plugin(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, identifier)): Path<(i64, String)>) -> AppResult<Json<Value>> {
    let url = repo_url(&state, user.id, id).await?;
    let repo = custom_index(&url, false).await?;
    let (pkg, version, files) = load_from(&repo.packages, &identifier, true).await?;
    let ver = version.get("version").and_then(Value::as_str).unwrap_or("");
    let manifest = install_manifest(&format!("repo:{id}/{identifier}"), &pkg, &version, &files);
    Ok(Json(json!({ "manifest": manifest, "files": files, "source": format!("repo:{id}:{ver}"), "repository": repo.name })))
}

/// `GET /api/plugins/repositories/{id}/plugins/{identifier}/icon` — that plugin's icon from its repository, a PNG.
pub async fn repository_icon(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, identifier)): Path<(i64, String)>) -> Response {
    let Ok(url) = repo_url(&state, user.id, id).await else { return StatusCode::NOT_FOUND.into_response() };
    let Some(repo) = custom_cache().lock().ok().and_then(|c| c.get(&url).map(|(_, r)| r.clone())) else { return StatusCode::NOT_FOUND.into_response() };
    let found = repo.icons.read().ok().and_then(|g| g.get(&identifier).cloned());
    match found {
        Some(bytes) => ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, max-age=3600"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes.as_ref().clone()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------------------------------------------------------------- the Python runtime's files

/// Where the built runtime lives: `npm run build` writes it to static/dist/pyodide, and the
/// image carries it beside the binary.  It is read from disk rather than compiled in: it is
/// 14 MB that the server never looks inside, and a `cargo build` without node still works.
pub(crate) fn runtime_dir() -> Option<&'static std::path::PathBuf> {
    static DIR: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let mut tries: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(d) = std::env::var("KC_PYODIDE_DIR") { tries.push(d.into()); }
        tries.push("static/dist/pyodide".into());
        tries.push(concat!(env!("CARGO_MANIFEST_DIR"), "/static/dist/pyodide").into());
        tries.push("/usr/local/share/kicad-collab/pyodide".into());
        tries.into_iter().find(|d| d.join("pyodide.asm.wasm").is_file() && d.join("kicad-python.json").is_file())
    }).as_ref()
}

/// The content type of a runtime file `GET /static/pyodide/{file}` serves, or None for a file it does not serve.
fn runtime_kind(file: &str) -> Option<&'static str> {
    Some(match file {
        // occt-import-js: the STEP reader behind the 3D viewer's real part models (web/domains/pcb/viewer3d/models.ts)
        "pyodide.js" | "pyodide.asm.mjs" | "ngspice.mjs" | "occt-import-js.js" => "application/javascript; charset=utf-8",
        // occ-kernel.wasm: the OpenCascade modelling kernel of the mechanical domain (web/domains/mechanical/kernel,
        // npm replicad-opencascadejs, LGPL-2.1), copied here by scripts/build-python.mjs and fetched by the CAD worker
        "pyodide.asm.wasm" | "occt-import-js.wasm" | "occ-kernel.wasm" => "application/wasm",
        "python_stdlib.zip" => "application/zip",
        "pyodide-lock.json" | "kicad-python.json" => "application/json; charset=utf-8",
        // a package a plugin imports (numpy, requests, …): a wheel or archive the build put beside the interpreter
        f if (f.ends_with(".whl") || f.ends_with(".zip")) && f.len() <= 160 && !f.starts_with('.') && f.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'+')) => "application/zip",
        _ => return None,
    })
}

/// `GET /static/pyodide/{file}` — the interpreter, its standard library and our shim modules.
/// The sandbox frame has an opaque origin, so these are readable from anywhere; they hold
/// nothing that is not already public.
pub async fn runtime(Path(file): Path<String>) -> Response {
    let Some(kind) = runtime_kind(&file) else { return StatusCode::NOT_FOUND.into_response() };
    let Some(dir) = runtime_dir() else { return (StatusCode::SERVICE_UNAVAILABLE, "the Python runtime is not built on this server (npm run build)").into_response() };
    let Ok(body) = tokio::fs::read(dir.join(&file)).await else { return StatusCode::NOT_FOUND.into_response() };
    // The shim changes with every build of ours; the interpreter only with its version.
    let cache = if file == "kicad-python.json" || file == "pyodide-lock.json" { "no-cache" } else { "public, max-age=86400" };
    ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, cache), (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::HeaderName::from_static("cross-origin-resource-policy"), "cross-origin")], body).into_response()
}

#[cfg(test)]
mod net_tests {
    use super::*;

    /// Every runtime file the web app fetches is one this route serves, under /static/pyodide/ (the
    /// build's static/dist/pyodide is not routed: the simulator once asked for /static/dist/pyodide/ngspice.mjs
    /// and failed on the live site).
    #[test]
    fn web_runtime_urls_are_served() {
        fn walk(d: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { if p.file_name().is_some_and(|n| n != "generated" && n != "node_modules") { walk(&p, out) } }
                else if p.extension().is_some_and(|x| x == "ts" || x == "tsx") { out.push(p) }
            }
        }
        let mut files = Vec::new();
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web"), &mut files);
        assert!(!files.is_empty());
        for f in files {
            let src = std::fs::read_to_string(&f).unwrap();
            assert!(!src.contains("/static/dist/pyodide"), "{}: /static/dist/pyodide is not served; use /static/pyodide/", f.display());
            for (i, _) in src.match_indices("/static/pyodide/") {
                let rest = &src[i + "/static/pyodide/".len()..];
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+')).collect();
                let name = name.trim_end_matches('.'); // a URL that ends a sentence in a comment
                if name.is_empty() { continue } // a prefix the code appends a name to
                assert!(runtime_kind(name).is_some(), "{}: /static/pyodide/{name} is not served by runtime()", f.display());
            }
        }
    }

    #[test]
    fn approvable_hosts() {
        assert_eq!(approvable_host("Library.Example-Co.com").as_deref(), Some("library.example-co.com"));
        assert_eq!(approvable_host("kicomlib.mycompany.co.uk.").as_deref(), Some("kicomlib.mycompany.co.uk"));
        for bad in ["localhost", "127.0.0.1", "10.0.0.5", "[::1]", "::1", "server", "nas.local", "lib.internal", "x.lan", "metadata.google.internal", "a..b.com", "-a.com", "a b.com", "host.123", "x.test", ""] {
            assert!(approvable_host(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn base_domains() {
        assert_eq!(base_domain("api.nextpcb.com"), "nextpcb.com");
        assert_eq!(base_domain("WWW.PCBWay.com."), "pcbway.com");
        assert_eq!(base_domain("a.b.example.co.uk"), "example.co.uk");
        assert_eq!(base_domain("example.org"), "example.org");
        assert_eq!(base_domain("10.0.0.1"), "10.0.0.1");
    }

    #[test]
    fn only_public_addresses() {
        for bad in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "198.18.0.1",
                    "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "ff02::1"] {
            assert!(!is_public(bad.parse().unwrap()), "{bad} must not be reachable");
        }
        for good in ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public(good.parse().unwrap()), "{good} is public");
        }
    }

    #[test]
    fn hosts_come_from_the_package() {
        let mut files = Map::new();
        files.insert("plugins/api.py".into(), json!("URL = 'https://api.example-fab.com/v1/order'\nimport requests\nDOC = \"http://docs.example.org/x\"\nBAD = 'https://localhost/x'  # no dot\n"));
        files.insert("plugins/logo.png".into(), json!("base64:aHR0cHM6Ly9ldmlsLmV4YW1wbGUuY29t"));
        files.insert("resources/readme.md".into(), json!("https://elsewhere.example.net"));
        let hosts = hosts_in(&files);
        assert!(hosts.contains("example-fab.com") && hosts.contains("example.org"));
        assert!(!hosts.contains("localhost") && !hosts.contains("example.net") && !hosts.iter().any(|h| h.contains("evil")));
        assert!(uses_network(&files));
        let mut quiet = Map::new();
        quiet.insert("plugins/a.py".into(), json!("import pcbnew\n# see https://example.com\n"));
        assert!(!uses_network(&quiet));
    }
}
