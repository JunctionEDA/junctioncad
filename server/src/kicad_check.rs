//! The Design Rules Checker and Electrical Rules Checker run by KiCad itself.
//!
//! The browser's checks (web/domains/pcb/tools/pcb-tools/drc*.ts, sch-tools/erc*.ts) are a TypeScript
//! port: quick enough to run while editing, but not KiCad.  `Run DRC` and `Run ERC` come here instead:
//! the project is written out as the design is now (the journal folded into each file, as an archive
//! download does) and the desktop's own `kicad-cli pcb drc` / `sch erc` checks it, so the result is
//! exactly what Junction desktop reports for the same files.  The dialog shows that list; the browser
//! falls back to its own checks only when this server has no kicad-cli (`501 no_kicad_cli`) or the
//! request fails.
//!
//! Routes (anyone who may open the project):
//! * `POST /api/docs/{id}/drc`  `{ parity?, refill?, allTrackErrors? }` → `{ report, cli }` where `report`
//!   is kicad-cli's JSON report (`--format json --units mm --severity-all`).
//! * `POST /api/docs/{id}/erc`  `{}` → the same for the project's root schematic.

use std::path::{Path as FsPath, PathBuf};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::access::{self, Viewer};
use crate::error::{AppError, AppResult};
use crate::persist;
use crate::AppState;

/// A big board (the Jetson demo, 12 layers) takes about 40 s.
const CHECK_TIMEOUT: Duration = Duration::from_secs(300);
/// Checks running at once: each holds a whole design in memory.
static CHECKING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
/// Rules about the global libraries: the server has no footprint or symbol libraries installed, so
/// kicad-cli would report every footprint and symbol as coming from an unknown library.
const LIBRARY_RULES: &[&str] = &["lib_footprint_issues", "lib_footprint_mismatch", "lib_symbol_issues", "lib_symbol_mismatch", "footprint_link_issues"];

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/docs/{id}/drc", post(drc)).route("/api/docs/{id}/erc", post(erc))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DrcOpts {
    #[serde(default)]
    parity: bool,
    #[serde(default)]
    refill: bool,
    #[serde(default)]
    all_track_errors: bool,
}

/// The kicad-cli to check with: Junction desktop's own (the Docker image installs it), else `KICAD_CLI`.
fn cli() -> Option<String> {
    crate::nonkicad_import::cli()
}

async fn drc(State(state): State<AppState>, viewer: Viewer, Path(id): Path<Uuid>, body: Option<Json<DrcOpts>>) -> AppResult<Json<Value>> {
    let opts = body.map(|b| b.0).unwrap_or_default();
    let doc = persist::get_document(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if doc.doc_type != "kicad_pcb" {
        return Err(AppError::BadRequest("the Design Rules Checker needs a board".into()));
    }
    let mut args: Vec<String> = vec!["pcb".into(), "drc".into()];
    if opts.parity { args.push("--schematic-parity".into()); }
    if opts.refill { args.push("--refill-zones".into()); }
    if opts.all_track_errors { args.push("--all-track-errors".into()); }
    run(&state, &viewer, &doc, args).await.map(Json)
}

async fn erc(State(state): State<AppState>, viewer: Viewer, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let doc = persist::get_document(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if doc.doc_type != "kicad_sch" {
        return Err(AppError::BadRequest("the Electrical Rules Checker needs a schematic".into()));
    }
    // ERC is a check of the whole hierarchy, from the root sheet
    let docs = persist::project_documents(&state.pool, doc.project_id).await?;
    let root = crate::http::root_schematic(&docs).cloned().unwrap_or(doc);
    run(&state, &viewer, &root, vec!["sch".into(), "erc".into()]).await.map(Json)
}

async fn run(state: &AppState, viewer: &Viewer, doc: &persist::Document, mut args: Vec<String>) -> AppResult<Value> {
    access::resolve(&state.pool, viewer, doc.project_id).await?.ok_or(AppError::NotFound)?;
    let Some(cli) = cli() else {
        return Err(AppError::Api(StatusCode::NOT_IMPLEMENTED, "no_kicad_cli", "This server has no kicad-cli; the checks run in the browser.".into()));
    };
    let _permit = CHECKING.acquire().await.map_err(|e| anyhow::anyhow!("check queue: {e}"))?;

    // the files as the design is now, not as the last upload left them
    crate::compact::fold_project(&state.pool, doc.project_id).await;
    let docs = persist::project_documents(&state.pool, doc.project_id).await?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for d in &docs {
        if let Some((_, content)) = persist::latest_snapshot(&state.pool, d.id).await? {
            entries.push((d.path.clone(), content));
        }
    }
    entries.extend(crate::projectlibs::rebuild_symbol_libraries(&entries));
    let target = path_in(&entries, &doc.path);
    let work = std::env::temp_dir().join(format!("junction-check-{}", Uuid::new_v4()));
    let result = check(&cli, &work, &entries, &target, &mut args).await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    result
}

async fn check(cli: &str, work: &FsPath, entries: &[(String, Vec<u8>)], target: &str, args: &mut Vec<String>) -> AppResult<Value> {
    let files = work.join("files");
    for (path, content) in entries {
        let Some(to) = safe_join(&files, path_in(entries, path)) else { continue };
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| anyhow::anyhow!("check folder: {e}"))?;
        }
        tokio::fs::write(&to, content).await.map_err(|e| anyhow::anyhow!("write {path}: {e}"))?;
    }
    let input = safe_join(&files, target.to_string()).ok_or_else(|| AppError::BadRequest("bad document path".into()))?;
    let out = work.join("report.json");
    let home = work.join("home");
    tokio::fs::create_dir_all(&home).await.map_err(|e| anyhow::anyhow!("check home: {e}"))?;
    args.extend(["--format", "json", "--units", "mm", "--severity-all"].map(String::from));
    args.push("-o".into());
    args.push(out.to_string_lossy().into_owned());
    args.push(input.to_string_lossy().into_owned());

    let mut cmd = tokio::process::Command::new(cli);
    cmd.args(args.iter())
        // settings and caches stay in the work folder
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .current_dir(work)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(CHECK_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(AppError::Other(anyhow::anyhow!("could not run kicad-cli: {e}"))),
        Err(_) => return Err(AppError::Api(StatusCode::GATEWAY_TIMEOUT, "check_timeout", "The check took too long and was stopped.".into())),
    };
    let report = tokio::fs::read(&out).await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(mut report) = report else {
        let text = String::from_utf8_lossy(&output.stderr).to_string() + &String::from_utf8_lossy(&output.stdout);
        let why = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains("Gtk-") && !l.contains("dbus")).last().unwrap_or("kicad-cli failed").to_string();
        return Err(AppError::Api(StatusCode::UNPROCESSABLE_ENTITY, "check_failed", why));
    };
    strip_library_rules(&mut report);
    Ok(json!({ "report": report, "cli": "kicad-cli" }))
}

/// Where a document's path lands under the work folder: shared `../` files one level up as in a download.
fn path_in(entries: &[(String, Vec<u8>)], path: &str) -> String {
    let up = entries.iter().map(|(p, _)| p.split('/').take_while(|s| *s == "..").count()).max().unwrap_or(0);
    crate::http::archive_place(&crate::http::archive_home("", "project", up), path)
}

/// `base/rel` when `rel` stays inside `base` (no absolute paths, no `..` left after placing).
fn safe_join(base: &FsPath, rel: String) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            s if s.contains('\\') || s.contains('\0') => return None,
            s => out.push(s),
        }
    }
    (out != base).then_some(out)
}

/// Drop the library rules (see LIBRARY_RULES) from a DRC or ERC report.
fn strip_library_rules(report: &mut Value) {
    let keep = |v: &Value| !LIBRARY_RULES.contains(&v["type"].as_str().unwrap_or(""));
    if let Some(list) = report.get_mut("violations").and_then(Value::as_array_mut) {
        list.retain(keep);
    }
    if let Some(sheets) = report.get_mut("sheets").and_then(Value::as_array_mut) {
        for s in sheets {
            if let Some(list) = s.get_mut("violations").and_then(Value::as_array_mut) {
                list.retain(keep);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_in_the_work_folder() {
        let base = FsPath::new("/w");
        assert_eq!(safe_join(base, "project/a.kicad_pcb".into()), Some(PathBuf::from("/w/project/a.kicad_pcb")));
        assert_eq!(safe_join(base, "../x".into()), None);
        assert_eq!(safe_join(base, "".into()), None);
        let entries = vec![("a.kicad_pcb".to_string(), vec![]), ("../lib/x.pretty/y.kicad_mod".to_string(), vec![])];
        assert_eq!(path_in(&entries, "a.kicad_pcb"), "project/a.kicad_pcb");
        assert_eq!(path_in(&entries, "../lib/x.pretty/y.kicad_mod"), "lib/x.pretty/y.kicad_mod");
    }

    #[test]
    fn library_rules_are_dropped() {
        let mut r = json!({ "violations": [{ "type": "clearance" }, { "type": "lib_footprint_issues" }],
                            "sheets": [{ "violations": [{ "type": "lib_symbol_issues" }, { "type": "pin_not_connected" }] }] });
        strip_library_rules(&mut r);
        assert_eq!(r["violations"].as_array().unwrap().len(), 1);
        assert_eq!(r["sheets"][0]["violations"][0]["type"], "pin_not_connected");
    }
}
