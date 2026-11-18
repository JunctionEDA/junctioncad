//! GitHub repository sync for online projects.
//!
//! An online project can be linked to one folder of one branch of a repository.
//! From then on the server can tell, file by file, what changed online, what
//! changed on GitHub and what changed on both — because it remembers the git blob
//! id each file had the last time the two agreed (`project_github_files`).
//!
//!   push  — commit the files that changed online onto the branch (or onto a new
//!           branch with a pull request).  Files GitHub changed are left alone.
//!   pull  — bring the files that changed on GitHub into the project.  A file that
//!           changed on both sides is merged item by item (merge.rs); only an item
//!           both sides changed differently needs a side picked.
//!
//! Nothing here ever force-pushes, and nothing rewrites a design file except by
//! replacing it with bytes from one side or with a merge of exact spans from both.
//!
//! The project's content is each document's latest snapshot.  Edits newer than
//! that live only as ops (the server has no document model to apply them), so
//! before reading the files a connected desktop client is asked for a fresh
//! snapshot; what no desktop saves is folded into the file by the server (compact.rs),
//! and a pull refuses to overwrite a document whose ops still could not be folded.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::doc_actor::DocMsg;
use crate::error::{AppError, AppResult};
use crate::http::{doc_type_for, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES};
use crate::lenient_json::LenientJson;
use crate::merge::Prefer;
use crate::persist::{self, Document, User};
use crate::AppState;

mod remote;
use remote::Remote;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ------------------------------------------------------------------ errors

fn api_err(status: StatusCode, code: &'static str, msg: impl Into<String>) -> AppError {
    AppError::Api(status, code, msg.into())
}

fn not_connected() -> AppError {
    api_err(
        StatusCode::CONFLICT,
        "github_not_connected",
        "Connect your GitHub repositories first.",
    )
}

/// A failed GitHub API call.
#[derive(Debug)]
struct GhErr {
    status: u16,
    message: String,
}

impl From<GhErr> for AppError {
    fn from(e: GhErr) -> Self {
        match e.status {
            401 => api_err(
                StatusCode::CONFLICT,
                "github_not_connected",
                "GitHub no longer accepts this connection. Connect your repositories again.",
            ),
            403 => api_err(
                StatusCode::FORBIDDEN,
                "github_forbidden",
                format!("GitHub refused: {}", e.message),
            ),
            404 => api_err(
                StatusCode::NOT_FOUND,
                "github_not_found",
                "GitHub can't find that, or your connection can't see it. Junction sees only the repositories \
                 you chose: add this one to its repositories on GitHub.",
            ),
            0 => api_err(StatusCode::BAD_GATEWAY, "github_unreachable", "GitHub could not be reached."),
            _ => api_err(
                StatusCode::BAD_GATEWAY,
                "github_error",
                format!("GitHub answered {}: {}", e.status, e.message),
            ),
        }
    }
}

// ------------------------------------------------------------------ token storage

fn cipher(state: &AppState) -> Aes256Gcm {
    let key = Sha256::digest(format!("kc-github-token:{}", state.cfg.jwt_secret).as_bytes());
    Aes256Gcm::new_from_slice(&key).expect("32-byte key")
}

/// Seal a secret for the database (nonce + AES-GCM ciphertext).
pub(crate) fn seal(state: &AppState, plain: &[u8]) -> AppResult<Vec<u8>> {
    let nonce: [u8; 12] = rand::random();
    let mut blob = nonce.to_vec();
    blob.extend(
        cipher(state)
            .encrypt(Nonce::from_slice(&nonce), plain)
            .map_err(|_| anyhow::anyhow!("token encryption failed"))?,
    );
    Ok(blob)
}

/// Open a sealed secret; None when it was sealed under another JWT_SECRET.
pub(crate) fn unseal(state: &AppState, blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 13 {
        return None;
    }
    let (nonce, body) = blob.split_at(12);
    cipher(state).decrypt(Nonce::from_slice(nonce), body).ok()
}

pub(crate) fn unseal_str(state: &AppState, blob: &[u8]) -> Option<String> {
    unseal(state, blob).and_then(|b| String::from_utf8(b).ok())
}

/// A token from the old OAuth app's `repo` / `public_repo` grant.
pub async fn store_token(state: &AppState, user_id: i64, token: &str, scopes: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO github_tokens (user_id, token, scopes, kind) VALUES ($1, $2, $3, 'oauth')
         ON CONFLICT (user_id) DO UPDATE
           SET token = EXCLUDED.token, scopes = EXCLUDED.scopes, kind = 'oauth', refresh = NULL,
               expires_at = NULL, refresh_expires_at = NULL, updated_at = now()",
    )
    .bind(user_id)
    .bind(seal(state, token.as_bytes())?)
    .bind(scopes)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// A repository grant as stored.
pub(crate) struct Grant {
    pub token: String,
    pub scopes: String,
    /// "oauth" (the old blanket `repo` grant) or "app" (the GitHub App, chosen repositories only).
    pub kind: String,
}

/// The user's repository grant, if they connected one that still decrypts.  A GitHub
/// App token about to expire is refreshed first (github_app::fresh).
pub(crate) async fn load_grant(state: &AppState, user_id: i64) -> AppResult<Option<Grant>> {
    let row = sqlx::query(
        "SELECT token, scopes, kind, expires_at < now() + interval '5 minutes' AS stale
         FROM github_tokens WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let kind: String = row.get("kind");
    if kind == "app" && row.get::<Option<bool>, _>("stale").unwrap_or(false) {
        return crate::github_app::refresh(state, user_id).await;
    }
    let blob: Vec<u8> = row.get("token");
    // A token sealed under another JWT_SECRET is simply gone: reconnect.
    Ok(unseal_str(state, &blob).map(|token| Grant { token, scopes: row.get("scopes"), kind }))
}

pub(crate) async fn drop_token(state: &AppState, user_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM github_tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

// ------------------------------------------------------------------ GitHub client

struct Gh {
    http: reqwest::Client,
    api: String,
    token: String,
    /// "app" when the token is a GitHub App user token (chosen repositories only).
    kind: String,
    /// Host of the GitHub web site, for telling which submodule URLs are GitHub's.
    web_host: String,
}

/// Percent-encode a path segment sequence, keeping `/`.
fn enc_path(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn enc(s: &str) -> String {
    enc_path(s).replace('/', "%2F")
}

impl Gh {
    async fn for_user(state: &AppState, user: &User) -> AppResult<Gh> {
        let Grant { token, kind, .. } = load_grant(state, user.id).await?.ok_or_else(not_connected)?;
        Ok(Gh {
            kind,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| anyhow::anyhow!("http client: {e}"))?,
            api: state.cfg.github_api_url.clone(),
            token,
            web_host: state.cfg.github_web_url.split("://").last().unwrap_or("").trim_end_matches('/').to_string(),
        })
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, GhErr> {
        let mut req = self
            .http
            .request(method, format!("{}{}", self.api, path))
            .header(reqwest::header::USER_AGENT, "kicad-collab-server")
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(|e| GhErr { status: 0, message: e.to_string() })?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| GhErr { status: 0, message: e.to_string() })?;
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| text.chars().take(200).collect());
            return Err(GhErr { status, message });
        }
        Ok(value)
    }

    async fn get(&self, path: &str) -> Result<Value, GhErr> {
        self.call(reqwest::Method::GET, path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, GhErr> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    /// The commit a branch points at; None when the branch (or any commit) is missing.
    async fn branch_head(&self, repo: &RepoRef, branch: &str) -> Result<Option<String>, GhErr> {
        Ok(self.branch_ref(repo, branch).await?.map(|(sha, _)| sha))
    }

    /// The head of a branch and the name it has now: GitHub goes on answering under the
    /// old name of a branch that was renamed there.
    async fn branch_ref(&self, repo: &RepoRef, branch: &str) -> Result<Option<(String, String)>, GhErr> {
        match self.get(&format!("/repos/{}/git/ref/heads/{}", repo.slug(), enc_path(branch))).await {
            Ok(v) => Ok(v["object"]["sha"].as_str().map(|sha| {
                let name = v["ref"].as_str().and_then(|r| r.strip_prefix("refs/heads/")).unwrap_or(branch);
                (sha.to_string(), name.to_string())
            })),
            // 404: no such branch.  409: the repository has no commits at all.
            Err(e) if e.status == 404 || e.status == 409 => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn commit_tree(&self, repo: &RepoRef, commit: &str) -> Result<String, GhErr> {
        let v = self.get(&format!("/repos/{}/git/commits/{commit}", repo.slug())).await?;
        v["tree"]["sha"]
            .as_str()
            .map(str::to_string)
            .ok_or(GhErr { status: 502, message: "commit has no tree".into() })
    }

    /// Every blob under a tree: path -> (blob sha, size).  The bool is GitHub's
    /// "truncated" flag (a repository too large to list in one call).
    async fn tree(&self, repo: &RepoRef, tree: &str) -> Result<(BTreeMap<String, (String, u64)>, bool), GhErr> {
        let v = self.get(&format!("/repos/{}/git/trees/{tree}?recursive=1", repo.slug())).await?;
        let mut out = BTreeMap::new();
        for e in v["tree"].as_array().into_iter().flatten() {
            if e["type"] == "blob" {
                if let (Some(p), Some(s)) = (e["path"].as_str(), e["sha"].as_str()) {
                    out.insert(p.to_string(), (s.to_string(), e["size"].as_u64().unwrap_or(0)));
                }
            }
        }
        Ok((out, v["truncated"].as_bool().unwrap_or(false)))
    }

    /// The tree of a folder inside `root`, found one level at a time so a project
    /// in a small corner of a huge repository never lists the whole repository.
    /// None when the folder does not exist there.
    async fn subtree(&self, repo: &RepoRef, root: &str, subdir: &str) -> Result<Option<String>, GhErr> {
        let mut cur = root.to_string();
        for seg in subdir.split('/').filter(|s| !s.is_empty()) {
            let v = self.get(&format!("/repos/{}/git/trees/{cur}", repo.slug())).await?;
            let next = v["tree"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|e| e["type"] == "tree" && e["path"] == seg)
                .and_then(|e| e["sha"].as_str().map(str::to_string));
            match next {
                Some(sha) => cur = sha,
                None => return Ok(None),
            }
        }
        Ok(Some(cur))
    }

    async fn blob(&self, repo: &RepoRef, sha: &str) -> Result<Vec<u8>, GhErr> {
        let v = self.get(&format!("/repos/{}/git/blobs/{sha}", repo.slug())).await?;
        let content: String =
            v["content"].as_str().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
        B64.decode(content).map_err(|_| GhErr { status: 502, message: "blob is not valid base64".into() })
    }
}

/// `owner/name`, validated to GitHub's own alphabet so it can go into a URL path.
#[derive(Debug, Clone)]
struct RepoRef {
    owner: String,
    name: String,
}

impl RepoRef {
    fn parse(s: &str) -> AppResult<RepoRef> {
        let s = s
            .trim()
            .trim_start_matches("https://github.com/")
            .trim_start_matches("github.com/")
            .trim_end_matches(".git")
            .trim_matches('/');
        let ok = |p: &str| {
            !p.is_empty()
                && p.len() <= 100
                && p != "."
                && p != ".."
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        };
        match s.split_once('/') {
            Some((o, n)) if ok(o) && ok(n) => Ok(RepoRef { owner: o.into(), name: n.into() }),
            _ => Err(AppError::BadRequest("Write the repository as owner/name.".into())),
        }
    }

    fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// A folder inside a repository: no leading/trailing slash, no dot segments.
fn clean_subdir(s: &str) -> AppResult<String> {
    let s = s.trim().replace('\\', "/");
    let s = s.trim_matches('/');
    if s.is_empty() || s == "." {
        return Ok(String::new());
    }
    if s.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") || s.contains(':') {
        return Err(AppError::BadRequest("That folder path is not valid.".into()));
    }
    Ok(s.to_string())
}

fn clean_branch(s: &str) -> AppResult<String> {
    let s = s.trim();
    let bad = s.is_empty()
        || s.len() > 200
        || s.starts_with('/')
        || s.ends_with('/')
        || s.starts_with('-')
        || s.contains("..")
        || s.contains("//")
        || s.ends_with(".lock")
        || s.bytes().any(|b| b <= b' ' || matches!(b, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\' | 0x7f));
    if bad {
        return Err(AppError::BadRequest("That branch name is not valid.".into()));
    }
    Ok(s.to_string())
}

/// The id git gives a file's content.
pub fn blob_sha(content: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(format!("blob {}\0", content.len()).as_bytes());
    h.update(content);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// ------------------------------------------------------------------ link storage

#[derive(Debug, Clone)]
struct Link {
    repo: RepoRef,
    branch: String,
    subdir: String,
    linked_by: Option<String>,
    base_commit: Option<String>,
    synced_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Push whenever a checkpoint is saved.
    auto_push: bool,
    /// What the last automatic push did.
    last_auto: Option<Value>,
}

impl Link {
    fn web_url(&self, state: &AppState) -> String {
        let mut url = format!(
            "{}/{}/tree/{}",
            state.cfg.github_web_url,
            self.repo.slug(),
            enc_path(&self.branch)
        );
        if !self.subdir.is_empty() {
            url.push('/');
            url.push_str(&enc_path(&self.subdir));
        }
        url
    }
}

async fn load_link(state: &AppState, project_id: Uuid) -> AppResult<Option<Link>> {
    let row = sqlx::query(
        "SELECT g.repo_owner, g.repo_name, g.branch, g.subdir, g.base_commit, g.synced_at, g.auto_push, g.last_auto, u.login
         FROM project_github g LEFT JOIN users u ON u.id = g.linked_by
         WHERE g.project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|r| Link {
        repo: RepoRef { owner: r.get("repo_owner"), name: r.get("repo_name") },
        branch: r.get("branch"),
        subdir: r.get("subdir"),
        linked_by: r.get("login"),
        base_commit: r.get("base_commit"),
        synced_at: r.get("synced_at"),
        auto_push: r.get("auto_push"),
        last_auto: r.get("last_auto"),
    }))
}

async fn save_link(
    state: &AppState,
    project_id: Uuid,
    repo: &RepoRef,
    branch: &str,
    subdir: &str,
    user_id: i64,
) -> AppResult<()> {
    let mut tx = state.pool.begin().await?;
    // A new link starts with no shared history: whatever the old one remembered
    // describes a different folder.  Linking again to the very place the project was
    // linked to (now, or before it was unlinked) keeps it: an edit made in between is
    // then a change to push, not two files that were never synced.
    let same: bool = sqlx::query_scalar(
        "SELECT EXISTS (
           SELECT 1 FROM (SELECT repo_owner, repo_name, branch, subdir FROM project_github WHERE project_id = $1
                          UNION ALL
                          SELECT repo_owner, repo_name, branch, subdir FROM project_github_last WHERE project_id = $1) was
           WHERE lower(was.repo_owner) = lower($2) AND lower(was.repo_name) = lower($3) AND was.branch = $4 AND was.subdir = $5)",
    )
    .bind(project_id)
    .bind(&repo.owner)
    .bind(&repo.name)
    .bind(branch)
    .bind(subdir)
    .fetch_one(&mut *tx)
    .await?;
    if !same {
        sqlx::query("DELETE FROM project_github_files WHERE project_id = $1")
            .bind(project_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM project_github_last WHERE project_id = $1").bind(project_id).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO project_github (project_id, repo_owner, repo_name, branch, subdir, linked_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id) DO UPDATE
           SET repo_owner = EXCLUDED.repo_owner, repo_name = EXCLUDED.repo_name,
               branch = EXCLUDED.branch, subdir = EXCLUDED.subdir, linked_by = EXCLUDED.linked_by,
               base_commit = NULL, synced_at = NULL, created_at = now(),
               auto_push = false, last_auto = NULL",
    )
    .bind(project_id)
    .bind(&repo.owner)
    .bind(&repo.name)
    .bind(branch)
    .bind(subdir)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// The repository each of these projects is linked to, for the project list.
pub async fn linked_repos(pool: &sqlx::PgPool, ids: &[Uuid]) -> AppResult<HashMap<Uuid, Value>> {
    let rows = sqlx::query(
        "SELECT project_id, repo_owner, repo_name, branch, subdir FROM project_github WHERE project_id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let (owner, name): (String, String) = (r.get("repo_owner"), r.get("repo_name"));
            (r.get("project_id"), json!({ "repo": format!("{owner}/{name}"), "branch": r.get::<String, _>("branch"), "path": r.get::<String, _>("subdir") }))
        })
        .collect())
}

/// What the last sync recorded for a file: its blob id, and the document it was.
#[derive(Debug, Clone)]
struct BaseRow {
    sha: String,
    doc_id: Option<Uuid>,
}

/// (project path, blob id, document) the two sides now agree on.
type Agreed = (String, String, Option<Uuid>);

async fn load_base(state: &AppState, project_id: Uuid) -> AppResult<HashMap<String, BaseRow>> {
    let rows = sqlx::query("SELECT path, blob_sha, doc_id FROM project_github_files WHERE project_id = $1")
        .bind(project_id)
        .fetch_all(&state.pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.get("path"), BaseRow { sha: r.get("blob_sha"), doc_id: r.get("doc_id") })).collect())
}

/// Record the blob ids the two sides now agree on, and the commit that was synced with.
async fn save_base(state: &AppState, project_id: Uuid, agreed: &[Agreed], commit: Option<&str>) -> AppResult<()> {
    let mut tx = state.pool.begin().await?;
    for (path, sha, doc_id) in agreed {
        sqlx::query(
            "INSERT INTO project_github_files (project_id, path, blob_sha, doc_id) VALUES ($1, $2, $3, $4)
             ON CONFLICT (project_id, path) DO UPDATE
               SET blob_sha = EXCLUDED.blob_sha, doc_id = COALESCE(EXCLUDED.doc_id, project_github_files.doc_id)",
        )
        .bind(project_id)
        .bind(path)
        .bind(sha)
        .bind(doc_id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(commit) = commit {
        sqlx::query("UPDATE project_github SET base_commit = $2, synced_at = now() WHERE project_id = $1")
            .bind(project_id)
            .bind(commit)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Forget what the last sync recorded for these paths (a file that was deleted or renamed).
async fn drop_base(state: &AppState, project_id: Uuid, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    sqlx::query("DELETE FROM project_github_files WHERE project_id = $1 AND path = ANY($2)")
        .bind(project_id)
        .bind(paths)
        .execute(&state.pool)
        .await?;
    Ok(())
}

// ------------------------------------------------------------------ comparing the two sides

/// The project's own file: the document's latest snapshot.
struct LocalFile {
    doc: Document,
    sha: String,
    size: usize,
    /// Ops applied after that snapshot — edits the file does not contain yet.
    unsaved_ops: i64,
}

async fn local_files(state: &AppState, project_id: Uuid) -> AppResult<BTreeMap<String, LocalFile>> {
    let mut out = BTreeMap::new();
    for doc in persist::project_documents(&state.pool, project_id).await? {
        // A document whose journal this server folds itself (a part studio, an assembly) is read
        // as it is now: its stored file is brought up to its last edit first, so it never shows
        // as having edits that some editor still has to save.
        if crate::dockind::of(&doc.doc_type).fold == crate::dockind::Fold::Server
            && persist::latest_snapshot_seq(&state.pool, doc.id).await? < persist::head_seq(&state.pool, doc.id).await?
        {
            if let Err(why) = crate::compact::fold(&state.pool, &doc).await {
                tracing::warn!(doc = %doc.id, "journal not folded: {why}");
            }
        }
        let Some((seq, content)) = persist::latest_snapshot(&state.pool, doc.id).await? else {
            continue;
        };
        let head = persist::head_seq(&state.pool, doc.id).await?;
        out.insert(
            doc.path.clone(),
            LocalFile { sha: blob_sha(&content), size: content.len(), unsaved_ops: head - seq, doc },
        );
    }
    Ok(out)
}

/// Ask connected desktop clients to save any document that has edits newer than its
/// snapshot, and give them a few seconds to do it.
async fn freshen(state: &AppState, project_id: Uuid) -> AppResult<()> {
    let mut waiting = Vec::new();
    for doc in persist::project_documents(&state.pool, project_id).await? {
        let head = persist::head_seq(&state.pool, doc.id).await?;
        if persist::latest_snapshot_seq(&state.pool, doc.id).await? >= head {
            continue;
        }
        if state.doc_event(doc.id, DocMsg::SnapshotNow).await {
            waiting.push(doc.id);
        }
    }
    for _ in 0..24 {
        if waiting.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        let mut still = Vec::new();
        for id in waiting {
            // "Caught up" means a snapshot at the head as it is *now*; a document
            // being edited this very second keeps moving and is allowed to time out.
            let head = persist::head_seq(&state.pool, id).await?;
            if persist::latest_snapshot_seq(&state.pool, id).await? < head {
                still.push(id);
            }
        }
        waiting = still;
    }
    // Whatever is still behind has no desktop editor to save it (a browser-only project, or
    // nobody has it open): the server folds those edits into the file itself.
    crate::compact::fold_project(&state.pool, project_id).await;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Change {
    Synced,
    /// Only the online project changed it (or has it at all).
    Push,
    /// Only GitHub changed it (or has it at all).
    Pull,
    /// Both changed it, differently.
    Conflict,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Change::Synced => "synced",
            Change::Push => "push",
            Change::Pull => "pull",
            Change::Conflict => "conflict",
        }
    }
}

/// What carrying a change over does to the other side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    /// The file's content (or the file itself, where it is new) goes across.
    Edit,
    /// The file was deleted on one side; carrying that over deletes it on the other.
    Delete,
}

/// Where a file stands, from its blob id online, on GitHub and at the last sync.
/// A file one side no longer has, that both had at the last sync, was deleted there.
fn classify(local: Option<&str>, remote: Option<&str>, base: Option<&str>) -> Option<(Change, Op, &'static str)> {
    Some(match (local, remote) {
        (None, None) => return None,
        (Some(l), Some(r)) if l == r => (Change::Synced, Op::Edit, "identical"),
        (Some(l), None) => match base {
            Some(b) if b == l => (Change::Pull, Op::Delete, "deleted on GitHub"),
            Some(_) => (Change::Conflict, Op::Delete, "deleted on GitHub, changed online"),
            None => (Change::Push, Op::Edit, "new online"),
        },
        (None, Some(r)) => match base {
            Some(b) if b == r => (Change::Push, Op::Delete, "deleted online"),
            Some(_) => (Change::Conflict, Op::Delete, "deleted online, changed on GitHub"),
            None => (Change::Pull, Op::Edit, "new on GitHub"),
        },
        (Some(l), Some(r)) => match base {
            Some(b) if b == r => (Change::Push, Op::Edit, "changed online"),
            Some(b) if b == l => (Change::Pull, Op::Edit, "changed on GitHub"),
            Some(_) => (Change::Conflict, Op::Edit, "changed on both sides"),
            None => (Change::Conflict, Op::Edit, "differs, and the two were never synced"),
        },
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Online,
    GitHub,
}

#[derive(Debug, Clone)]
struct Entry {
    /// The file's path as it is now (its new path, when it was renamed).
    path: String,
    change: Change,
    op: Op,
    detail: &'static str,
    local: Option<String>,
    remote: Option<String>,
    remote_size: u64,
    /// The path it had at the last sync, and which side renamed it.
    renamed: Option<(String, Side)>,
}

impl Entry {
    /// The path the online project has it under.
    fn local_path(&self) -> &str {
        match &self.renamed {
            Some((old, Side::GitHub)) => old,
            _ => &self.path,
        }
    }

    /// The path GitHub has it under.
    fn remote_path(&self) -> &str {
        match &self.renamed {
            Some((old, Side::Online)) => old,
            _ => &self.path,
        }
    }

    /// The path the last sync recorded it under.
    fn base_path(&self) -> &str {
        match &self.renamed {
            Some((old, _)) => old,
            None => &self.path,
        }
    }
}

/// Every file's standing.  A file that is gone under one name and present, unchanged,
/// under another is the same file renamed: one entry, not a delete and a new file.
fn compare(local: &BTreeMap<String, LocalFile>, remote: &Remote, base: &HashMap<String, BaseRow>) -> Vec<Entry> {
    let by_id: HashMap<Uuid, &String> = local.iter().map(|(p, f)| (f.doc.id, p)).collect();
    // Renamed on both sides, to different names: the file is gone from the path the last
    // sync knew on both, the document has a new path online, and the content of that
    // sync sits untouched under a path on GitHub that neither side knew.  GitHub's
    // rename is taken as read, which leaves a plain rename online to push: one file
    // under the online name, never two copies.
    let mut rebased: Option<HashMap<String, BaseRow>> = None;
    let mut both: HashSet<String> = HashSet::new(); // the online names
    for (old, b) in base {
        if local.contains_key(old) || remote.sha(old).is_some() {
            continue;
        }
        let Some(new_local) = b.doc_id.and_then(|id| by_id.get(&id)) else { continue };
        if base.contains_key(*new_local) || remote.sha(new_local).is_some() {
            continue;
        }
        let hit = remote.files.iter().find(|(q, f)| {
            f.sha == b.sha && !local.contains_key(*q) && !base.contains_key(*q) && doc_type_for(q) == doc_type_for(old)
                && !rebased.as_ref().is_some_and(|r| r.contains_key(*q))
        });
        if let Some((there, _)) = hit {
            let r = rebased.get_or_insert_with(|| base.clone());
            if let Some(row) = r.remove(old) {
                r.insert(there.clone(), row);
                both.insert((*new_local).clone());
            }
        }
    }
    let base = rebased.as_ref().unwrap_or(base);
    // Renamed online: the document the last sync knew under one path now has another.
    let mut renamed_online: HashMap<String, String> = HashMap::new(); // new -> old
    for (old, b) in base {
        if local.contains_key(old) {
            continue;
        }
        if let Some(new) = b.doc_id.and_then(|id| by_id.get(&id)) {
            // Only while GitHub still has it where it was, untouched or not; a file gone
            // there too is simply a new file online.
            if !base.contains_key(*new) && remote.sha(new).is_none() && remote.sha(old).is_some() {
                renamed_online.insert((*new).clone(), old.clone());
            }
        }
    }
    // Renamed on GitHub: gone from its path, and the very same content sits at a path
    // neither side knew.  (A rename with edits is found by `fuzzy_renames`.)
    let taken: HashSet<&String> = renamed_online.values().collect();
    let mut fresh: Vec<&String> =
        remote.files.keys().filter(|q| !local.contains_key(*q) && !base.contains_key(*q)).collect();
    let mut renamed_remote: HashMap<String, String> = HashMap::new(); // new -> old
    for (old, b) in base {
        if !local.contains_key(old) || remote.sha(old).is_some() || taken.contains(old) {
            continue;
        }
        let same = |q: &&&String| remote.sha(q) == Some(b.sha.as_str()) && doc_type_for(q) == doc_type_for(old);
        let name = old.rsplit('/').next();
        let hit = fresh.iter().find(|q| same(q) && q.rsplit('/').next() == name).or_else(|| fresh.iter().find(same)).copied();
        if let Some(new) = hit {
            fresh.retain(|q| *q != new);
            renamed_remote.insert(new.clone(), old.clone());
        }
    }
    let olds: HashSet<&String> = renamed_online.values().chain(renamed_remote.values()).collect();

    let paths: std::collections::BTreeSet<&String> = local.keys().chain(remote.files.keys()).collect();
    let size = |p: &str| remote.files.get(p).map(|f| f.size).unwrap_or(0);
    paths
        .into_iter()
        .filter(|p| !olds.contains(p))
        .filter_map(|path| {
            if let Some(old) = renamed_online.get(path) {
                let (l, r, b) = (local[path].sha.as_str(), remote.sha(old)?, base[old].sha.as_str());
                let (change, detail) = if both.contains(path) {
                    (Change::Push, "renamed online and on GitHub; pushing keeps the online name")
                } else if r == b || l == r {
                    (Change::Push, "renamed online")
                } else {
                    (Change::Conflict, "renamed online, changed on GitHub")
                };
                return Some(Entry {
                    path: path.clone(), change, op: Op::Edit, detail,
                    local: Some(l.to_string()), remote: Some(r.to_string()), remote_size: size(old),
                    renamed: Some((old.clone(), Side::Online)),
                });
            }
            if let Some(old) = renamed_remote.get(path) {
                let (l, r, b) = (local[old].sha.as_str(), remote.sha(path)?, base[old].sha.as_str());
                // The content on GitHub is what the last sync had (an exact rename), so
                // only the name comes across; edits made online stay, to be pushed after.
                let detail = if l == b { "renamed on GitHub" } else { "renamed on GitHub, changed online" };
                return Some(Entry {
                    path: path.clone(), change: Change::Pull, op: Op::Edit, detail,
                    local: Some(l.to_string()), remote: Some(r.to_string()), remote_size: size(path),
                    renamed: Some((old.clone(), Side::GitHub)),
                });
            }
            let l = local.get(path).map(|f| f.sha.as_str());
            let r = remote.sha(path);
            let (change, op, detail) = classify(l, r, base.get(path).map(|b| b.sha.as_str()))?;
            Some(Entry {
                path: path.clone(), change, op, detail,
                local: l.map(str::to_string), remote: r.map(str::to_string), remote_size: size(path),
                renamed: None,
            })
        })
        .collect()
}

/// Renames on GitHub that also changed the file: a file deleted there and a new one of
/// the same kind that is recognisably the same file (remote::similar) become one entry.
async fn fuzzy_renames(state: &AppState, gh: &Gh, v: &mut View) -> AppResult<()> {
    const MOST: usize = 6;
    const LIMIT: u64 = 40 * 1024 * 1024;
    let gone: Vec<usize> = v.entries.iter().enumerate()
        .filter(|(_, e)| e.op == Op::Delete && e.remote.is_none() && e.local.is_some() && e.renamed.is_none())
        .map(|(i, _)| i).take(MOST).collect();
    let fresh: Vec<usize> = v.entries.iter().enumerate()
        .filter(|(_, e)| e.change == Change::Pull && e.op == Op::Edit && e.local.is_none() && e.remote_size <= LIMIT)
        .map(|(i, _)| i).take(MOST * 2).collect();
    if gone.is_empty() || fresh.is_empty() {
        return Ok(());
    }
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut used: HashSet<usize> = HashSet::new();
    let mut theirs: HashMap<usize, Vec<u8>> = HashMap::new();
    for g in gone {
        let old = &v.entries[g];
        let kind = doc_type_for(&old.path);
        if matches!(kind, "model3d" | "other") {
            continue;
        }
        let Some(lf) = v.local.get(&old.path) else { continue };
        let candidates: Vec<usize> = fresh.iter().copied()
            .filter(|f| !used.contains(f) && doc_type_for(&v.entries[*f].path) == kind).collect();
        if candidates.is_empty() {
            continue;
        }
        let Some((_, ours)) = persist::latest_snapshot(&state.pool, lf.doc.id).await? else { continue };
        for f in candidates {
            if !theirs.contains_key(&f) {
                let Some(bytes) = v.remote.blob(gh, &v.entries[f].path).await? else { continue };
                theirs.insert(f, bytes);
            }
            if remote::similar(&ours, &theirs[&f]) {
                used.insert(f);
                pairs.push((g, f));
                break;
            }
        }
    }
    let mut drop: Vec<usize> = Vec::new();
    for (g, f) in pairs {
        let old = v.entries[g].clone();
        let new = &mut v.entries[f];
        let untouched = v.base.get(&old.path).is_some_and(|b| Some(&b.sha) == old.local.as_ref());
        new.local = old.local.clone();
        new.renamed = Some((old.path.clone(), Side::GitHub));
        (new.change, new.detail) = if untouched {
            (Change::Pull, "renamed and changed on GitHub")
        } else {
            (Change::Conflict, "renamed on GitHub, changed on both sides")
        };
        drop.push(g);
    }
    drop.sort_unstable();
    for g in drop.into_iter().rev() {
        v.entries.remove(g);
    }
    Ok(())
}

/// The project is no longer where the link says it is.
struct Missing {
    /// "branch", "folder" or "project".
    reason: &'static str,
    message: String,
    /// Folders of the branch that look like the project, when it is not clear which it moved to.
    candidates: Vec<String>,
}

/// Both sides of a linked project, compared.
struct View {
    link: Link,
    remote: Remote,
    local: BTreeMap<String, LocalFile>,
    base: HashMap<String, BaseRow>,
    entries: Vec<Entry>,
    missing: Option<Missing>,
    /// The folder was found somewhere else and the link followed it: (from, to).
    moved: Option<(String, String)>,
    /// The branch was renamed on GitHub (or merged and deleted) and the link followed it: (from, to).
    branch_moved: Option<(String, String)>,
}

/// Where a branch that is gone may have gone: the name GitHub forwards the old one to
/// (a branch renamed there), then the repository's default branch.  The bool says the
/// branch was renamed, so it holds the very same commits.
async fn branch_successors(gh: &Gh, repo: &RepoRef, old: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    if let Ok(v) = gh.get(&format!("/repos/{}/branches/{}", repo.slug(), enc_path(old))).await {
        if let Some(name) = v["name"].as_str().filter(|n| *n != old) {
            out.push((name.to_string(), true));
        }
    }
    if let Ok(v) = gh.get(&format!("/repos/{}", repo.slug())).await {
        if let Some(name) = v["default_branch"].as_str().filter(|n| *n != old && !out.iter().any(|(o, _)| o == n)) {
            out.push((name.to_string(), false));
        }
    }
    out
}

/// Whether what the last sync knew of the project is gone from GitHub: no files of the
/// folder left, or its project file gone without another in its place.
fn project_gone(remote: &Remote, base: &HashMap<String, BaseRow>) -> bool {
    let own = |p: &&String| !p.starts_with("../");
    if !base.keys().any(|p| own(&p)) {
        return false;
    }
    if !remote.files.keys().any(|p| own(&p)) {
        return true;
    }
    let is_pro = |p: &&String| p.ends_with(".kicad_pro") && !p.contains('/');
    let had_pro = base.keys().any(|p| is_pro(&p));
    had_pro && !remote.files.keys().any(|p| is_pro(&p))
}

/// Read both sides.  When the folder is gone, look for where it went: a single match
/// is followed (the link moves with the folder, its history with it); otherwise the
/// project is reported missing and nothing is compared — nothing is ever deleted
/// online because a folder disappeared.
async fn view(state: &AppState, gh: &Gh, id: Uuid, mut link: Link) -> AppResult<View> {
    let base = load_base(state, id).await?;
    let local = local_files(state, id).await?;
    // A file outside the folder that was renamed with git is looked for by its content —
    // unless its document was deleted online, which a rename must not bring back.
    let live: HashSet<Uuid> = local.values().map(|l| l.doc.id).collect();
    let known: Vec<(String, String)> = base
        .iter()
        .map(|(p, b)| (p.clone(), if b.doc_id.is_some_and(|d| live.contains(&d)) { b.sha.clone() } else { String::new() }))
        .collect();
    let mut remote = remote::read(&state.pool, gh, &link.repo, &link.branch, &link.subdir, &known).await?;
    let mut missing = None;
    let mut moved = None;
    let mut branch_moved = None;
    // Renamed on GitHub: it still answers under the old name, and says its new one.
    if let Some(now) = remote.branch.clone().filter(|b| *b != link.branch) {
        sqlx::query("UPDATE project_github SET branch = $2 WHERE project_id = $1").bind(id).bind(&now).execute(&state.pool).await?;
        branch_moved = Some((std::mem::replace(&mut link.branch, now.clone()), now));
    }
    // The branch is gone: renamed on GitHub (master to main), or merged and deleted.
    // The link follows when the project is plainly there: always after a rename, and on
    // the default branch when it holds at least half the files as they were last synced.
    if remote.head.is_none() && base.keys().any(|p| !p.starts_with("../")) {
        for (to, renamed) in branch_successors(gh, &link.repo, &link.branch).await {
            let there = remote::read(&state.pool, gh, &link.repo, &to, &link.subdir, &known).await?;
            if there.head.is_none() || project_gone(&there, &base) {
                continue;
            }
            let own: Vec<_> = base.iter().filter(|(p, _)| !p.starts_with("../")).collect();
            let same = own.iter().filter(|(p, b)| there.sha(p) == Some(b.sha.as_str())).count();
            if !renamed && same * 2 < own.len() {
                continue;
            }
            sqlx::query("UPDATE project_github SET branch = $2 WHERE project_id = $1")
                .bind(id)
                .bind(&to)
                .execute(&state.pool)
                .await?;
            let from = std::mem::replace(&mut link.branch, to.clone());
            branch_moved = Some((from, to));
            remote = there;
            break;
        }
    }
    if project_gone(&remote, &base) {
        let shas: HashMap<String, String> = base.iter().map(|(p, b)| (p.clone(), b.sha.clone())).collect();
        let (mut candidates, clear) = match &remote.tree {
            Some(tree) => remote::find_moved(gh, &link.repo, tree, &shas, &link.subdir).await?,
            None => (Vec::new(), false),
        };
        if clear {
            let to = candidates.remove(0);
            sqlx::query("UPDATE project_github SET subdir = $2 WHERE project_id = $1")
                .bind(id)
                .bind(&to)
                .execute(&state.pool)
                .await?;
            let from = std::mem::replace(&mut link.subdir, to.clone());
            moved = Some((from, to));
            remote = remote::read(&state.pool, gh, &link.repo, &link.branch, &link.subdir, &known).await?;
        } else {
            let at = if link.subdir.is_empty() { "the repository root".to_string() } else { link.subdir.clone() };
            let (reason, what) = if remote.head.is_none() {
                ("branch", format!("The branch {} is no longer on GitHub.", link.branch))
            } else if !remote.folder_exists {
                ("folder", format!("{at} is no longer in {} ({}).", link.repo.slug(), link.branch))
            } else {
                ("project", format!("The project is no longer in {at} of {} ({}).", link.repo.slug(), link.branch))
            };
            missing = Some(Missing {
                reason,
                message: format!("{what} Nothing online was changed, and syncing is paused until you choose what to do."),
                candidates,
            });
        }
    }
    let mut entries = if missing.is_some() { Vec::new() } else { compare(&local, &remote, &base) };
    // A Git LFS file is never written over or taken for deleted.
    entries.retain(|e| !remote.lfs.contains(&e.path));
    let mut v = View { link, remote, local, base, entries, missing, moved, branch_moved };
    if v.missing.is_none() {
        fuzzy_renames(state, gh, &mut v).await?;
    }
    Ok(v)
}

fn project_missing(m: &Missing) -> AppError {
    api_err(StatusCode::CONFLICT, "project_missing", m.message.clone())
}

/// A file a pull is about to remove: keep its content so it can be put back.
async fn keep_removed(state: &AppState, project_id: Uuid, user_id: i64, doc: &Document) -> AppResult<()> {
    let Some((_, content)) = persist::latest_snapshot(&state.pool, doc.id).await? else { return Ok(()) };
    sqlx::query(
        "INSERT INTO project_github_removed (project_id, path, doc_type, content, removed_by) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(project_id)
    .bind(&doc.path)
    .bind(&doc.doc_type)
    .bind(content)
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    // Keep the most recent few dozen.
    sqlx::query(
        "DELETE FROM project_github_removed WHERE project_id = $1 AND id NOT IN
           (SELECT id FROM project_github_removed WHERE project_id = $1 ORDER BY removed_at DESC, id DESC LIMIT 60)",
    )
    .bind(project_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

// ------------------------------------------------------------------ access

struct Access {
    project: persist::Project,
    role: String,
    is_owner: bool,
}

async fn access(state: &AppState, user: &User, project_id: Uuid) -> AppResult<Access> {
    let project = persist::get_project(&state.pool, project_id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user.id, project_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    let is_owner = project.owner_id == user.id;
    Ok(Access { project, role, is_owner })
}

fn require_editor(a: &Access) -> AppResult<()> {
    if a.role != "editor" {
        return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only editors can sync a project with GitHub."));
    }
    Ok(())
}

// ------------------------------------------------------------------ connection endpoints

/// Whether the caller has granted repository access, and with what reach.
pub async fn connection(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Response> {
    let grant = load_grant(&state, user.id).await?;
    let app = crate::github_app::creds(&state).await?;
    let scopes = grant.as_ref().map(|g| g.scopes.clone()).unwrap_or_default();
    let via_app = grant.as_ref().is_some_and(|g| g.kind == "app");
    let private = via_app || scopes.split([',', ' ']).any(|s| s == "repo");
    Ok(Json(json!({
        "configured": state.cfg.github_client_id.is_some() || app.is_some(),
        "connected": grant.is_some(),
        "login": user.login,
        "avatarUrl": user.avatar_url,
        "scopes": scopes,
        "privateRepos": private,
        // Junction's GitHub App, when registered: connecting goes through it.
        "app": app.as_ref().map(|a| json!({ "name": a.name, "slug": a.slug, "url": a.html_url })),
        "via": grant.as_ref().map(|g| if g.kind == "app" { "app" } else { "oauth" }),
        // Still on the old grant that reaches every repository: offer the switch.
        "legacy": app.is_some() && grant.as_ref().is_some_and(|g| g.kind != "app"),
        "manageUrl": format!("{}/settings/installations", state.cfg.github_web_url),
    }))
    .into_response())
}

/// Forget the caller's repository token, and with a GitHub App token also withdraw the
/// app's authorization on GitHub.  Links stay; syncing them needs a connected account again.
pub async fn disconnect(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Response> {
    if let Some(g) = load_grant(&state, user.id).await?.filter(|g| g.kind == "app") {
        if let Some(app) = crate::github_app::creds(&state).await? {
            crate::github_app::revoke_grant(&state, &app.client_id, &app.client_secret, &g.token).await;
        }
    }
    drop_token(&state, user.id).await?;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
pub struct RepoQuery {
    #[serde(default)]
    pub q: String,
}

/// Repositories the caller can reach, most recently pushed first.
pub async fn list_repos(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<RepoQuery>,
) -> AppResult<Response> {
    let gh = Gh::for_user(&state, &user).await?;
    let needle = q.q.trim().to_ascii_lowercase();
    let mut repos = Vec::new();
    let keep = |r: &Value, repos: &mut Vec<Value>| {
        let full = r["full_name"].as_str().unwrap_or("").to_string();
        if !needle.is_empty() && !full.to_ascii_lowercase().contains(&needle) {
            return;
        }
        repos.push(json!({
            "fullName": full,
            "private": r["private"].as_bool().unwrap_or(false),
            "defaultBranch": r["default_branch"],
            "description": r["description"],
            "pushedAt": r["pushed_at"],
            "canPush": r["permissions"]["push"].as_bool().unwrap_or(false),
        }));
    };
    if gh.kind == "app" {
        // Only what the person installed the app on: every installation they can see,
        // then the repositories each was given.
        let installs = gh.get("/user/installations?per_page=100").await?;
        for inst in installs["installations"].as_array().cloned().unwrap_or_default() {
            let Some(iid) = inst["id"].as_i64() else { continue };
            for page in 1..=10 {
                let v = gh.get(&format!("/user/installations/{iid}/repositories?per_page=100&page={page}")).await?;
                let items = v["repositories"].as_array().cloned().unwrap_or_default();
                for r in &items {
                    keep(r, &mut repos);
                }
                if items.len() < 100 {
                    break;
                }
            }
        }
        repos.sort_by(|a, b| b["pushedAt"].as_str().unwrap_or("").cmp(a["pushedAt"].as_str().unwrap_or("")));
        repos.dedup_by(|a, b| a["fullName"] == b["fullName"]);
        return Ok(Json(json!({ "repos": repos, "installations": installs["total_count"] })).into_response());
    }
    for page in 1..=3 {
        let v = gh
            .get(&format!(
                "/user/repos?per_page=100&page={page}&sort=pushed&affiliation=owner,collaborator,organization_member"
            ))
            .await?;
        let items = v.as_array().cloned().unwrap_or_default();
        let n = items.len();
        for r in items {
            let full = r["full_name"].as_str().unwrap_or("").to_string();
            if !needle.is_empty() && !full.to_ascii_lowercase().contains(&needle) {
                continue;
            }
            repos.push(json!({
                "fullName": full,
                "private": r["private"].as_bool().unwrap_or(false),
                "defaultBranch": r["default_branch"],
                "description": r["description"],
                "pushedAt": r["pushed_at"],
                "canPush": r["permissions"]["push"].as_bool().unwrap_or(false),
            }));
        }
        if n < 100 {
            break;
        }
    }
    Ok(Json(json!({ "repos": repos })).into_response())
}

#[derive(Deserialize)]
pub struct ScanQuery {
    pub repo: String,
    pub branch: Option<String>,
}

/// The online projects the caller can open that are already linked to a folder of this branch.
async fn linked_here(state: &AppState, user: &User, repo: &RepoRef, branch: &str) -> AppResult<HashMap<String, (Uuid, String)>> {
    let rows = sqlx::query(
        "SELECT g.project_id, g.subdir, p.name FROM project_github g JOIN projects p ON p.id = g.project_id
         WHERE lower(g.repo_owner) = lower($1) AND lower(g.repo_name) = lower($2) AND g.branch = $3
           AND p.deleted_at IS NULL ORDER BY g.created_at",
    )
    .bind(&repo.owner)
    .bind(&repo.name)
    .bind(branch)
    .fetch_all(&state.pool)
    .await?;
    let mut out = HashMap::new();
    for r in rows {
        let pid: Uuid = r.get("project_id");
        if persist::effective_role(&state.pool, user.id, pid).await?.is_some() {
            out.entry(r.get::<String, _>("subdir")).or_insert((pid, r.get::<String, _>("name")));
        }
    }
    Ok(out)
}

/// Folders of a repository that hold a KiCad project, so one or several can be picked.
/// Every folder with a project file is listed, submodules included; each says what it
/// shares with the others (a library outside its folder) and whether it is online already.
pub async fn scan_repo(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ScanQuery>,
) -> AppResult<Response> {
    let gh = Gh::for_user(&state, &user).await?;
    let repo = RepoRef::parse(&q.repo)?;
    let info = gh.get(&format!("/repos/{}", repo.slug())).await?;
    let default_branch = info["default_branch"].as_str().unwrap_or("main").to_string();
    let branch = match q.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => clean_branch(b)?,
        None => default_branch.clone(),
    };
    let branches: Vec<String> = gh
        .get(&format!("/repos/{}/branches?per_page=100", repo.slug()))
        .await?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["name"].as_str().map(str::to_string))
        .collect();

    let (remote, found) = remote::scan(&gh, &repo, &branch).await?;
    let online = linked_here(&state, &user, &repo, &branch).await?;
    // which of them the caller owns (and so may unlink)
    let ids: Vec<Uuid> = online.values().map(|(pid, _)| *pid).collect();
    let owned: HashSet<Uuid> = sqlx::query_scalar("SELECT id FROM projects WHERE id = ANY($1) AND owner_id = $2")
        .bind(&ids)
        .bind(user.id)
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .collect();
    let projects: Vec<Value> = found
        .iter()
        .map(|f| {
            let mut p = json!({ "path": f.path, "name": f.name, "files": f.files });
            if f.project_files.len() > 1 {
                p["projectFiles"] = json!(f.project_files);
            }
            if let Some(inside) = &f.inside {
                p["inside"] = json!(inside);
            }
            if let Some(sub) = &f.submodule {
                p["submodule"] = json!(sub);
            }
            if !f.shared.is_empty() {
                p["shared"] = f.shared.iter().map(|(path, at, found)| json!({ "path": path, "repoPath": at, "found": found })).collect();
            }
            if let Some((pid, name)) = online.get(&f.path) {
                p["online"] = json!({ "projectId": pid, "name": name, "isOwner": owned.contains(pid) });
            }
            p
        })
        .collect();

    let mut out = json!({
        "repo": repo.slug(),
        "private": info["private"].as_bool().unwrap_or(false),
        "canPush": info["permissions"]["push"].as_bool().unwrap_or(false),
        "defaultBranch": default_branch,
        "branch": branch,
        "branchExists": remote.head.is_some(),
        "branches": branches,
        "projects": projects,
        "truncated": remote.truncated,
    });
    if !remote.notes.is_empty() {
        out["notes"] = json!(remote.notes);
    }
    Ok(Json(out).into_response())
}

// ------------------------------------------------------------------ import

#[derive(Deserialize)]
pub struct ImportRequest {
    pub repo: String,
    pub branch: Option<String>,
    #[serde(default)]
    pub path: String,
    /// Several folders at once, each becoming its own online project.
    pub paths: Option<Vec<String>>,
    pub name: Option<String>,
    /// Bring a folder online again although a project the caller can open is linked to it.
    #[serde(default)]
    pub duplicate: bool,
}

/// Download files of the GitHub side, a few at a time, in the order asked for.
async fn fetch_files(gh: &Gh, remote: &Remote, paths: &[String]) -> Result<Vec<Vec<u8>>, GhErr> {
    let mut out = Vec::with_capacity(paths.len());
    for group in paths.chunks(6) {
        let jobs = group.iter().map(|p| {
            let f = &remote.files[p];
            gh.blob(remote.repo_of(f), &f.sha)
        });
        out.extend(futures_util::future::try_join_all(jobs).await?);
    }
    Ok(out)
}

/// One repository folder brought online: a new project, linked and in sync.
async fn import_one(
    state: &AppState,
    user: &User,
    gh: &Gh,
    repo: &RepoRef,
    branch: &str,
    subdir: &str,
    name: Option<&str>,
) -> AppResult<Value> {
    let remote = remote::read(&state.pool, gh, repo, branch, subdir, &[]).await?;
    let head = remote.head.clone().ok_or_else(|| {
        AppError::BadRequest(format!("{} has no branch named {branch}.", repo.slug()))
    })?;
    if remote.files.is_empty() {
        // A folder that is a submodule Junction cannot open says so itself.
        let why = remote.notes.first().and_then(|n| n["message"].as_str()).map(str::to_string);
        return Err(AppError::BadRequest(why.unwrap_or_else(|| "There are no KiCad files in that folder.".into())));
    }
    if remote.files.len() > MAX_FILES {
        return Err(AppError::BadRequest(format!(
            "That project has too many files with the libraries it shares ({}, max {MAX_FILES}).",
            remote.files.len()
        )));
    }
    let total: u64 = remote.files.values().map(|f| f.size).sum();
    if total > MAX_TOTAL_BYTES || remote.files.values().any(|f| f.size > MAX_FILE_BYTES) {
        return Err(AppError::BadRequest("That project is too large to bring online.".into()));
    }

    // Download everything before creating anything, so a failure leaves no half project.
    let paths: Vec<String> = remote.files.keys().cloned().collect();
    let contents = fetch_files(gh, &remote, &paths).await?;

    let folder = subdir.rsplit('/').next().filter(|s| !s.is_empty());
    let pros: Vec<&str> = paths.iter().filter(|p| !p.contains('/')).filter_map(|p| p.strip_suffix(".kicad_pro")).collect();
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        // the project file named like its folder, else the first one, else the folder
        .or_else(|| pros.iter().find(|p| Some(**p) == folder).or(pros.first()).map(|p| p.to_string()))
        .unwrap_or_else(|| folder.unwrap_or(&repo.name).to_string());

    let project = persist::create_project(&state.pool, user.id, &name).await?;
    let mut agreed = Vec::new();
    for (path, content) in paths.iter().zip(&contents) {
        let doc = persist::create_document(&state.pool, project.id, path, doc_type_for(path)).await?;
        persist::insert_snapshot(&state.pool, doc.id, 0, content, None, Some(user.id)).await?;
        agreed.push((path.clone(), remote.files[path].sha.clone(), Some(doc.id)));
    }
    save_link(state, project.id, repo, branch, subdir, user.id).await?;
    save_base(state, project.id, &agreed, Some(&head)).await?;

    let mut out = json!({ "projectId": project.id, "name": project.name, "files": contents.len(), "path": subdir });
    let shared = paths.iter().filter(|p| p.starts_with("../")).count();
    if shared > 0 {
        out["shared"] = json!(shared);
    }
    if !remote.notes.is_empty() {
        out["notes"] = json!(remote.notes);
    }
    Ok(out)
}

/// Create online projects from repository folders, already linked and in sync.  With
/// `paths`, one project per folder; a folder that fails does not stop the others.
pub async fn import_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    LenientJson(req): LenientJson<ImportRequest>,
) -> AppResult<Response> {
    let gh = Gh::for_user(&state, &user).await?;
    let repo = RepoRef::parse(&req.repo)?;
    let branch = match req.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => clean_branch(b)?,
        None => gh.get(&format!("/repos/{}", repo.slug())).await?["default_branch"]
            .as_str()
            .unwrap_or("main")
            .to_string(),
    };
    let online = linked_here(&state, &user, &repo, &branch).await?;
    let already = |subdir: &str| -> Option<&(Uuid, String)> { if req.duplicate { None } else { online.get(subdir) } };

    let Some(paths) = &req.paths else {
        let subdir = clean_subdir(&req.path)?;
        if let Some((_, name)) = already(&subdir) {
            return Err(api_err(
                StatusCode::CONFLICT,
                "already_online",
                format!("That folder is already online as \"{name}\". Open that project instead of making a second copy."),
            ));
        }
        let out = import_one(&state, &user, &gh, &repo, &branch, &subdir, req.name.as_deref()).await?;
        return Ok(Json(out).into_response());
    };

    if paths.is_empty() || paths.len() > 40 {
        return Err(AppError::BadRequest("Choose between 1 and 40 projects.".into()));
    }
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for raw in paths {
        let subdir = clean_subdir(raw)?;
        if !seen.insert(subdir.clone()) {
            continue;
        }
        if let Some((pid, name)) = already(&subdir) {
            results.push(json!({ "path": subdir, "projectId": pid, "name": name, "existing": true }));
            continue;
        }
        match import_one(&state, &user, &gh, &repo, &branch, &subdir, None).await {
            Ok(v) => results.push(v),
            Err(e) => results.push(json!({ "path": subdir, "error": e.to_string() })),
        }
    }
    Ok(Json(json!({ "projects": results })).into_response())
}

// ------------------------------------------------------------------ link / unlink

#[derive(Deserialize)]
pub struct CreateRepo {
    pub name: String,
    #[serde(default = "yes")]
    pub private: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
pub struct LinkRequest {
    /// `owner/name` of an existing repository…
    pub repo: Option<String>,
    /// …or a new one to create under the caller's account.
    pub create: Option<CreateRepo>,
    pub branch: Option<String>,
    #[serde(default)]
    pub path: String,
}

/// Point a project at a repository folder.  Owner only.  Nothing is written to
/// GitHub (beyond creating the repository, when asked) until the first push.
pub async fn link_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<LinkRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    if !a.is_owner {
        return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only the project's owner can link it to a repository."));
    }
    let gh = Gh::for_user(&state, &user).await?;
    let subdir = clean_subdir(&req.path)?;

    let info = if let Some(create) = &req.create {
        if gh.kind == "app" {
            // The app is deliberately not allowed to administer repositories.
            return Err(api_err(
                StatusCode::BAD_REQUEST,
                "github_app_cannot_create",
                "Junction can only see the repositories you choose, so it can't create one. Create it on GitHub, \
                 add it to Junction's repositories, then pick it here.",
            ));
        }
        let name = create.name.trim();
        // Validates the name against GitHub's alphabet.
        RepoRef::parse(&format!("{}/{name}", user.login))?;
        gh.post(
            "/user/repos",
            json!({
                "name": name,
                "private": create.private,
                "description": format!("{} — KiCad project, synced with Junction", a.project.name),
                "auto_init": true,
            }),
        )
        .await
        .map_err(|e| match e.status {
            422 => AppError::BadRequest(format!("GitHub would not create \"{name}\": {}. Is the name taken?", e.message)),
            _ => e.into(),
        })?
    } else {
        let repo = RepoRef::parse(req.repo.as_deref().unwrap_or(""))?;
        gh.get(&format!("/repos/{}", repo.slug())).await?
    };

    let repo = RepoRef::parse(info["full_name"].as_str().unwrap_or(""))?;
    let branch = match req.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => clean_branch(b)?,
        None => info["default_branch"].as_str().unwrap_or("main").to_string(),
    };
    save_link(&state, id, &repo, &branch, &subdir, user.id).await?;
    Ok(Json(json!({ "ok": true, "repo": repo.slug(), "branch": branch, "path": subdir })).into_response())
}

pub async fn unlink_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    if !a.is_owner {
        return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only the project's owner can unlink it."));
    }
    // What the last sync knew stays, with where it was: linking to the same place again picks it up.
    sqlx::query(
        "INSERT INTO project_github_last (project_id, repo_owner, repo_name, branch, subdir)
         SELECT project_id, repo_owner, repo_name, branch, subdir FROM project_github WHERE project_id = $1
         ON CONFLICT (project_id) DO UPDATE SET repo_owner = EXCLUDED.repo_owner, repo_name = EXCLUDED.repo_name,
           branch = EXCLUDED.branch, subdir = EXCLUDED.subdir",
    )
    .bind(id)
    .execute(&state.pool)
    .await?;
    sqlx::query("DELETE FROM project_github WHERE project_id = $1").bind(id).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })).into_response())
}

// ------------------------------------------------------------------ status

fn link_json(state: &AppState, link: &Link) -> Value {
    json!({
        "repo": link.repo.slug(),
        "branch": link.branch,
        "path": link.subdir,
        "url": link.web_url(state),
        "linkedBy": link.linked_by,
        "baseCommit": link.base_commit,
        "syncedAt": link.synced_at.map(|t| t.to_rfc3339()),
        "autoPush": link.auto_push,
        "lastAuto": link.last_auto,
    })
}

/// Everything the sync page shows: the link, both sides' head, and each file's standing.
pub async fn project_status(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    let grant = load_grant(&state, user.id).await?;
    let connected = grant.is_some();
    let app = crate::github_app::creds(&state).await?;
    let app_ready = app.is_some();
    let mut out = json!({
        "project": { "projectId": a.project.id, "name": a.project.name, "role": a.role, "isOwner": a.is_owner },
        "github": {
            "configured": state.cfg.github_client_id.is_some() || app_ready,
            "connected": connected,
            "login": user.login,
            "via": grant.as_ref().map(|g| if g.kind == "app" { "app" } else { "oauth" }),
            "legacy": app_ready && grant.as_ref().is_some_and(|g| g.kind != "app"),
            "app": app.as_ref().map(|a| json!({ "name": a.name, "slug": a.slug, "url": a.html_url })),
        },
        "link": Value::Null,
    });
    let Some(mut link) = load_link(&state, id).await? else {
        // Where it was linked until it was unlinked: linking there again carries on.
        if let Some(r) = sqlx::query("SELECT repo_owner, repo_name, branch, subdir FROM project_github_last WHERE project_id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
        {
            let (owner, name): (String, String) = (r.get("repo_owner"), r.get("repo_name"));
            out["lastLink"] = json!({ "repo": format!("{owner}/{name}"), "branch": r.get::<String, _>("branch"), "path": r.get::<String, _>("subdir") });
        }
        return Ok(Json(out).into_response());
    };
    out["link"] = link_json(&state, &link);
    if !connected {
        return Ok(Json(out).into_response());
    }

    let gh = Gh::for_user(&state, &user).await?;
    // A repository the caller cannot see (or that is gone) is a state to show, not an error page.
    let info = match gh.get(&format!("/repos/{}", link.repo.slug())).await {
        Ok(v) => v,
        Err(e) if e.status == 404 || e.status == 403 => {
            out["remote"] = json!({ "reachable": false, "reason": AppError::from(e).to_string() });
            return Ok(Json(out).into_response());
        }
        Err(e) => return Err(e.into()),
    };
    // A repository renamed or moved to another owner still answers under its old name;
    // the link takes the new one.
    if let Some(now) = info["full_name"].as_str().and_then(|n| RepoRef::parse(n).ok()) {
        if !now.slug().eq_ignore_ascii_case(&link.repo.slug()) {
            sqlx::query("UPDATE project_github SET repo_owner = $2, repo_name = $3 WHERE project_id = $1")
                .bind(id)
                .bind(&now.owner)
                .bind(&now.name)
                .execute(&state.pool)
                .await?;
            out["renamedRepo"] = json!({ "from": link.repo.slug(), "to": now.slug() });
            link.repo = now;
        }
    }
    let v = view(&state, &gh, id, link).await?;
    out["link"] = link_json(&state, &v.link);
    let (link, remote, local, base, entries) = (&v.link, &v.remote, &v.local, &v.base, &v.entries);

    // Files that are identical right now are a common ancestor whether or not a
    // push or pull ever recorded one (a project linked to a repository that already
    // held the same files).  Remember it, or the next edit on one side would look
    // like "differs, never synced" instead of a plain change.
    let newly_agreed: Vec<Agreed> = entries
        .iter()
        .filter(|e| e.change == Change::Synced)
        .filter_map(|e| e.local.clone().map(|s| (e.path.clone(), s, local.get(&e.path).map(|f| f.doc.id))))
        .filter(|(p, s, d)| base.get(p).is_none_or(|b| b.sha != *s || (b.doc_id.is_none() && d.is_some())))
        .collect();
    if !newly_agreed.is_empty() {
        save_base(&state, id, &newly_agreed, None).await?;
    }
    // What the last sync knew and neither side has any more is forgotten.
    let stale: Vec<String> = if v.missing.is_some() {
        Vec::new()
    } else {
        let live: HashSet<&str> = entries.iter().flat_map(|e| [e.path.as_str(), e.base_path()]).collect();
        // …except the record of a document that still exists under another name: it is
        // what tells a file renamed on both sides from two unrelated files.
        let docs: HashSet<Uuid> = local.values().map(|f| f.doc.id).collect();
        base.iter()
            .filter(|(p, b)| !live.contains(p.as_str()) && !b.doc_id.is_some_and(|d| docs.contains(&d)))
            .map(|(p, _)| p.clone())
            .collect()
    };
    drop_base(&state, id, &stale).await?;

    let commits: Vec<Value> = match &remote.head {
        Some(_) => {
            let mut url = format!("/repos/{}/commits?per_page=6&sha={}", link.repo.slug(), enc(&link.branch));
            if !link.subdir.is_empty() {
                url.push_str(&format!("&path={}", enc(&link.subdir)));
            }
            gh.get(&url)
                .await
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .map(|c| {
                    json!({
                        "sha": c["sha"],
                        "message": c["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or(""),
                        "author": c["author"]["login"].as_str().or(c["commit"]["author"]["name"].as_str()),
                        "date": c["commit"]["author"]["date"],
                        "url": c["html_url"],
                    })
                })
                .collect()
        }
        None => Vec::new(),
    };

    let count = |c: Change| entries.iter().filter(|e| e.change == c).count();
    let files: Vec<Value> = entries
        .iter()
        .map(|e| {
            let l = local.get(e.local_path());
            let mut f = json!({
                "path": e.path,
                "state": e.change.as_str(),
                "detail": e.detail,
                "docId": l.map(|f| f.doc.id),
                "docType": l.map(|f| f.doc.doc_type.clone()).unwrap_or_else(|| doc_type_for(&e.path).to_string()),
                "size": l.map(|f| f.size as u64).unwrap_or(e.remote_size),
                "unsavedOps": l.map(|f| f.unsaved_ops).unwrap_or(0),
                "mergeable": crate::dockind::of(doc_type_for(&e.path)).file_mergeable(),
            });
            if e.op == Op::Delete {
                f["deleted"] = json!(if e.local.is_none() { "online" } else { "github" });
            }
            if let Some((old, side)) = &e.renamed {
                f["renamedFrom"] = json!(old);
                f["renamedOn"] = json!(if *side == Side::Online { "online" } else { "github" });
            }
            if e.path.starts_with("../") {
                f["shared"] = json!(true);
            }
            // The repository the file is in, when that is a submodule.
            if let Some((src, _)) = remote.place(&link.subdir, e.remote_path()).filter(|(s, _)| *s != 0) {
                f["submodule"] = json!(remote.sources[src].repo.slug());
            }
            f
        })
        .collect();

    out["remote"] = json!({
        "reachable": true,
        "private": info["private"].as_bool().unwrap_or(false),
        "canPush": info["permissions"]["push"].as_bool().unwrap_or(false),
        "defaultBranch": info["default_branch"],
        "branchExists": remote.head.is_some(),
        "head": remote.head,
        "commits": commits,
        "truncated": remote.truncated,
    });
    out["files"] = json!(files);
    out["summary"] = json!({
        "push": count(Change::Push), "pull": count(Change::Pull),
        "conflict": count(Change::Conflict), "synced": count(Change::Synced),
        "unsaved": local.values().filter(|f| f.unsaved_ops > 0).count(),
    });
    if !remote.notes.is_empty() {
        out["notes"] = json!(remote.notes);
    }
    if !remote.nested.is_empty() {
        out["nested"] = json!(remote.nested);
    }
    let subs: Vec<Value> = remote.sources.iter().skip(1)
        .map(|s| json!({ "path": s.mount, "repo": s.repo.slug(), "commit": s.commit, "branch": s.branch }))
        .collect();
    if !subs.is_empty() {
        out["submodules"] = json!(subs);
    }
    if let Some(m) = &v.missing {
        out["missing"] = json!({ "reason": m.reason, "message": m.message, "candidates": m.candidates });
    }
    if let Some((from, to)) = &v.moved {
        out["moved"] = json!({ "from": from, "to": to });
    }
    if let Some((from, to)) = &v.branch_moved {
        out["branchMoved"] = json!({ "from": from, "to": to });
    }
    // Other online projects linked to this very folder: allowed, but worth knowing —
    // each one's push is the other's pull.
    let rows = sqlx::query(
        "SELECT g.project_id, p.name FROM project_github g JOIN projects p ON p.id = g.project_id
         WHERE lower(g.repo_owner) = lower($1) AND lower(g.repo_name) = lower($2) AND g.branch = $3 AND g.subdir = $4
           AND g.project_id <> $5 AND p.deleted_at IS NULL ORDER BY g.created_at",
    )
    .bind(&v.link.repo.owner)
    .bind(&v.link.repo.name)
    .bind(&v.link.branch)
    .bind(&v.link.subdir)
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    let mut also = Vec::new();
    for r in rows {
        let pid: Uuid = r.get("project_id");
        if persist::effective_role(&state.pool, user.id, pid).await?.is_some() {
            also.push(json!({ "projectId": pid, "name": r.get::<String, _>("name") }));
        }
    }
    if !also.is_empty() {
        out["alsoLinked"] = json!(also);
    }
    let removed = sqlx::query(
        "SELECT r.id, r.path, r.removed_at, octet_length(r.content) AS size, u.login
         FROM project_github_removed r LEFT JOIN users u ON u.id = r.removed_by
         WHERE r.project_id = $1 ORDER BY r.removed_at DESC, r.id DESC LIMIT 60",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    if !removed.is_empty() {
        out["removed"] = removed
            .iter()
            .map(|r| {
                json!({
                    "id": r.get::<i64, _>("id"), "path": r.get::<String, _>("path"),
                    "at": r.get::<chrono::DateTime<chrono::Utc>, _>("removed_at").to_rfc3339(),
                    "size": r.get::<Option<i32>, _>("size"), "by": r.get::<Option<String>, _>("login"),
                })
            })
            .collect();
    }
    Ok(Json(out).into_response())
}

#[derive(Deserialize)]
pub struct RelocateRequest {
    pub path: String,
}

/// Point the link at the folder the project moved to.  Unlike linking afresh, what
/// the last sync recorded is kept: the files are the same files in a new place.
pub async fn relocate(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<RelocateRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let subdir = clean_subdir(&req.path)?;
    let done = sqlx::query("UPDATE project_github SET subdir = $2 WHERE project_id = $1")
        .bind(id)
        .bind(&subdir)
        .execute(&state.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::BadRequest("This project is not linked to a repository.".into()));
    }
    Ok(Json(json!({ "ok": true, "path": subdir })).into_response())
}

#[derive(Deserialize)]
pub struct RestoreFileRequest {
    pub id: i64,
}

/// Put back a file a pull removed.  It returns as a file that is new online, so the
/// next push adds it to GitHub again.
pub async fn restore_file(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<RestoreFileRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let row = sqlx::query("SELECT path, doc_type, content FROM project_github_removed WHERE id = $1 AND project_id = $2")
        .bind(req.id)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    let (path, doc_type, content): (String, String, Vec<u8>) = (row.get("path"), row.get("doc_type"), row.get("content"));
    if persist::project_documents(&state.pool, id).await?.iter().any(|d| d.path.eq_ignore_ascii_case(&path)) {
        return Err(AppError::BadRequest(format!("The project has a file at {path} again. Rename or remove it first.")));
    }
    let doc = persist::create_document(&state.pool, id, &path, &doc_type).await?;
    persist::insert_snapshot(&state.pool, doc.id, 0, &content, None, Some(user.id)).await?;
    drop_base(&state, id, std::slice::from_ref(&path)).await?;
    sqlx::query("DELETE FROM project_github_removed WHERE id = $1").bind(req.id).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true, "path": path, "docId": doc.id })).into_response())
}

// ------------------------------------------------------------------ what changed inside a file

#[derive(Deserialize)]
pub struct DiffQuery {
    pub path: String,
}

const DIFF_LIMIT: usize = 200;

fn changes_json(old: Option<&[u8]>, new: Option<&[u8]>) -> Value {
    let (Some(old), Some(new)) = (old, new) else { return Value::Null };
    if old == new {
        return json!({ "changes": [], "total": 0 });
    }
    let items = match (std::str::from_utf8(old), std::str::from_utf8(new)) {
        (Ok(o), Ok(n)) => crate::dockind::diff_text(o, n),
        _ => None,
    };
    match items {
        Some(items) => json!({ "total": items.len(), "changes": items.into_iter().take(DIFF_LIMIT).collect::<Vec<_>>() }),
        // Not an s-expression (the project file, a 3D model): only sizes can be told.
        None => json!({ "opaque": true, "oldSize": old.len(), "newSize": new.len() }),
    }
}

/// Item-level changes in one file: what the online project did since the last
/// sync and what GitHub did.  Without a common ancestor, the difference between
/// the two as they stand (GitHub -> online).
pub async fn file_diff(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<DiffQuery>,
) -> AppResult<Response> {
    access(&state, &user, id).await?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let path = remote::sync_path(&q.path).ok_or_else(|| AppError::BadRequest("bad path".into()))?;

    let v = view(&state, &gh, id, link).await?;
    // A renamed file is one file: its two sides are compared under their own names.
    let entry = v.entries.iter().find(|e| e.path == path);
    let (local_path, remote_path, base_path) = match entry {
        Some(e) => (e.local_path().to_string(), e.remote_path().to_string(), e.base_path().to_string()),
        None => (path.clone(), path.clone(), path.clone()),
    };
    let remote = &v.remote;
    let local = match v.local.get(&local_path) {
        Some(lf) => persist::latest_snapshot(&state.pool, lf.doc.id).await?.map(|(_, c)| c),
        None => None,
    };
    let theirs = match remote.files.get(&remote_path) {
        Some(f) if f.size <= MAX_FILE_BYTES => remote.blob(&gh, &remote_path).await?,
        _ => None,
    };
    if local.is_none() && theirs.is_none() {
        return Err(AppError::NotFound);
    }
    let base = match v.base.get(&base_path) {
        // GitHub has not moved: the base is the copy just downloaded.
        Some(b) if remote.sha(&remote_path) == Some(b.sha.as_str()) => theirs.clone(),
        Some(b) => {
            let repo = remote.place(&v.link.subdir, &remote_path).map(|(s, _)| remote.sources[s].repo.clone()).unwrap_or_else(|| v.link.repo.clone());
            gh.blob(&repo, &b.sha).await.ok()
        }
        None => None,
    };

    let out = match &base {
        Some(b) => json!({
            "path": path, "hasBase": true,
            "online": changes_json(Some(b), local.as_deref()),
            "github": changes_json(Some(b), theirs.as_deref()),
        }),
        None => json!({
            "path": path, "hasBase": false,
            "between": changes_json(theirs.as_deref(), local.as_deref()),
        }),
    };
    Ok(Json(out).into_response())
}

// ------------------------------------------------------------------ history (design review)

#[derive(Deserialize)]
pub struct CommitsQuery {
    /// Project-relative path of the file whose history is wanted.
    pub path: String,
    pub limit: Option<u32>,
}

/// The commits on the linked branch that changed one project file, newest first:
/// the versions the visual diff can compare with.
pub async fn file_commits(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<CommitsQuery>,
) -> AppResult<Response> {
    access(&state, &user, id).await?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let path = remote::sync_path(&q.path).ok_or_else(|| AppError::BadRequest("bad path".into()))?;
    let limit = q.limit.unwrap_or(30).clamp(1, 100);

    // The file's own repository: the linked one, or the submodule it is in (whose
    // history is followed from the commit the submodule is pinned to).
    let known: Vec<(String, String)> = load_base(&state, id).await?.into_iter().map(|(p, b)| (p, b.sha)).collect();
    let remote = remote::read(&state.pool, &gh, &link.repo, &link.branch, &link.subdir, &known).await?;
    let (src, at) = remote.place(&link.subdir, &path).ok_or(AppError::NotFound)?;
    let (repo, from) = match remote.sources.get(src) {
        Some(s) if src != 0 => (s.repo.clone(), s.commit.clone()),
        _ => (link.repo.clone(), link.branch.clone()),
    };
    let list = match gh
        .get(&format!("/repos/{}/commits?sha={}&path={}&per_page={limit}", repo.slug(), enc(&from), enc(&at)))
        .await
    {
        Ok(v) => v,
        // 404: no such branch.  409: the repository has no commits at all.
        Err(e) if e.status == 404 || e.status == 409 => Value::Array(vec![]),
        Err(e) => return Err(e.into()),
    };

    let commits: Vec<Value> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let sha = c["sha"].as_str()?;
            let message = c["commit"]["message"].as_str().unwrap_or("");
            Some(json!({
                "sha": sha,
                "message": message.lines().next().unwrap_or(""),
                "author": c["author"]["login"].as_str().or_else(|| c["commit"]["author"]["name"].as_str()),
                "date": c["commit"]["author"]["date"],
                "url": c["html_url"],
            }))
        })
        .collect();

    Ok(Json(json!({
        "path": path,
        "repo": repo.slug(),
        "branch": link.branch,
        "commits": commits,
    }))
    .into_response())
}

#[derive(Deserialize)]
pub struct FileAtQuery {
    pub path: String,
    /// The commit to read the file from.
    pub sha: String,
}

/// One project file as it was at a commit of the linked repository.
pub async fn file_at_commit(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<FileAtQuery>,
) -> AppResult<Response> {
    access(&state, &user, id).await?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let path = remote::sync_path(&q.path).ok_or_else(|| AppError::BadRequest("bad path".into()))?;
    if q.sha.len() < 7 || q.sha.len() > 64 || !q.sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("bad commit id".into()));
    }

    // The commit is one of the file's own repository (file_commits): a submodule's for a file in one.
    let known: Vec<(String, String)> = load_base(&state, id).await?.into_iter().map(|(p, b)| (p, b.sha)).collect();
    let remote = remote::read(&state.pool, &gh, &link.repo, &link.branch, &link.subdir, &known).await?;
    let (src, repo_path) = remote.place(&link.subdir, &path).ok_or(AppError::NotFound)?;
    let repo = remote.sources.get(src).map(|s| s.repo.clone()).unwrap_or_else(|| link.repo.clone());
    let tree = gh.commit_tree(&repo, &q.sha).await?;
    let (dir, name) = match repo_path.rsplit_once('/') {
        Some((d, n)) => (d, n),
        None => ("", repo_path.as_str()),
    };
    let folder = gh.subtree(&repo, &tree, dir).await?.ok_or(AppError::NotFound)?;
    let listing = gh.get(&format!("/repos/{}/git/trees/{folder}", repo.slug())).await?;
    let entry = listing["tree"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|e| e["type"] == "blob" && e["path"] == name)
        .ok_or(AppError::NotFound)?;
    if entry["size"].as_u64().unwrap_or(0) > MAX_FILE_BYTES {
        return Err(AppError::BadRequest("That file is too large to compare.".into()));
    }
    let sha = entry["sha"].as_str().ok_or(AppError::NotFound)?;
    let content = gh.blob(&repo, sha).await?;

    Ok(([(axum::http::header::CONTENT_TYPE, "application/octet-stream")], content).into_response())
}

// ------------------------------------------------------------------ push

#[derive(Deserialize, Default)]
pub struct PushRequest {
    pub message: Option<String>,
    /// Only these project paths; everything pushable when absent.
    pub paths: Option<Vec<String>>,
    /// Paths in conflict to push anyway, replacing GitHub's version.
    #[serde(default)]
    pub overwrite: Vec<String>,
    /// Commit to a new branch and open a pull request instead of committing to the linked branch.
    #[serde(default, rename = "pullRequest")]
    pub pull_request: bool,
    /// The project is gone from GitHub (its folder or branch was deleted): put it back.
    #[serde(default)]
    pub restore: bool,
}

pub async fn push(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<PushRequest>,
) -> AppResult<Response> {
    Ok(Json(push_as(&state, &user, id, req).await?).into_response())
}

#[derive(Deserialize)]
pub struct SettingsRequest {
    #[serde(rename = "autoPush")]
    pub auto_push: bool,
}

/// Turn pushing on every checkpoint on or off.
pub async fn settings(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<SettingsRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let done = sqlx::query("UPDATE project_github SET auto_push = $2 WHERE project_id = $1")
        .bind(id)
        .bind(req.auto_push)
        .execute(&state.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::BadRequest("This project is not linked to a repository.".into()));
    }
    Ok(Json(json!({ "ok": true, "autoPush": req.auto_push })).into_response())
}

/// Called when a checkpoint is saved: if the project asks for it, push what
/// changed to GitHub in the background, as the person who saved the checkpoint.
/// Files changed on both sides are left for the sync page, and so is a project
/// whose folder is gone from GitHub (it is never put back unasked).  Returns
/// whether a push was started.
pub async fn push_on_checkpoint(state: &AppState, user: &User, project_id: Uuid, checkpoint: &str) -> bool {
    match load_link(state, project_id).await {
        Ok(Some(link)) if link.auto_push => {}
        _ => return false,
    }
    let (state, user, name) = (state.clone(), user.clone(), checkpoint.trim().to_string());
    tokio::spawn(async move {
        let req = PushRequest { message: Some(format!("Checkpoint: {name}")), ..Default::default() };
        let mut report = match push_as(&state, &user, project_id, req).await {
            Ok(v) => {
                let n = v["pushed"].as_array().map_or(0, Vec::len) + v["deleted"].as_array().map_or(0, Vec::len);
                let mut message = if n == 1 { "Pushed 1 file".to_string() } else { format!("Pushed {n} files") };
                if let Some(b) = v["blocked"].as_array().filter(|b| !b.is_empty()) {
                    message.push_str(&format!("; {} held back: {}", b.len(), b[0]["reason"].as_str().unwrap_or("")));
                }
                json!({ "ok": true, "message": message, "commit": v["commit"], "commitUrl": v["commitUrl"] })
            }
            Err(AppError::Api(_, "nothing_to_push", _)) => json!({ "ok": true, "message": "Nothing had changed" }),
            Err(e) => json!({ "ok": false, "message": e.to_string() }),
        };
        report["at"] = json!(chrono::Utc::now().to_rfc3339());
        report["by"] = json!(user.login);
        report["checkpoint"] = json!(name);
        if let Err(e) = sqlx::query("UPDATE project_github SET last_auto = $2 WHERE project_id = $1")
            .bind(project_id)
            .bind(&report)
            .execute(&state.pool)
            .await
        {
            tracing::warn!("recording an automatic github push failed: {e}");
        }
    });
    true
}

/// One file of a push: written (with its content) or removed, at a path of one repository.
struct PushItem {
    doc_path: String,
    repo_path: String,
    /// Blob id and bytes to write; None removes the file.
    content: Option<(String, Vec<u8>)>,
}

/// Upload the blobs of `items` to `repo` and build a tree on top of `base_tree`.
async fn build_tree(gh: &Gh, repo: &RepoRef, base_tree: &str, items: &[&PushItem], extra: &[Value]) -> AppResult<String> {
    let mut tree_items: Vec<Value> = extra.to_vec();
    for it in items {
        match &it.content {
            Some((sha, content)) => {
                let v = gh
                    .post(
                        &format!("/repos/{}/git/blobs", repo.slug()),
                        json!({ "content": B64.encode(content), "encoding": "base64" }),
                    )
                    .await?;
                if v["sha"].as_str() != Some(sha.as_str()) {
                    return Err(anyhow::anyhow!("github stored {} under an unexpected blob id", it.doc_path).into());
                }
                tree_items.push(json!({ "path": it.repo_path, "mode": "100644", "type": "blob", "sha": sha }));
            }
            None => tree_items.push(json!({ "path": it.repo_path, "mode": "100644", "type": "blob", "sha": Value::Null })),
        }
    }
    let tree = gh
        .post(&format!("/repos/{}/git/trees", repo.slug()), json!({ "base_tree": base_tree, "tree": tree_items }))
        .await?;
    tree["sha"].as_str().map(str::to_string).ok_or_else(|| anyhow::anyhow!("github returned no tree").into())
}

async fn build_commit(gh: &Gh, repo: &RepoRef, tree: &str, parent: &str, message: &str) -> AppResult<(String, Value)> {
    let commit = gh
        .post(
            &format!("/repos/{}/git/commits", repo.slug()),
            json!({ "message": message, "tree": tree, "parents": [parent] }),
        )
        .await?;
    Ok((commit["sha"].as_str().unwrap_or("").to_string(), commit["html_url"].clone()))
}

fn remote_moved(e: GhErr) -> AppError {
    match e.status {
        422 | 409 => api_err(
            StatusCode::CONFLICT,
            "remote_moved",
            "The branch changed on GitHub while pushing. Refresh and try again.",
        ),
        _ => e.into(),
    }
}

async fn push_as(state: &AppState, user: &User, id: Uuid, req: PushRequest) -> AppResult<Value> {
    let (state, user) = (state.clone(), user.clone());
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;

    freshen(&state, id).await?;
    let mut v = view(&state, &gh, id, link).await?;
    if let Some(m) = &v.missing {
        if !req.restore {
            return Err(project_missing(m));
        }
        // Putting the project back: forget what the last sync knew, so every file is
        // simply new online.
        // (What it shares with other projects outside its folder is still there and stays known.)
        sqlx::query("DELETE FROM project_github_files WHERE project_id = $1 AND path NOT LIKE '../%'").bind(id).execute(&state.pool).await?;
        v = view(&state, &gh, id, v.link).await?;
    }
    let (link, remote, local, entries) = (&v.link, &v.remote, &v.local, &v.entries);
    let repo = &link.repo;

    let overwrite: HashSet<&str> = req.overwrite.iter().map(String::as_str).collect();
    let only: Option<HashSet<&str>> = req.paths.as_ref().map(|p| p.iter().map(String::as_str).collect());
    let targets: Vec<&Entry> = entries
        .iter()
        .filter(|e| match e.change {
            Change::Push => true,
            Change::Conflict => overwrite.contains(e.path.as_str()),
            _ => false,
        })
        .filter(|e| only.as_ref().is_none_or(|o| o.contains(e.path.as_str())))
        .collect();
    if targets.is_empty() {
        return Err(api_err(StatusCode::CONFLICT, "nothing_to_push", "There is nothing to push."));
    }

    // What goes where.  The blob id of a file to write must still be the one compared
    // above: a snapshot landing in between would otherwise be recorded as synced unseen.
    let mut blocked: Vec<Value> = Vec::new();
    let mut per_src: BTreeMap<usize, Vec<PushItem>> = BTreeMap::new();
    for e in &targets {
        let outside = |blocked: &mut Vec<Value>| {
            blocked.push(json!({ "path": e.path, "reason": format!("{} is outside the repository.", e.path) }));
        };
        match local.get(&e.path) {
            Some(lf) => {
                let Some((src, at)) = remote.place(&link.subdir, &e.path) else {
                    outside(&mut blocked);
                    continue;
                };
                if !remote.files.contains_key(&e.path) {
                    if let Some(m) = remote.unread_module(src, &at) {
                        blocked.push(json!({ "path": e.path, "reason": format!("{} would go inside the submodule {m}, which could not be read.", e.path) }));
                        continue;
                    }
                }
                let (_, content) = persist::latest_snapshot(&state.pool, lf.doc.id).await?.ok_or(AppError::NotFound)?;
                per_src.entry(src).or_default().push(PushItem { doc_path: e.path.clone(), repo_path: at, content: Some((blob_sha(&content), content)) });
                // Renamed online: the old name goes in the same commit.
                if let Some((old, Side::Online)) = &e.renamed {
                    if let Some(f) = remote.files.get(old) {
                        per_src.entry(f.src).or_default().push(PushItem { doc_path: old.clone(), repo_path: f.path.clone(), content: None });
                    }
                }
            }
            // Deleted online.
            None => {
                let Some(f) = remote.files.get(&e.path) else { continue };
                per_src.entry(f.src).or_default().push(PushItem { doc_path: e.path.clone(), repo_path: f.path.clone(), content: None });
            }
        }
    }

    // Files inside a submodule are committed to the submodule's own repository, on the
    // branch it follows, and the linked repository is moved to that commit — but only
    // where that is plainly safe; otherwise those files are held back and say why.
    let mut sub_plans: Vec<(usize, String)> = Vec::new(); // (source, branch)
    for src in per_src.keys().copied().filter(|s| *s != 0).collect::<Vec<_>>() {
        let s = &remote.sources[src];
        let slug = s.repo.slug();
        let reason: Option<String> = if req.pull_request {
            Some(format!("{} is a submodule ({slug}); its files can't go into a pull request of {}. Push normally.", s.mount, repo.slug()))
        } else if s.parent.as_ref().is_none_or(|(p, _)| *p != 0) {
            Some(format!("{} is a submodule inside another submodule. Push it from a project linked to {slug} itself.", s.mount))
        } else {
            match gh.get(&format!("/repos/{slug}")).await {
                Err(_) => Some(format!("{} is a submodule ({slug}) that your GitHub connection cannot read.", s.mount)),
                Ok(info) if !info["permissions"]["push"].as_bool().unwrap_or(false) => Some(format!(
                    "{} is a submodule ({slug}), and you can't write to that repository{}.",
                    s.mount,
                    if gh.kind == "app" { " (it may need adding to Junction's repositories)" } else { "" }
                )),
                Ok(info) => {
                    let branch = s.branch.clone().unwrap_or_else(|| info["default_branch"].as_str().unwrap_or("main").to_string());
                    match gh.branch_head(&s.repo, &branch).await? {
                        Some(head) if head == s.commit => {
                            sub_plans.push((src, branch));
                            None
                        }
                        Some(_) => Some(format!(
                            "{} is a submodule pinned to a commit that is not the tip of {slug}'s branch {branch}. \
                             Update the submodule in {} first, then pull and push.",
                            s.mount, repo.slug()
                        )),
                        None => Some(format!("{} is a submodule of {slug}, which has no branch {branch}.", s.mount)),
                    }
                }
            }
        };
        if let Some(reason) = reason {
            for it in per_src.remove(&src).unwrap_or_default() {
                blocked.push(json!({ "path": it.doc_path, "reason": reason }));
            }
        }
    }
    if per_src.is_empty() {
        let why = blocked.first().and_then(|b| b["reason"].as_str()).unwrap_or("Nothing could be pushed.").to_string();
        return Err(api_err(StatusCode::CONFLICT, "push_blocked", why));
    }

    let message = req
        .message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Update {} from Junction", a.project.name));

    if req.pull_request && remote.head.is_none() {
        return Err(AppError::BadRequest(format!(
            "A pull request needs the branch {} to exist on GitHub. Push normally first.",
            link.branch
        )));
    }

    // The submodules first: each gets a commit on its branch.  The linked repository's
    // commit then points at them.
    let mut gitlinks: Vec<Value> = Vec::new();
    let mut sub_reports: Vec<Value> = Vec::new();
    for (src, branch) in &sub_plans {
        let s = &remote.sources[*src];
        let items: Vec<&PushItem> = per_src[src].iter().collect();
        let tree = build_tree(&gh, &s.repo, &s.tree, &items, &[]).await?;
        let (sha, url) = build_commit(&gh, &s.repo, &tree, &s.commit, &message).await?;
        gh.call(
            reqwest::Method::PATCH,
            &format!("/repos/{}/git/refs/heads/{}", s.repo.slug(), enc_path(branch)),
            Some(json!({ "sha": sha, "force": false })),
        )
        .await
        .map_err(remote_moved)?;
        let at = s.parent.as_ref().map(|(_, p)| p.clone()).unwrap_or_default();
        gitlinks.push(json!({ "path": at, "mode": "160000", "type": "commit", "sha": sha }));
        sub_reports.push(json!({ "path": s.mount, "repo": s.repo.slug(), "branch": branch, "commit": sha, "commitUrl": url }));
    }

    let main_items: Vec<&PushItem> = per_src.get(&0).map(|v| v.iter().collect()).unwrap_or_default();
    let writes: Vec<&PushItem> = main_items.iter().copied().filter(|i| i.content.is_some()).collect();

    // Where the commit goes: the linked branch, created from the default branch if
    // it does not exist yet — or seeded with a first commit in an empty repository.
    let mut parent = remote.head.clone();
    let mut parent_tree = remote.tree.clone();
    let mut seeded: Option<String> = None;
    if parent.is_none() {
        let info = gh.get(&format!("/repos/{}", repo.slug())).await?;
        let default_branch = info["default_branch"].as_str().unwrap_or("main").to_string();
        match gh.branch_head(repo, &default_branch).await? {
            Some(sha) if default_branch != link.branch => {
                parent_tree = Some(gh.commit_tree(repo, &sha).await?);
                parent = Some(sha);
            }
            _ => {
                // No commits at all: git's object API refuses an empty repository,
                // the contents API does not.  It makes the first commit with one file.
                let first = writes.first().ok_or_else(|| AppError::BadRequest("There is nothing to start the repository with.".into()))?;
                let (_, content) = first.content.as_ref().expect("a write has content");
                let v = gh
                    .call(
                        reqwest::Method::PUT,
                        &format!("/repos/{}/contents/{}", repo.slug(), enc_path(&first.repo_path)),
                        Some(json!({ "message": message, "content": B64.encode(content), "branch": link.branch })),
                    )
                    .await?;
                let sha = v["commit"]["sha"].as_str().unwrap_or("").to_string();
                parent_tree = Some(gh.commit_tree(repo, &sha).await?);
                parent = Some(sha.clone());
                seeded = Some(sha);
            }
        }
    }
    let mut parent = parent.expect("parent commit resolved above");
    let mut parent_tree = parent_tree.expect("parent tree resolved above");

    let rest: Vec<&PushItem> = main_items
        .iter()
        .copied()
        .filter(|i| !(seeded.is_some() && std::ptr::eq(*i, writes[0])))
        .collect();
    let mut commit_sha = parent.clone();
    let mut commit_url = Value::Null;

    let target_branch = if req.pull_request {
        format!("kicad-collab/{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"))
    } else {
        link.branch.clone()
    };

    if !rest.is_empty() || !gitlinks.is_empty() {
        // Move the branch — never forced.  If GitHub's branch moved since it was read,
        // this fails and nothing is recorded.  With a submodule already committed the
        // push is tried once more on top of the new head, so the submodule's commit is
        // not left behind unreferenced.
        let exists = !req.pull_request && (remote.head.is_some() || seeded.is_some());
        let tries = if gitlinks.is_empty() { 1 } else { 2 };
        for attempt in 1..=tries {
            let tree = build_tree(&gh, repo, &parent_tree, &rest, &gitlinks).await?;
            let (sha, url) = build_commit(&gh, repo, &tree, &parent, &message).await?;
            let moved = if exists {
                gh.call(
                    reqwest::Method::PATCH,
                    &format!("/repos/{}/git/refs/heads/{}", repo.slug(), enc_path(&target_branch)),
                    Some(json!({ "sha": sha, "force": false })),
                )
                .await
            } else {
                gh.post(
                    &format!("/repos/{}/git/refs", repo.slug()),
                    json!({ "ref": format!("refs/heads/{target_branch}"), "sha": sha }),
                )
                .await
            };
            match moved {
                Ok(_) => {
                    commit_sha = sha;
                    commit_url = url;
                    break;
                }
                Err(e) if attempt < tries && matches!(e.status, 422 | 409) => {
                    let Some(head) = gh.branch_head(repo, &target_branch).await? else { return Err(remote_moved(e)) };
                    parent_tree = gh.commit_tree(repo, &head).await?;
                    parent = head;
                }
                Err(e) => return Err(remote_moved(e)),
            }
        }
    }

    let all: Vec<&PushItem> = per_src.values().flatten().collect();
    let pushed: Vec<&str> = all.iter().filter(|i| i.content.is_some()).map(|i| i.doc_path.as_str()).collect();
    // A rename's old name is not reported as a deletion: the file is still there.
    let renamed_from: HashSet<&str> = targets.iter().filter_map(|e| e.renamed.as_ref().map(|(o, _)| o.as_str())).collect();
    let deleted: Vec<&str> = all.iter().filter(|i| i.content.is_none() && !renamed_from.contains(i.doc_path.as_str())).map(|i| i.doc_path.as_str()).collect();

    if req.pull_request {
        // The linked branch has not moved, so nothing is recorded as synced: the
        // files show as synced by themselves once the pull request is merged.
        let pr = gh
            .post(
                &format!("/repos/{}/pulls", repo.slug()),
                json!({
                    "title": message,
                    "head": target_branch,
                    "base": link.branch,
                    "body": format!(
                        "Changes to **{}** made in Junction.\n\nFiles:\n{}",
                        a.project.name,
                        all.iter().map(|i| format!("- `{}`{}", i.repo_path, if i.content.is_none() { " (removed)" } else { "" })).collect::<Vec<_>>().join("\n")
                    ),
                }),
            )
            .await?;
        return Ok(json!({
            "ok": true, "pushed": pushed, "deleted": deleted, "blocked": blocked, "commit": commit_sha, "branch": target_branch,
            "pullRequest": { "number": pr["number"], "url": pr["html_url"] },
        }));
    }

    // Now level: what was pushed, plus everything that was already identical.
    let mut agreed: Vec<Agreed> = all
        .iter()
        .filter_map(|i| i.content.as_ref().map(|(sha, _)| (i.doc_path.clone(), sha.clone(), local.get(&i.doc_path).map(|f| f.doc.id))))
        .collect();
    agreed.extend(
        entries
            .iter()
            .filter(|e| e.change == Change::Synced)
            .filter_map(|e| e.local.clone().map(|s| (e.path.clone(), s, local.get(&e.path).map(|f| f.doc.id)))),
    );
    let gone: Vec<String> = all.iter().filter(|i| i.content.is_none()).map(|i| i.doc_path.clone()).collect();
    drop_base(&state, id, &gone).await?;
    save_base(&state, id, &agreed, Some(&commit_sha)).await?;

    Ok(json!({
        "ok": true, "pushed": pushed, "deleted": deleted, "blocked": blocked,
        "commit": commit_sha, "commitUrl": commit_url, "branch": target_branch, "submodules": sub_reports,
    }))
}

// ------------------------------------------------------------------ pull

#[derive(Deserialize, Default)]
pub struct PullRequest {
    /// Only these project paths; everything pullable when absent.
    pub paths: Option<Vec<String>>,
    /// What to do with a file changed on both sides: `merge` (default where the
    /// file type allows), `github` (take theirs) or `online` (keep ours).
    #[serde(default)]
    pub resolve: HashMap<String, String>,
    /// Which side wins an item both changed, inside a merge: `online` (default) or `github`.
    pub prefer: Option<String>,
    /// Replace documents that still have edits not saved into a snapshot.
    #[serde(default)]
    pub force: bool,
}

pub async fn pull(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<PullRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;

    freshen(&state, id).await?;
    let v = view(&state, &gh, id, link).await?;
    if let Some(m) = &v.missing {
        return Err(project_missing(m));
    }
    let (link, remote, local, base, entries) = (&v.link, &v.remote, &v.local, &v.base, &v.entries);
    let head = remote.head.clone().ok_or_else(|| {
        AppError::BadRequest(format!("{} has no branch named {} yet. Push first.", link.repo.slug(), link.branch))
    })?;
    let only: Option<HashSet<&str>> = req.paths.as_ref().map(|p| p.iter().map(String::as_str).collect());
    let prefer = if req.prefer.as_deref() == Some("github") { Prefer::Theirs } else { Prefer::Ours };

    if local.len() + entries.iter().filter(|e| e.local.is_none()).count() > MAX_FILES {
        return Err(AppError::BadRequest(format!("Pulling would exceed {MAX_FILES} files in the project.")));
    }

    let stamp = format!("Before GitHub pull {}", chrono::Utc::now().format("%Y-%m-%d %H:%M"));
    let mut updated = Vec::new();
    let mut skipped = Vec::new();
    let mut agreed: Vec<Agreed> = Vec::new();
    let mut forget: Vec<String> = Vec::new();

    for e in entries {
        if !matches!(e.change, Change::Pull | Change::Conflict) {
            continue;
        }
        if only.as_ref().is_some_and(|o| !o.contains(e.path.as_str())) {
            continue;
        }
        let lf = local.get(e.local_path());
        let mut skip = |why: &str| skipped.push(json!({ "path": e.path, "reason": why }));
        let wanted = req.resolve.get(&e.path).map(String::as_str);

        // ---- a file one side deleted
        if e.op == Op::Delete {
            match (&e.remote, lf) {
                // Deleted on GitHub: it goes online too, its content kept for putting back.
                (None, Some(lf)) => {
                    let choice = if e.change == Change::Pull { Some("github") } else { wanted };
                    match choice {
                        Some("github") => {
                            if lf.unsaved_ops > 0 && !req.force {
                                skip("has live edits that are not saved yet; save in the desktop app, or pull anyway");
                                continue;
                            }
                            keep_removed(&state, id, user.id, &lf.doc).await?;
                            persist::delete_document(&state.pool, lf.doc.id).await?;
                            forget.push(e.path.clone());
                            updated.push(json!({ "path": e.path, "action": "removed" }));
                        }
                        Some("online") => {
                            // Kept: it is a file GitHub does not have, to push.
                            forget.push(e.path.clone());
                            updated.push(json!({ "path": e.path, "action": "kept online" }));
                        }
                        _ => skip("deleted on GitHub but changed online; choose to keep it or remove it"),
                    }
                }
                // Deleted online, changed on GitHub.
                (Some(remote_sha), None) => match wanted {
                    Some("github") => {
                        if e.remote_size > MAX_FILE_BYTES {
                            skip("too large");
                            continue;
                        }
                        let content = remote.blob(&gh, &e.path).await?.ok_or(AppError::NotFound)?;
                        let doc = persist::create_document(&state.pool, id, &e.path, doc_type_for(&e.path)).await?;
                        persist::insert_snapshot(&state.pool, doc.id, 0, &content, None, Some(user.id)).await?;
                        agreed.push((e.path.clone(), remote_sha.clone(), Some(doc.id)));
                        updated.push(json!({ "path": e.path, "action": "added" }));
                    }
                    Some("online") => {
                        // GitHub's change has been seen; the file stays deleted, to push.
                        agreed.push((e.path.clone(), remote_sha.clone(), None));
                        updated.push(json!({ "path": e.path, "action": "kept deleted" }));
                    }
                    _ => skip("deleted online but changed on GitHub; choose to bring it back or delete it there"),
                },
                _ => {}
            }
            continue;
        }

        let remote_sha = e.remote.clone().expect("an edit to pull exists remotely");
        if e.remote_size > MAX_FILE_BYTES {
            skip("too large");
            continue;
        }

        let choice = match e.change {
            Change::Pull => "github",
            _ => match wanted {
                Some(c @ ("merge" | "github" | "online")) => c,
                _ if crate::dockind::of(doc_type_for(&e.path)).file_mergeable() => "merge",
                _ => {
                    skip("changed on both sides; choose which version to keep");
                    continue;
                }
            },
        };

        // Where the last sync is recorded for this file afterwards: under its new
        // name, except for a file renamed online, which GitHub still has under the old.
        let record_as = match &e.renamed {
            Some((old, Side::Online)) => old.clone(),
            _ => e.path.clone(),
        };

        // Keeping ours changes nothing online; it only records that GitHub's
        // version has been seen, so the file becomes a plain "changed online".
        if choice == "online" && !matches!(e.renamed, Some((_, Side::GitHub))) {
            agreed.push((record_as, remote_sha, lf.map(|f| f.doc.id)));
            updated.push(json!({ "path": e.path, "action": "kept online" }));
            continue;
        }

        if let Some(lf) = lf {
            if lf.unsaved_ops > 0 && !req.force {
                skip("has live edits that are not saved yet; save in the desktop app, or pull anyway");
                continue;
            }
        }

        let mut report = json!({ "path": e.path, "action": "updated" });

        // Renamed on GitHub: the document takes the new name and keeps everything else —
        // its history, its comments, the people who have it open.
        if let (Some((old, Side::GitHub)), Some(lf)) = (&e.renamed, lf) {
            if local.contains_key(&e.path) {
                skip("renamed on GitHub to a name another file here already has");
                continue;
            }
            persist::rename_document(&state.pool, lf.doc.id, &e.path).await?;
            forget.push(old.clone());
            report = json!({ "path": e.path, "action": "renamed", "from": old });
            // The project is named after its project file: it follows the rename.
            if let (Some(was), Some(now)) = (old.strip_suffix(".kicad_pro"), e.path.strip_suffix(".kicad_pro")) {
                if !was.contains('/') && !now.contains('/') && a.project.name == was {
                    persist::update_project(&state.pool, id, Some(now), None, None).await?;
                    report["project"] = json!(now);
                }
            }
            // Only the name changed on GitHub (or ours is kept): the content stays.
            let same_as_base = base.get(old).is_some_and(|b| b.sha == remote_sha);
            if same_as_base || choice == "online" || e.local.as_deref() == Some(remote_sha.as_str()) {
                agreed.push((e.path.clone(), remote_sha, Some(lf.doc.id)));
                updated.push(report);
                continue;
            }
        }

        let theirs = remote.blob(&gh, e.remote_path()).await?.ok_or(AppError::NotFound)?;
        let content = if choice == "merge" {
            let lf = lf.expect("a conflict has a local file");
            let (_, ours) = persist::latest_snapshot(&state.pool, lf.doc.id).await?.ok_or(AppError::NotFound)?;
            // The common ancestor, if GitHub still has it; without one the merge
            // is two-way (every difference is a conflict, nothing is deleted).
            let base_bytes = match (base.get(e.base_path()), remote.files.get(e.remote_path())) {
                (Some(b), Some(f)) => gh.blob(remote.repo_of(f), &b.sha).await.ok(),
                _ => None,
            };
            let merged = match (std::str::from_utf8(&ours), std::str::from_utf8(&theirs)) {
                (Ok(o), Ok(t)) => crate::dockind::merge3_text(
                    base_bytes.as_deref().and_then(|b| std::str::from_utf8(b).ok()),
                    o,
                    t,
                    prefer,
                ),
                _ => None,
            };
            let Some(m) = merged else {
                // A rename already applied stays applied; the content waits for a choice.
                if report["action"] == "renamed" {
                    if let Some(b) = base.get(e.base_path()) {
                        agreed.push((e.path.clone(), b.sha.clone(), Some(lf.doc.id)));
                    }
                    updated.push(report);
                }
                skip("could not be merged automatically; choose which version to keep");
                continue;
            };
            let from = report.get("from").cloned();
            report = json!({
                "path": e.path, "action": "merged",
                "fromGithub": m.from_theirs, "fromOnline": m.from_ours, "conflicts": m.conflicts,
            });
            if let Some(from) = from {
                report["from"] = from;
            }
            m.text.into_bytes()
        } else {
            theirs
        };

        match lf {
            Some(lf) => {
                if blob_sha(&content) != lf.sha {
                    // Keep what is being replaced as a version: restorable from History
                    // and never pruned.
                    crate::versions::keep_doc(&state.pool, id, user.id, &stamp, &lf.doc).await?;
                    crate::versions::reset_to_content(&state, user.id, lf.doc.id, &content).await?;
                }
                agreed.push((record_as, remote_sha, Some(lf.doc.id)));
            }
            None => {
                let doc = persist::create_document(&state.pool, id, &e.path, doc_type_for(&e.path)).await?;
                persist::insert_snapshot(&state.pool, doc.id, 0, &content, None, Some(user.id)).await?;
                report["action"] = json!("added");
                agreed.push((record_as, remote_sha, Some(doc.id)));
            }
        }
        // GitHub's version is now the common ancestor (a merge result that differs
        // from it shows as "changed online", ready to push).
        updated.push(report);
    }

    agreed.extend(
        entries
            .iter()
            .filter(|e| e.change == Change::Synced)
            .filter_map(|e| e.local.clone().map(|s| (e.path.clone(), s, local.get(&e.path).map(|f| f.doc.id)))),
    );
    drop_base(&state, id, &forget).await?;
    save_base(&state, id, &agreed, Some(&head)).await?;

    Ok(Json(json!({
        "ok": true, "updated": updated, "skipped": skipped, "head": head,
        "checkpoint": if updated.iter().any(|u| matches!(u["action"].as_str(), Some("updated" | "merged"))) { json!(stamp) } else { Value::Null },
    }))
    .into_response())
}

// ------------------------------------------------------------------ page

/// The GitHub page: `/github` (bring a repository online) and `/p/{id}/github`
/// (one project's sync).  One self-contained document; web/platform/github/index.ts draws it.
pub async fn page() -> Response {
    // The script is asked for with its own content hash, so a browser (or a proxy that
    // adds its own max-age) never runs an older copy against this server.
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let page = PAGE.get_or_init(|| {
        let v = format!("{:x}", Sha256::digest(include_str!("../static/dist/github.js").as_bytes()));
        include_str!("../static/github.html")
            .replace("{{THEME}}", crate::pages::THEME_CSS)
            .replace("{{MARK}}", crate::pages::MARK)
            .replace("\"/static/github.js\"", &format!("\"/static/github.js?v={}\"", &v[..16]))
    });
    ([(header::CACHE_CONTROL, "no-cache")], Html(page.clone())).into_response()
}

/// The theme's tokens only (static/theme.css up to its components marker): for a page that
/// brings its own component styles, the home page.  Pages that want the shared components
/// too use `pages::THEME_CSS`.
pub(crate) fn theme_tokens() -> &'static str {
    let css = crate::pages::THEME_CSS;
    match css.find("/* ==== components ==== */") {
        Some(end) => &css[..end],
        None => css,
    }
}

pub async fn page_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")],
        include_str!("../static/dist/github.js"),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_takes_its_colours_from_the_app() {
        let t = theme_tokens();
        assert!(t.contains("--bench:") && t.contains("--ink:") && t.contains("--copper:"), "{t}");
        assert!(t.contains("[data-theme=\"dark\"]"), "explicit dark theme block is carried over");
        assert_eq!(t.matches('{').count(), t.matches('}').count(), "balanced css");
        assert!(!t.contains(".btn {"), "tokens only, no component rules");
        for page in [include_str!("../static/github.html"), include_str!("../static/app.html"), include_str!("../static/landing.html"),
                     include_str!("../static/styleguide.html")] {
            assert!(!page.contains("--bench: #"), "no page carries a palette of its own");
        }
    }

    #[test]
    fn blob_ids_match_git() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(blob_sha(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_eq!(blob_sha(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn classification() {
        use Change::*;
        let c = |l, r, b| classify(l, r, b).map(|(c, _, _)| c);
        let op = |l, r, b| classify(l, r, b).map(|(c, o, _)| (c, o));
        assert_eq!(c(None, None, None), None);
        assert_eq!(c(Some("a"), Some("a"), None), Some(Synced));
        assert_eq!(c(Some("a"), Some("a"), Some("z")), Some(Synced));
        assert_eq!(c(Some("b"), Some("a"), Some("a")), Some(Push));
        assert_eq!(c(Some("a"), Some("b"), Some("a")), Some(Pull));
        assert_eq!(c(Some("b"), Some("c"), Some("a")), Some(Conflict));
        assert_eq!(c(Some("b"), Some("c"), None), Some(Conflict));
        assert_eq!(c(Some("a"), None, None), Some(Push));
        assert_eq!(c(None, Some("a"), None), Some(Pull));
        // A file both sides had and one no longer has was deleted there; it is never put back unasked.
        assert_eq!(op(Some("a"), None, Some("a")), Some((Pull, Op::Delete)), "deleted on GitHub");
        assert_eq!(op(Some("b"), None, Some("a")), Some((Conflict, Op::Delete)), "deleted on GitHub, changed online");
        assert_eq!(op(None, Some("a"), Some("a")), Some((Push, Op::Delete)), "deleted online");
        assert_eq!(op(None, Some("b"), Some("a")), Some((Conflict, Op::Delete)), "deleted online, changed on GitHub");
        assert_eq!(op(Some("a"), None, None), Some((Push, Op::Edit)), "new online");
    }

    #[test]
    fn repo_and_path_validation() {
        assert_eq!(RepoRef::parse("https://github.com/o/r.git").unwrap().slug(), "o/r");
        assert_eq!(RepoRef::parse(" o/r ").unwrap().slug(), "o/r");
        assert!(RepoRef::parse("o").is_err());
        assert!(RepoRef::parse("o/r/x").is_err());
        assert!(RepoRef::parse("o/..").is_err());
        assert!(RepoRef::parse("o/r?x=1").is_err());
        assert_eq!(clean_subdir("/hw/board/").unwrap(), "hw/board");
        assert_eq!(clean_subdir("").unwrap(), "");
        assert!(clean_subdir("a/../b").is_err());
        assert!(clean_branch("feature/x").is_ok());
        assert!(clean_branch("a..b").is_err());
        assert!(clean_branch("a b").is_err());
    }
}
