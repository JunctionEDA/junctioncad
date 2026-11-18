//! The project shell's routes: what the Home tab and the document tabs of an open project ask for beyond one
//! document at a time (web/platform/doctabs, web/platform/projecthome).
//!
//! A project holds any number of PCBs, part studios and assemblies.  **A PCB is a KiCad project in a folder of
//! its own** (`<folder>/<stem>.kicad_pro`, `.kicad_sch`, `.kicad_pcb`, its sheets, its library tables): its name
//! is the folder's, and everything that belongs to it moves, is copied and is deleted with the folder.  A project
//! from before this (its KiCad files at the root) is one PCB whose folder is the root, and nothing here touches it.
//!
//!   POST /api/projects/{id}/shell              the project's own document, made when it is first needed
//!   POST /api/projects/{id}/pcbs               {name}: a new PCB in its own folder
//!   POST /api/projects/{id}/folders/move       {from, to}: rename or move a folder with everything in it
//!   POST /api/projects/{id}/folders/delete     {path}: delete a folder with everything in it
//!   POST /api/projects/{id}/duplicate          {docId, path} or {folder, to}: a copy of a document or a folder
//!   GET  /api/projects/{id}/files              every document with its size, and when and by whom it last changed
//!
//! The project's own document (`project.jproj`, type `project_shell`) is a JSON item document like a part studio
//! (itemdoc.rs): the order of the tabs and the folders that hold nothing yet.  Everybody who has the project open
//! joins it, which is also how they see each other (web/platform/doctabs/room.ts).
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::access::{self, Viewer};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::http::{allowed_file, doc_type_for, is_local_state_path, notify_docs, pcb_stub_files, safe_zip_name, MAX_FILES};
use crate::lenient_json::LenientJson;
use crate::persist::{self, Document};
use crate::AppState;

pub const SHELL_PATH: &str = "project.jproj";
/// The same text as web/platform/doctabs/shelldoc.ts newShellText() (a test there compares them).
pub const SHELL_TEXT: &str = "{\"junction\":\"project\",\"version\":1,\"items\":[\n{\"id\":\"project\",\"type\":\"project\"}\n]}\n";

async fn editor(state: &AppState, user: &persist::User, project: Uuid) -> AppResult<()> {
    match persist::effective_role(&state.pool, user.id, project).await? {
        Some(role) if role == "editor" => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}

/// A folder path as stored: no leading or trailing slash, no empty, "." or ".." part.  "" is the root.
pub(crate) fn clean_folder(path: &str) -> Option<String> {
    let p = path.replace('\\', "/");
    let p = p.trim_matches('/');
    if p.is_empty() {
        return Some(String::new());
    }
    safe_zip_name(p).filter(|p| !is_local_state_path(p))
}

/// A name that can be one folder: what a person typed, with the characters a file system refuses replaced.
pub(crate) fn folder_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned.chars().count() > 80 {
        return None;
    }
    Some(cleaned)
}

fn in_folder(path: &str, folder: &str) -> bool {
    folder.is_empty() || (path.len() > folder.len() + 1 && path.starts_with(folder) && path.as_bytes()[folder.len()] == b'/')
}

fn taken(docs: &[Document], folder: &str) -> bool {
    let f = folder.to_lowercase();
    docs.iter().any(|d| {
        let p = d.path.to_lowercase();
        p == f || in_folder(&p, &f)
    })
}

/// A PCB's own three files are named like its folder (`Main/Main.kicad_pro`, `.kicad_sch`, `.kicad_pcb`), as
/// KiCad names a project's.  When the folder is renamed or copied they take the new name with it, so the board of
/// "Main" is `Main.kicad_pcb` wherever a board is listed by its file.  A file named otherwise keeps its name.
pub(crate) fn restem(path: &str, to: &str, old: &str) -> String {
    let Some(file) = path.strip_prefix(to).and_then(|r| r.strip_prefix('/')) else { return path.to_string() };
    if file.contains('/') {
        return path.to_string();
    }
    let new = to.rsplit('/').next().unwrap_or(to);
    for ext in [".kicad_pro", ".kicad_sch", ".kicad_pcb"] {
        if file.strip_suffix(ext) == Some(old) {
            return format!("{to}/{new}{ext}");
        }
    }
    path.to_string()
}

/// Where each document of `from` lands when the folder becomes `to`, or why it cannot.  `stems`: a PCB's own
/// files are renamed with the folder (`restem`).
pub(crate) fn plan_move(docs: &[Document], from: &str, to: &str, stems: bool) -> Result<Vec<(Uuid, String)>, String> {
    if from.is_empty() || to.is_empty() {
        return Err("the project's root is not a folder that can be moved".into());
    }
    if from == to {
        return Ok(Vec::new());
    }
    if in_folder(to, from) {
        return Err("a folder cannot be moved into itself".into());
    }
    let moving: Vec<&Document> = docs.iter().filter(|d| in_folder(&d.path, from)).collect();
    if moving.is_empty() {
        return Err(format!("there is no folder “{from}” in this project"));
    }
    let staying: std::collections::HashSet<String> =
        docs.iter().filter(|d| !in_folder(&d.path, from)).map(|d| d.path.to_lowercase()).collect();
    // a rename that only changes the letter case moves onto itself, which is fine
    let same_folder = from.to_lowercase() == to.to_lowercase();
    if !same_folder && docs.iter().any(|d| !in_folder(&d.path, from) && (in_folder(&d.path.to_lowercase(), &to.to_lowercase()) || d.path.to_lowercase() == to.to_lowercase())) {
        return Err(format!("this project already has “{to}”"));
    }
    let old = from.rsplit('/').next().unwrap_or(from);
    let mut out: Vec<(Uuid, String)> = Vec::new();
    for d in moving {
        let mut path = format!("{to}{}", &d.path[from.len()..]);
        if stems {
            path = restem(&path, to, old);
        }
        if staying.contains(&path.to_lowercase()) || out.iter().any(|(_, p)| p.to_lowercase() == path.to_lowercase()) {
            return Err(format!("this project already has “{path}”"));
        }
        out.push((d.id, path));
    }
    Ok(out)
}

/// The first of "name", "name 2", "name 3"… that no file or folder of the project has.
pub(crate) fn free_folder(docs: &[Document], parent: &str, name: &str) -> String {
    let at = |n: &str| if parent.is_empty() { n.to_string() } else { format!("{parent}/{n}") };
    if !taken(docs, &at(name)) {
        return at(name);
    }
    (2..).map(|i| at(&format!("{name} {i}"))).find(|p| !taken(docs, p)).unwrap()
}

/// POST /api/projects/{id}/shell: the project's own document, made if the project has none.
pub async fn ensure_shell(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let docs = persist::project_documents(&state.pool, id).await?;
    if let Some(d) = docs.iter().find(|d| d.doc_type == "project_shell") {
        return Ok(Json(json!({ "docId": d.id, "path": d.path, "docType": d.doc_type, "existing": true })).into_response());
    }
    // two people opening the project at once: the path is unique, so one of them makes it and the other finds it
    let doc = match persist::create_document(&state.pool, id, SHELL_PATH, "project_shell").await {
        Ok(doc) => doc,
        Err(_) => {
            let docs = persist::project_documents(&state.pool, id).await?;
            let d = docs.iter().find(|d| d.doc_type == "project_shell").ok_or(AppError::NotFound)?;
            return Ok(Json(json!({ "docId": d.id, "path": d.path, "docType": d.doc_type, "existing": true })).into_response());
        }
    };
    persist::insert_snapshot_new(&state.pool, doc.id, 0, SHELL_TEXT.as_bytes(), Some(user.id)).await?;
    notify_docs(&state, id, &user, "added", doc.id, &doc.path, &doc.doc_type, None).await;
    Ok(Json(json!({ "docId": doc.id, "path": doc.path, "docType": doc.doc_type, "existing": false })).into_response())
}

#[derive(Deserialize)]
pub struct NewPcbRequest {
    pub name: String,
    /// the folder the PCB's own folder goes in ("" or absent: the project's root)
    #[serde(default)]
    pub folder: Option<String>,
    /// What the files are called, when not like the folder (files that are about to be uploaded beside them).
    #[serde(default)]
    pub stem: Option<String>,
    /// Which of the three files to make ("kicad_pro", "kicad_sch", "kicad_pcb"); absent: all of them.
    #[serde(default)]
    pub only: Option<Vec<String>>,
}

/// POST /api/projects/{id}/pcbs {name}: a new PCB, as a KiCad project in a folder of its own.
pub async fn create_pcb(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<NewPcbRequest>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let name = folder_name(&req.name).ok_or_else(|| AppError::BadRequest("give the PCB a name".into()))?;
    let parent = clean_folder(req.folder.as_deref().unwrap_or("")).ok_or_else(|| AppError::BadRequest("bad folder".into()))?;
    let docs = persist::project_documents(&state.pool, id).await?;
    if docs.len() + 3 > MAX_FILES {
        return Err(AppError::BadRequest(format!("too many files (max {MAX_FILES})")));
    }
    let dir = free_folder(&docs, &parent, &name);
    // the files are named like the folder, as KiCad names a new project's
    let stem = match req.stem.as_deref().and_then(folder_name) {
        Some(s) => s,
        None => dir.rsplit('/').next().unwrap_or(&dir).to_string(),
    };
    let mut made = Vec::new();
    let mut pro = None;
    for (file, content) in pcb_stub_files(&stem) {
        let path = format!("{dir}/{file}");
        if req.only.as_ref().is_some_and(|only| !only.iter().any(|t| t == doc_type_for(&path))) {
            continue;
        }
        let doc = persist::create_document(&state.pool, id, &path, doc_type_for(&path)).await?;
        persist::insert_snapshot(&state.pool, doc.id, 0, &content, None, Some(user.id)).await?;
        if doc.doc_type == "kicad_pro" {
            pro = Some(doc.clone());
        }
        made.push(json!({ "docId": doc.id, "path": doc.path, "docType": doc.doc_type }));
    }
    let first = pro.map(|p: Document| p.id).or_else(|| made.first().and_then(|m| m.get("docId")).and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok()));
    if let Some(first) = first {
        notify_docs(&state, id, &user, "added", first, &dir, "folder", None).await;
    }
    Ok(Json(json!({ "dir": dir, "name": stem, "docs": made })).into_response())
}

#[derive(Deserialize)]
pub struct MoveFolderRequest {
    pub from: String,
    pub to: String,
    /// the folder is a PCB: its own files are renamed with it
    #[serde(default)]
    pub stems: bool,
}

/// POST /api/projects/{id}/folders/move {from, to}: the folder and everything in it, at another path.  This is
/// how a PCB is renamed: its files keep their names, and what they say about each other is relative.
pub async fn move_folder(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<MoveFolderRequest>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let from = clean_folder(&req.from).ok_or_else(|| AppError::BadRequest("bad folder".into()))?;
    let to = clean_folder(&req.to).ok_or_else(|| AppError::BadRequest("bad folder".into()))?;
    let docs = persist::project_documents(&state.pool, id).await?;
    let plan = plan_move(&docs, &from, &to, req.stems).map_err(AppError::BadRequest)?;
    for (_, path) in &plan {
        if safe_zip_name(path).as_deref() != Some(path.as_str()) || !allowed_file(path) || is_local_state_path(path) {
            return Err(AppError::BadRequest(format!("“{path}” is not a path a project can hold")));
        }
    }
    let mut tx = state.pool.begin().await?;
    // two steps, so that swapping letter case (or names inside the folder) never meets the unique path on the way
    for (doc, _) in &plan {
        sqlx::query("UPDATE documents SET path = '\u{1}moving/' || id::text WHERE id = $1 AND project_id = $2")
            .bind(doc)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    for (doc, path) in &plan {
        sqlx::query("UPDATE documents SET path = $3 WHERE id = $1 AND project_id = $2").bind(doc).bind(id).bind(path).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    if let Some((doc, _)) = plan.first() {
        notify_docs(&state, id, &user, "renamed", *doc, &to, "folder", Some(&from)).await;
    }
    Ok(Json(json!({ "ok": true, "moved": plan.len(), "to": to })).into_response())
}

#[derive(Deserialize)]
pub struct DeleteFolderRequest {
    pub path: String,
}

/// POST /api/projects/{id}/folders/delete {path}: the folder's documents and their history, for everyone.
pub async fn delete_folder(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<DeleteFolderRequest>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let path = clean_folder(&req.path).filter(|p| !p.is_empty()).ok_or_else(|| AppError::BadRequest("bad folder".into()))?;
    let docs = persist::project_documents(&state.pool, id).await?;
    let gone: Vec<&Document> = docs.iter().filter(|d| in_folder(&d.path, &path)).collect();
    if gone.iter().any(|d| d.doc_type == "project_shell") {
        return Err(AppError::BadRequest("that folder holds the project's own document".into()));
    }
    for d in &gone {
        persist::delete_document(&state.pool, d.id).await?;
    }
    if let Some(first) = gone.first() {
        notify_docs(&state, id, &user, "deleted", first.id, &path, "folder", None).await;
    }
    Ok(Json(json!({ "ok": true, "deleted": gone.len() })).into_response())
}

#[derive(Deserialize)]
pub struct DuplicateRequest {
    /// one document, copied to `path`
    #[serde(rename = "docId")]
    pub doc_id: Option<Uuid>,
    pub path: Option<String>,
    /// or a folder with everything in it, copied to the folder `to`
    pub folder: Option<String>,
    pub to: Option<String>,
    /// the folder is a PCB: the copy's own files are named like the copy
    #[serde(default)]
    pub stems: bool,
}

/// A copy of a document as it is now: its newest stored file and the edits made since, so the copy opens
/// reading the same as the original.  The copy has no earlier history.
async fn copy_document(state: &AppState, user: &persist::User, src: &Document, path: &str) -> AppResult<Document> {
    let doc = persist::create_document(&state.pool, src.project_id, path, &src.doc_type).await?;
    if let Some((seq, content)) = persist::latest_snapshot(&state.pool, src.id).await? {
        persist::insert_snapshot(&state.pool, doc.id, seq, &content, Some("copied"), Some(user.id)).await?;
        sqlx::query(
            "INSERT INTO ops (doc_id, seq, author_id, client_id, client_op_id, base_seq, changes, created_at)
             SELECT $2, seq, author_id, client_id, client_op_id, base_seq, changes, created_at FROM ops WHERE doc_id = $1 AND seq > $3",
        )
        .bind(src.id)
        .bind(doc.id)
        .bind(seq)
        .execute(&state.pool)
        .await?;
    }
    Ok(doc)
}

/// POST /api/projects/{id}/duplicate: a copy of one document ({docId, path}) or of a folder ({folder, to}).
pub async fn duplicate(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<DuplicateRequest>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let docs = persist::project_documents(&state.pool, id).await?;
    let lower: std::collections::HashSet<String> = docs.iter().map(|d| d.path.to_lowercase()).collect();
    let mut plan: Vec<(&Document, String)> = Vec::new();
    let said;
    if let Some(doc_id) = req.doc_id {
        let src = docs.iter().find(|d| d.id == doc_id).ok_or(AppError::NotFound)?;
        if src.doc_type == "project_shell" {
            return Err(AppError::BadRequest("the project's own document cannot be copied".into()));
        }
        let path = req.path.as_deref().and_then(safe_zip_name).ok_or_else(|| AppError::BadRequest("bad path".into()))?;
        if doc_type_for(&path) != src.doc_type || !allowed_file(&path) || is_local_state_path(&path) {
            return Err(AppError::BadRequest("a copy keeps the file type of the original".into()));
        }
        said = path.clone();
        plan.push((src, path));
    } else {
        let from = req.folder.as_deref().and_then(clean_folder).filter(|p| !p.is_empty()).ok_or_else(|| AppError::BadRequest("bad folder".into()))?;
        let to = req.to.as_deref().and_then(clean_folder).filter(|p| !p.is_empty()).ok_or_else(|| AppError::BadRequest("bad folder".into()))?;
        if taken(&docs, &to) {
            return Err(AppError::BadRequest(format!("this project already has “{to}”")));
        }
        let old = from.rsplit('/').next().unwrap_or(&from);
        for d in docs.iter().filter(|d| in_folder(&d.path, &from) && d.doc_type != "project_shell") {
            let path = format!("{to}{}", &d.path[from.len()..]);
            plan.push((d, if req.stems { restem(&path, &to, old) } else { path }));
        }
        if plan.is_empty() {
            return Err(AppError::BadRequest(format!("there is no folder “{from}” in this project")));
        }
        said = to;
    }
    if docs.len() + plan.len() > MAX_FILES {
        return Err(AppError::BadRequest(format!("too many files (max {MAX_FILES})")));
    }
    if let Some((_, p)) = plan.iter().find(|(_, p)| lower.contains(&p.to_lowercase())) {
        return Err(AppError::BadRequest(format!("this project already has “{p}”")));
    }
    let mut made = Vec::new();
    for (src, path) in &plan {
        let doc = copy_document(&state, &user, src, path).await?;
        made.push(json!({ "docId": doc.id, "path": doc.path, "docType": doc.doc_type, "from": src.id }));
    }
    if let Some(first) = made.first().and_then(|m| m.get("docId")).and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok()) {
        let kind = if req.doc_id.is_some() { plan[0].0.doc_type.as_str() } else { "folder" };
        notify_docs(&state, id, &user, "added", first, &said, kind, None).await;
    }
    Ok(Json(json!({ "ok": true, "docs": made })).into_response())
}

/// GET /api/projects/{id}/files: every document of the project as the Home tab lists it.
pub async fn files(
    State(state): State<AppState>,
    who: Viewer,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    access::resolve(&state.pool, &who, id).await?.ok_or(AppError::NotFound)?;
    let rows = sqlx::query(
        "SELECT d.id, d.path, d.doc_type, s.bytes, s.created_at AS snap_at, su.login AS snap_login, su.name AS snap_name,
                o.created_at AS op_at, ou.login AS op_login, ou.name AS op_name,
                EXISTS (SELECT 1 FROM doc_previews p WHERE p.doc_id = d.id) AS has_preview
           FROM documents d
           LEFT JOIN LATERAL (SELECT octet_length(content) AS bytes, created_at, uploader_id FROM snapshots
                               WHERE doc_id = d.id ORDER BY seq DESC LIMIT 1) s ON true
           LEFT JOIN users su ON su.id = s.uploader_id
           LEFT JOIN LATERAL (SELECT created_at, author_id FROM ops WHERE doc_id = d.id ORDER BY seq DESC LIMIT 1) o ON true
           LEFT JOIN users ou ON ou.id = o.author_id
          WHERE d.project_id = $1 ORDER BY d.path",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    type At = Option<chrono::DateTime<chrono::Utc>>;
    let files: Vec<_> = rows
        .iter()
        .map(|r| {
            let (snap_at, op_at): (At, At) = (r.get("snap_at"), r.get("op_at"));
            // whichever is later: the last edit, or the last file stored whole
            let by_op = matches!((op_at, snap_at), (Some(o), Some(s)) if o >= s) || (op_at.is_some() && snap_at.is_none());
            let (at, login, name): (At, Option<String>, Option<String>) =
                if by_op { (op_at, r.get("op_login"), r.get("op_name")) } else { (snap_at, r.get("snap_login"), r.get("snap_name")) };
            json!({
                "docId": r.get::<Uuid, _>("id"), "path": r.get::<String, _>("path"), "docType": r.get::<String, _>("doc_type"),
                "bytes": r.get::<Option<i32>, _>("bytes"), "hasPreview": r.get::<bool, _>("has_preview"),
                "updatedAt": at.map(|t| t.to_rfc3339()),
                "updatedBy": login.map(|l| json!({ "login": l, "name": name })),
            })
        })
        .collect();
    Ok(Json(json!({ "files": files })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(path: &str) -> Document {
        Document { id: Uuid::new_v4(), project_id: Uuid::nil(), path: path.into(), doc_type: doc_type_for(path).into() }
    }

    #[test]
    fn the_shell_document_is_an_item_document_that_stays_put() {
        assert_eq!(doc_type_for(SHELL_PATH), "project_shell");
        assert!(allowed_file(SHELL_PATH) && crate::itemdoc::is_item_doc("project_shell"));
        assert!(crate::itemdoc::fold_text(SHELL_TEXT, &[]).is_ok());
        assert!(!crate::dockind::of("project_shell").thumbnail && crate::dockind::of("project_shell").journalled());
    }

    #[test]
    fn folder_names_and_paths() {
        assert_eq!(folder_name("  Motor   driver ").as_deref(), Some("Motor driver"));
        assert_eq!(folder_name("a/b:c").as_deref(), Some("a_b_c"));
        assert!(folder_name("..").is_none() && folder_name("   ").is_none());
        assert_eq!(clean_folder("/a/b/").as_deref(), Some("a/b"));
        assert_eq!(clean_folder("").as_deref(), Some(""));
        assert!(clean_folder("a/../b").is_none() && clean_folder("x.collab/y").is_none());
    }

    #[test]
    fn a_new_pcb_gets_a_folder_nobody_has() {
        let docs = vec![doc("PCB 1/PCB 1.kicad_pro"), doc("pcb 2.jpart"), doc("Lid.jpart")];
        assert_eq!(free_folder(&docs, "", "PCB 1"), "PCB 1 2");
        assert_eq!(free_folder(&docs, "", "PCB 2"), "PCB 2");
        assert_eq!(free_folder(&docs, "", "Main"), "Main");
        assert_eq!(free_folder(&docs, "boards", "PCB 1"), "boards/PCB 1");
    }

    #[test]
    fn moving_a_folder_takes_everything_in_it_and_nothing_else() {
        let docs = vec![doc("A/A.kicad_pro"), doc("A/A.kicad_sch"), doc("A/sub/x.kicad_sch"), doc("AB/AB.kicad_pcb"), doc("B/B.kicad_pro"), doc("lid.jpart")];
        let plan = plan_move(&docs, "A", "Main", false).unwrap();
        let paths: Vec<&str> = plan.iter().map(|(_, p)| p.as_str()).collect();
        assert_eq!(paths, ["Main/A.kicad_pro", "Main/A.kicad_sch", "Main/sub/x.kicad_sch"]);
        // "AB" is not inside "A"
        assert!(!plan.iter().any(|(id, _)| *id == docs[3].id));
        assert!(plan_move(&docs, "A", "B", false).is_err(), "onto another folder");
        assert!(plan_move(&docs, "A", "A/inner", false).is_err(), "into itself");
        assert!(plan_move(&docs, "A", "b", false).is_err(), "onto another folder, whatever the case");
        assert!(plan_move(&docs, "A", "lid.jpart", false).is_err(), "onto a file");
        assert!(plan_move(&docs, "nowhere", "X", false).is_err());
        assert!(plan_move(&docs, "", "X", false).is_err() && plan_move(&docs, "A", "", false).is_err());
        assert_eq!(plan_move(&docs, "A", "a", false).unwrap().len(), 3, "a change of letter case alone");
        assert!(plan_move(&docs, "A", "A", false).unwrap().is_empty());
        assert_eq!(plan_move(&docs, "A", "boards/A", false).unwrap()[0].1, "boards/A/A.kicad_pro");
    }

    #[test]
    fn a_renamed_pcb_takes_its_own_three_files_with_it() {
        let docs = vec![doc("A/A.kicad_pro"), doc("A/A.kicad_sch"), doc("A/A.kicad_pcb"), doc("A/power.kicad_sch"), doc("A/sub/A.kicad_sch"), doc("A/fp-lib-table")];
        let paths: Vec<String> = plan_move(&docs, "A", "x/Main", true).unwrap().into_iter().map(|(_, p)| p).collect();
        assert_eq!(paths, ["x/Main/Main.kicad_pro", "x/Main/Main.kicad_sch", "x/Main/Main.kicad_pcb", "x/Main/power.kicad_sch", "x/Main/sub/A.kicad_sch", "x/Main/fp-lib-table"]);
        // a sheet that already has the new name stops the rename rather than being overwritten
        let clash = vec![doc("A/A.kicad_sch"), doc("A/Main.kicad_sch")];
        assert!(plan_move(&clash, "A", "Main", true).is_err());
        // files named otherwise (an imported project in a folder of another name) keep their names
        let other = vec![doc("hw/amp.kicad_pro"), doc("hw/amp.kicad_sch")];
        assert_eq!(plan_move(&other, "hw", "Amp", true).unwrap()[0].1, "Amp/amp.kicad_pro");
        assert_eq!(restem("Main/A.kicad_pcb", "Main", "A"), "Main/Main.kicad_pcb");
        assert_eq!(restem("Main/A.kicad_sym", "Main", "A"), "Main/A.kicad_sym");
    }
}
