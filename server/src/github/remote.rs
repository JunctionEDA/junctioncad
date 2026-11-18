//! The GitHub side of a linked project, read as one set of files.
//!
//! A project is a folder of a repository, but its files are not always all in that
//! folder of that repository:
//!
//!   * a folder inside it that has a project file of its own is another project, and
//!     its files belong to that one;
//!   * a library table, a sheet or a 3D model may name a file outside the folder
//!     (`${KIPRJMOD}/../lib/parts.kicad_sym`, a library two projects share).  Those
//!     files come along, under the same `../lib/…` path the project uses for them;
//!   * any folder on the way may be a git submodule: another repository, pinned at a
//!     commit.  It is read through, and each file remembers which repository it is in.
//!
//! Nothing here writes to GitHub.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Value};
use sqlx::Row;

use super::{Gh, GhErr, RepoRef};
use crate::error::AppResult;
use crate::http::{allowed_file, is_local_state_path, MAX_FILES, MAX_FILE_BYTES};

/// Submodules inside submodules are read this deep.
const MAX_DEPTH: usize = 3;

/// One repository at one commit: the linked repository itself (index 0), or a submodule.
#[derive(Debug, Clone)]
pub(super) struct Source {
    pub repo: RepoRef,
    pub commit: String,
    pub tree: String,
    /// Where it sits, as a path from the root of the linked repository ("" for that repository).
    pub mount: String,
    /// The source that holds its gitlink, and the gitlink's path there.
    pub parent: Option<(usize, String)>,
    /// The branch `.gitmodules` says it follows.
    pub branch: Option<String>,
    pub depth: usize,
}

#[derive(Debug, Clone)]
pub(super) struct RemoteFile {
    pub sha: String,
    pub size: u64,
    /// Index into `Remote::sources`.
    pub src: usize,
    /// Path inside that source's repository.
    pub path: String,
}

#[derive(Default)]
pub(super) struct Remote {
    pub head: Option<String>,
    pub tree: Option<String>,
    /// Project path -> file.  A path outside the project folder starts with `../`.
    pub files: BTreeMap<String, RemoteFile>,
    pub truncated: bool,
    pub sources: Vec<Source>,
    /// Things the person should know: a submodule that cannot be read, a library that is not there.
    pub notes: Vec<Value>,
    /// Folders inside the project folder that are projects of their own.
    pub nested: Vec<String>,
    /// Whether the linked folder is there at all.
    pub folder_exists: bool,
    /// Folders reached through a symbolic link: (project path of the link with a
    /// trailing slash, source, the real folder in that source).
    pub links: Vec<(String, usize, String)>,
    /// Project paths that are Git LFS pointers on GitHub: left alone both ways.
    pub lfs: BTreeSet<String>,
    /// The name the branch has now (GitHub answers under a renamed branch's old name too).
    pub branch: Option<String>,
    /// Where the linked repository's `.gitmodules` says its submodules are.
    pub module_paths: Vec<String>,
}

impl Remote {
    pub fn sha(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(|f| f.sha.as_str())
    }

    /// The repository a file is in.
    pub fn repo_of(&self, f: &RemoteFile) -> &RepoRef {
        &self.sources[f.src].repo
    }

    pub async fn blob(&self, gh: &Gh, path: &str) -> Result<Option<Vec<u8>>, GhErr> {
        match self.files.get(path) {
            Some(f) => Ok(Some(gh.blob(self.repo_of(f), &f.sha).await?)),
            None => Ok(None),
        }
    }

    /// The submodule of the linked repository a repository path is inside, when that
    /// submodule was not opened: nothing may be written there as a plain file.
    pub fn unread_module(&self, src: usize, at: &str) -> Option<&str> {
        if src != 0 {
            return None;
        }
        self.module_paths.iter().map(String::as_str).find(|m| at == *m || at.starts_with(&format!("{m}/")))
    }

    /// Where a project path lives (or would be written): see `place`.
    fn place_inner(&self, doc_path: &str) -> Option<(usize, String)> {
        // Below a symbolic link to a folder, a file is written in the real folder.
        if let Some((pre, src, dir)) = self.links.iter().filter(|(pre, _, _)| doc_path.starts_with(pre.as_str())).max_by_key(|(pre, _, _)| pre.len()) {
            let rest = &doc_path[pre.len()..];
            return Some((*src, if dir.is_empty() { rest.to_string() } else { format!("{dir}/{rest}") }));
        }
        None
    }

    /// Where a project path lives (or would be written): the source and the path inside it.
    /// None for a path that climbs out of the repository.
    pub fn place(&self, subdir: &str, doc_path: &str) -> Option<(usize, String)> {
        if let Some(f) = self.files.get(doc_path) {
            return Some((f.src, f.path.clone()));
        }
        if let Some(at) = self.place_inner(doc_path) {
            return Some(at);
        }
        let full = repo_path(subdir, doc_path)?;
        // The deepest submodule the path is inside.
        let mut best = (0usize, full.clone());
        let mut best_len = 0;
        for (i, s) in self.sources.iter().enumerate().skip(1) {
            if let Some(rest) = full.strip_prefix(&format!("{}/", s.mount)) {
                if s.mount.len() >= best_len {
                    best = (i, rest.to_string());
                    best_len = s.mount.len();
                }
            }
        }
        Some(best)
    }
}

// ------------------------------------------------------------------ paths

/// `base` joined with `rel`, `.` and `..` resolved.  Climbing above `base`'s root keeps
/// leading `..` segments ("a" + "../../x" -> "../x").
pub(super) fn norm_join(base: &str, rel: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in base.split('/').chain(rel.split(['/', '\\'])) {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// The repository path of a project file; None when it climbs out of the repository.
pub(super) fn repo_path(subdir: &str, doc_path: &str) -> Option<String> {
    let p = norm_join(subdir, doc_path);
    (!p.is_empty() && !p.starts_with("..")).then_some(p)
}

/// A project path as sync uses it: an ordinary project-relative path, or one that
/// starts with `../` segments for a shared file outside the project folder.
pub(super) fn sync_path(s: &str) -> Option<String> {
    let s = s.trim().replace('\\', "/");
    let mut ups = 0;
    let mut rest = s.as_str();
    while let Some(r) = rest.strip_prefix("../") {
        ups += 1;
        rest = r;
    }
    let rest = crate::http::safe_zip_name(rest)?;
    Some(format!("{}{rest}", "../".repeat(ups)))
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_lib_table(path: &str) -> bool {
    matches!(base_name(path), "sym-lib-table" | "fp-lib-table" | "design-block-lib-table")
}

fn ext(path: &str) -> String {
    base_name(path).rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// Whether a file can name other files worth following.
fn names_files(path: &str) -> bool {
    is_lib_table(path) || matches!(ext(path).as_str(), "kicad_sch" | "kicad_pcb" | "kicad_mod" | "kicad_pro")
}

// ------------------------------------------------------------------ what a file names

/// Every `"…"` string that directly follows `(<head> ` in an s-expression text.
fn quoted_after<'a>(text: &'a str, head: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = text[from..].find(head) {
        let start = from + i + head.len();
        from = start;
        let rest = text[start..].trim_start();
        if let Some(body) = rest.strip_prefix('"') {
            if let Some(end) = body.find('"') {
                out.push(&body[..end]);
            }
        } else {
            // an unquoted atom: up to whitespace or the closing parenthesis
            // (a `$(VAR)` inside it has parentheses of its own)
            let mut depth = 0;
            let end = rest
                .find(|c: char| match c {
                    '(' => { depth += 1; false }
                    ')' if depth > 0 => { depth -= 1; false }
                    c => c == ')' || c.is_whitespace(),
                })
                .unwrap_or(rest.len());
            if end > 0 {
                out.push(&rest[..end]);
            }
        }
    }
    out
}

/// One path a file names, sorted out by where it points.
enum Named<'a> {
    /// Under the project folder (`${KIPRJMOD}/…`), or a plain relative path.
    Project(String),
    /// Absolute on the machine it was written on.
    Absolute(String),
    /// Under another path variable, a URL: not the project's.
    Elsewhere(&'a str),
}

fn classify(raw: &str) -> Named<'_> {
    let s = raw.trim();
    let s = s.strip_prefix("file://").unwrap_or(s);
    let unix = s.replace('\\', "/");
    for head in ["${KIPRJMOD}/", "$(KIPRJMOD)/"] {
        if let Some(rest) = unix.strip_prefix(head) {
            return Named::Project(rest.to_string());
        }
    }
    let drive = unix.as_bytes().get(1) == Some(&b':') && unix.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    if unix.starts_with('/') || drive {
        return Named::Absolute(unix);
    }
    if unix.is_empty() || unix.contains('$') || unix.contains("://") {
        return Named::Elsewhere(raw);
    }
    Named::Project(unix)
}

/// A string value of `key` anywhere in a JSON text (the project file).
fn json_strings(text: &str, key: &str) -> Vec<String> {
    fn walk(v: &Value, key: &str, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => {
                for (k, v) in m {
                    match v.as_str() {
                        Some(s) if k == key => out.push(s.to_string()),
                        _ => walk(v, key, out),
                    }
                }
            }
            Value::Array(a) => a.iter().for_each(|v| walk(v, key, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        walk(&v, key, &mut out);
    }
    out
}

/// The files `text` (the content of `path`) names, each tagged with how to read it:
/// `p:` a path from the project folder that should be there, `o:` one that may not be
/// (a model named by a bare relative path is looked up in KiCad's own folders first;
/// the STEP file beside a VRML model a board uses), `s:` a path from the sheet's own
/// folder, `a:` an absolute path, which may still point into the repository as it was
/// checked out on someone's machine.  Anything under another path variable is not the
/// project's.
pub(super) fn refs_of(path: &str, text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |raw: &str, relative: &str| match classify(raw) {
        Named::Project(p) if raw.contains("KIPRJMOD") => out.push(format!("p:{p}")),
        Named::Project(p) => out.push(format!("{relative}:{p}")),
        Named::Absolute(p) => out.push(format!("a:{p}")),
        Named::Elsewhere(_) => {}
    };
    if is_lib_table(path) {
        quoted_after(text, "(uri").into_iter().for_each(|s| add(s, "p"));
    } else {
        match ext(path).as_str() {
            "kicad_sch" => {
                // A sheet file is named relative to the sheet that holds it.
                quoted_after(text, "(property \"Sheetfile\"").into_iter().for_each(|s| add(s, "s"));
                // A simulation model library is looked up from the project folder.
                quoted_after(text, "(property \"Sim.Library\"").into_iter().for_each(|s| add(s, "o"));
            }
            "kicad_pcb" | "kicad_mod" => {
                let board = ext(path) == "kicad_pcb";
                for s in quoted_after(text, "(model") {
                    add(s, "o");
                    // The viewers read STEP; a board that names the VRML file of a pair
                    // wants the STEP file beside it too.
                    let (Named::Project(p) | Named::Absolute(p)) = classify(s) else { continue };
                    let lower = p.to_ascii_lowercase();
                    if board && (lower.ends_with(".wrl") || lower.ends_with(".wrz")) {
                        let stem = &p[..p.len() - 4];
                        for e in ["step", "stp"] {
                            add(&format!("{stem}.{e}"), "o");
                        }
                    }
                }
            }
            "kicad_pro" => {
                json_strings(text, "page_layout_descr_file").iter().for_each(|s| add(s, "o"));
            }
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

/// A file a project file names, as a project path.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Target {
    pub path: String,
    /// Not worth a remark when it is not in the repository.
    pub optional: bool,
    /// `path` is absolute on someone's machine, still to be found in the repository.
    pub absolute: bool,
}

/// Turn what `refs_of` returned for the file at project path `path` into targets.
pub(super) fn resolve_refs(path: &str, refs: &[String]) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    for r in refs {
        let Some((tag, rest)) = r.split_once(':') else { continue };
        let t = match tag {
            "a" => Target { path: rest.to_string(), optional: true, absolute: true },
            "s" => Target { path: norm_join(dir_of(path), rest), optional: false, absolute: false },
            "p" | "o" => Target { path: norm_join("", rest), optional: tag == "o", absolute: false },
            _ => continue,
        };
        if t.path.is_empty() {
            continue;
        }
        // named both ways: the stricter reading stands
        if let Some(have) = out.iter_mut().find(|o| o.path == t.path && o.absolute == t.absolute) {
            have.optional &= t.optional;
        } else {
            out.push(t);
        }
    }
    out
}

/// Where an absolute path from someone's machine is in the repository, when it reads
/// as a path inside a checkout of it: what follows the folder named like the
/// repository, or failing that what starts at the top folder of the project's own path.
fn absolute_in_repo(abs: &str, repo: &RepoRef, subdir: &str) -> Vec<String> {
    let segs: Vec<&str> = abs.split('/').filter(|s| !s.is_empty()).collect();
    let mut out = Vec::new();
    if let Some(i) = segs.iter().rposition(|s| s.eq_ignore_ascii_case(&repo.name)) {
        if i + 1 < segs.len() {
            out.push(segs[i + 1..].join("/"));
        }
    }
    if let Some(top) = subdir.split('/').find(|s| !s.is_empty()) {
        if let Some(i) = segs.iter().rposition(|s| *s == top) {
            let cand = segs[i..].join("/");
            if i + 1 < segs.len() && !out.contains(&cand) {
                out.push(cand);
            }
        }
    }
    out
}

/// The project path (possibly `../…`) of a repository path, seen from the project folder.
fn project_path(subdir: &str, repo_path: &str) -> String {
    let from: Vec<&str> = subdir.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = repo_path.split('/').filter(|s| !s.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend(&to[common..]);
    out.join("/")
}

// ------------------------------------------------------------------ .gitmodules

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Module {
    pub url: String,
    pub branch: Option<String>,
}

/// `.gitmodules`: submodule path -> where it comes from.
pub(super) fn parse_gitmodules(text: &str) -> HashMap<String, Module> {
    let mut out = HashMap::new();
    let (mut path, mut url, mut branch) = (None::<String>, None::<String>, None::<String>);
    let mut flush = |path: &mut Option<String>, url: &mut Option<String>, branch: &mut Option<String>| {
        if let (Some(p), Some(u)) = (path.take(), url.take()) {
            out.insert(p.trim_matches('/').to_string(), Module { url: u, branch: branch.take().filter(|b| b != ".") });
        }
        *branch = None;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            flush(&mut path, &mut url, &mut branch);
            continue;
        }
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches('"').to_string();
        match k.trim().to_ascii_lowercase().as_str() {
            "path" => path = Some(v),
            "url" => url = Some(v),
            "branch" => branch = Some(v),
            _ => {}
        }
    }
    flush(&mut path, &mut url, &mut branch);
    out
}

/// The GitHub repository a submodule URL names; None for another host.  A relative
/// URL (`../lib.git`) is relative to the repository that holds the submodule.
pub(super) fn submodule_repo(url: &str, parent: &RepoRef, web_host: &str) -> Option<RepoRef> {
    let url = url.trim();
    let path: String = if url.starts_with("./") || url.starts_with("../") {
        let joined = norm_join(&format!("{}/{}", parent.owner, parent.name), url);
        if joined.starts_with("..") {
            return None;
        }
        joined
    } else if let Some(rest) = url.strip_prefix("git@") {
        // git@github.com:owner/name.git
        let (host, path) = rest.split_once(':')?;
        if !is_github(host, web_host) {
            return None;
        }
        path.to_string()
    } else {
        let rest = url.split_once("://").map(|(_, r)| r)?;
        let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        if !is_github(host, web_host) {
            return None;
        }
        path.to_string()
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    RepoRef::parse(&format!("{owner}/{name}")).ok()
}

fn is_github(host: &str, web_host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "github.com" || h == "www.github.com" || h == web_host.to_ascii_lowercase()
}

// ------------------------------------------------------------------ walking repositories

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Blob,
    Tree,
    /// A gitlink: a submodule pinned at a commit.
    Commit,
    /// A symbolic link: a blob holding the path it points at.
    Link,
}

#[derive(Debug, Clone)]
struct TreeEntry {
    path: String,
    kind: Kind,
    sha: String,
    size: u64,
}

pub(super) enum Loc {
    Missing,
    File(RemoteFile),
    Dir { src: usize, tree: String, path: String },
}

pub(super) struct Walker<'a> {
    gh: &'a Gh,
    pub sources: Vec<Source>,
    pub notes: Vec<Value>,
    pub truncated: bool,
    listings: HashMap<(String, String, bool), (Vec<TreeEntry>, bool)>,
    modules: HashMap<usize, HashMap<String, Module>>,
    mounts: HashMap<(usize, String), Option<usize>>,
    pub links: Vec<(String, usize, String)>,
    /// The real folders being listed right now, so a link back into one is not followed.
    listing: Vec<(usize, String)>,
}

/// How many symbolic links one path may go through.
const MAX_LINK_HOPS: usize = 8;

type Fut<'f, T> = Pin<Box<dyn Future<Output = Result<T, GhErr>> + Send + 'f>>;

impl<'a> Walker<'a> {
    pub fn new(gh: &'a Gh, repo: &RepoRef, commit: &str, tree: &str) -> Self {
        Walker {
            gh,
            sources: vec![Source {
                repo: repo.clone(),
                commit: commit.to_string(),
                tree: tree.to_string(),
                mount: String::new(),
                parent: None,
                branch: None,
                depth: 0,
            }],
            notes: Vec::new(),
            truncated: false,
            listings: HashMap::new(),
            modules: HashMap::new(),
            mounts: HashMap::new(),
            links: Vec::new(),
            listing: Vec::new(),
        }
    }

    fn note(&mut self, kind: &str, path: &str, repo: Option<&RepoRef>, message: String) {
        if self.notes.iter().any(|n| n["kind"] == kind && n["path"] == path) {
            return;
        }
        self.notes.push(json!({ "kind": kind, "path": path, "repo": repo.map(RepoRef::slug), "message": message }));
    }

    /// Drop what was noted since there were `n` notes (a look that was only a try),
    /// except that a submodule could not be opened: that is said once and matters still.
    pub fn forget_notes(&mut self, n: usize) {
        let mut i = 0;
        self.notes.retain(|note| {
            i += 1;
            i <= n || note["kind"].as_str().is_some_and(|k| k.starts_with("submodule"))
        });
    }

    /// The entries of a tree: its direct children, or everything below it.
    async fn entries(&mut self, src: usize, tree: &str, recursive: bool) -> Result<Vec<TreeEntry>, GhErr> {
        let repo = self.sources[src].repo.clone();
        let key = (repo.slug(), tree.to_string(), recursive);
        if let Some((e, t)) = self.listings.get(&key) {
            self.truncated |= *t;
            return Ok(e.clone());
        }
        let v = self
            .gh
            .get(&format!("/repos/{}/git/trees/{tree}{}", repo.slug(), if recursive { "?recursive=1" } else { "" }))
            .await?;
        let mut out = Vec::new();
        for e in v["tree"].as_array().into_iter().flatten() {
            let kind = match e["type"].as_str() {
                Some("blob") if e["mode"].as_str() == Some("120000") => Kind::Link,
                Some("blob") => Kind::Blob,
                Some("tree") => Kind::Tree,
                Some("commit") => Kind::Commit,
                _ => continue,
            };
            if let (Some(p), Some(s)) = (e["path"].as_str(), e["sha"].as_str()) {
                out.push(TreeEntry { path: p.to_string(), kind, sha: s.to_string(), size: e["size"].as_u64().unwrap_or(0) });
            }
        }
        let truncated = v["truncated"].as_bool().unwrap_or(false);
        self.truncated |= truncated;
        self.listings.insert(key, (out.clone(), truncated));
        Ok(out)
    }

    async fn modules_of(&mut self, src: usize) -> Result<HashMap<String, Module>, GhErr> {
        if let Some(m) = self.modules.get(&src) {
            return Ok(m.clone());
        }
        let root = self.sources[src].tree.clone();
        let top = self.entries(src, &root, false).await?;
        let parsed = match top.iter().find(|e| e.kind == Kind::Blob && e.path == ".gitmodules") {
            Some(e) => {
                let bytes = self.gh.blob(&self.sources[src].repo, &e.sha).await?;
                parse_gitmodules(&String::from_utf8_lossy(&bytes))
            }
            None => HashMap::new(),
        };
        self.modules.insert(src, parsed.clone());
        Ok(parsed)
    }

    /// Open the submodule whose gitlink is at `path` of `parent`.  None (with a note) when
    /// it cannot be read: not on GitHub, not visible to this connection, nested too deep.
    async fn mount(&mut self, parent: usize, path: &str, commit: &str) -> Result<Option<usize>, GhErr> {
        let key = (parent, path.to_string());
        if let Some(m) = self.mounts.get(&key) {
            return Ok(*m);
        }
        let full = norm_join(&self.sources[parent].mount, path);
        let depth = self.sources[parent].depth + 1;
        let modules = self.modules_of(parent).await?;
        let parent_repo = self.sources[parent].repo.clone();
        let found = match modules.get(path) {
            None => {
                self.note("submodule_unknown", &full, None, format!(
                    "{full} is a submodule, but the repository's .gitmodules file does not say where it comes from."));
                None
            }
            Some(_) if depth > MAX_DEPTH => {
                self.note("submodule_deep", &full, None, format!("{full} is a submodule nested too deep to read."));
                None
            }
            Some(m) => match submodule_repo(&m.url, &parent_repo, &self.gh.web_host) {
                None => {
                    self.note("submodule_not_github", &full, None, format!(
                        "{full} is a submodule kept at {}, which is not on GitHub, so its files can't be read.", m.url));
                    None
                }
                Some(repo) => match self.gh.commit_tree(&repo, commit).await {
                    Ok(tree) => {
                        self.sources.push(Source {
                            repo,
                            commit: commit.to_string(),
                            tree,
                            mount: full,
                            parent: Some((parent, path.to_string())),
                            branch: m.branch.clone(),
                            depth,
                        });
                        Some(self.sources.len() - 1)
                    }
                    Err(e) if matches!(e.status, 403 | 404 | 409 | 422) => {
                        // Tell "cannot see the repository" from "the pinned commit is not in it".
                        let visible = self.gh.get(&format!("/repos/{}", repo.slug())).await.is_ok();
                        let message = if visible {
                            format!("{full} is a submodule pinned to a commit that {} does not have (was it pushed?).", repo.slug())
                        } else if self.gh.kind == "app" {
                            format!("{full} is a submodule ({}). Junction sees only the repositories you chose: add {} to them to read it.",
                                repo.slug(), repo.slug())
                        } else {
                            format!("{full} is a submodule ({}) that your GitHub connection cannot read.", repo.slug())
                        };
                        self.note(if visible { "submodule_commit_missing" } else { "submodule_no_access" }, &full, Some(&repo), message);
                        None
                    }
                    Err(e) => return Err(e),
                },
            },
        };
        self.mounts.insert(key, found);
        Ok(found)
    }

    /// What is at `path` of a source, going through submodules and symbolic links on the way.
    pub fn locate<'f>(&'f mut self, src: usize, path: &'f str) -> Fut<'f, Loc> {
        self.locate_from(src, path.to_string(), 0)
    }

    fn locate_from<'f>(&'f mut self, src: usize, path: String, hops: usize) -> Fut<'f, Loc> {
        Box::pin(async move {
            let (mut cur_src, mut cur_tree) = (src, self.sources[src].tree.clone());
            let mut inside: Vec<&str> = Vec::new(); // path within cur_src
            let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            for (i, seg) in segs.iter().enumerate() {
                let last = i + 1 == segs.len();
                let children = self.entries(cur_src, &cur_tree, false).await?;
                let Some(e) = children.iter().find(|e| e.path == *seg) else { return Ok(Loc::Missing) };
                inside.push(seg);
                match e.kind {
                    Kind::Tree => cur_tree = e.sha.clone(),
                    Kind::Blob => {
                        return Ok(if last {
                            Loc::File(RemoteFile { sha: e.sha.clone(), size: e.size, src: cur_src, path: inside.join("/") })
                        } else {
                            Loc::Missing
                        });
                    }
                    Kind::Link => {
                        let at = inside.join("/");
                        let Some(target) = self.link_target(cur_src, &at, &e.sha, e.size, hops).await? else { return Ok(Loc::Missing) };
                        let rest = segs[i + 1..].join("/");
                        let next = if rest.is_empty() { target } else { format!("{target}/{rest}") };
                        return self.locate_from(cur_src, next, hops + 1).await;
                    }
                    Kind::Commit => {
                        let at = inside.join("/");
                        match self.mount(cur_src, &at, &e.sha).await? {
                            Some(s) => {
                                cur_src = s;
                                cur_tree = self.sources[s].tree.clone();
                                inside.clear();
                            }
                            None => return Ok(Loc::Missing),
                        }
                    }
                }
            }
            Ok(Loc::Dir { src: cur_src, tree: cur_tree, path: inside.join("/") })
        })
    }

    /// Where the symbolic link at `at` of a source points, as a path of that source.
    /// None (with a note) when it leads out of the repository or cannot be followed.
    async fn link_target(&mut self, src: usize, at: &str, sha: &str, size: u64, hops: usize) -> Result<Option<String>, GhErr> {
        let full = norm_join(&self.sources[src].mount, at);
        if hops >= MAX_LINK_HOPS {
            self.note("symlink_loop", &full, None, format!("{full} is a symbolic link that leads back to itself, so it was left out."));
            return Ok(None);
        }
        if size > 4096 {
            return Ok(None);
        }
        let repo = self.sources[src].repo.clone();
        let raw = String::from_utf8_lossy(&self.gh.blob(&repo, sha).await?).trim().to_string();
        let absolute = raw.starts_with('/') || raw.starts_with('\\') || raw.as_bytes().get(1) == Some(&b':');
        let target = norm_join(dir_of(at), &raw);
        if absolute || target.starts_with("..") {
            self.note("symlink_outside", &full, None, format!(
                "{full} is a symbolic link to {raw}, which is outside the repository, so it was left out."));
            return Ok(None);
        }
        Ok(Some(target))
    }

    /// Every file below a folder, submodules and symbolic links followed, as (path
    /// relative to the folder, file).  A file reached through a link keeps the path it
    /// has in the project and is read and written where it really is.
    pub fn list<'f>(&'f mut self, src: usize, tree: &'f str, dir: &'f str, prefix: &'f str, out: &'f mut Vec<(String, RemoteFile)>) -> Fut<'f, ()> {
        Box::pin(async move {
            self.listing.push((src, dir.to_string()));
            let all = self.entries(src, tree, true).await?;
            for e in all {
                let inside = if dir.is_empty() { e.path.clone() } else { format!("{dir}/{}", e.path) };
                match e.kind {
                    Kind::Tree => {}
                    Kind::Blob => out.push((format!("{prefix}{}", e.path), RemoteFile { sha: e.sha, size: e.size, src, path: inside })),
                    Kind::Link => {
                        let full = norm_join(&self.sources[src].mount, &inside);
                        match self.locate_from(src, inside.clone(), 0).await? {
                            Loc::File(f) => out.push((format!("{prefix}{}", e.path), f)),
                            Loc::Dir { src: s, tree: t, path } => {
                                // A link to a folder being listed (itself, or one it is inside) would never end.
                                let around = self.listing.iter().any(|(ls, ld)| {
                                    *ls == s && (path.is_empty() || *ld == path || ld.starts_with(&format!("{path}/")))
                                });
                                if around {
                                    self.note("symlink_loop", &full, None, format!(
                                        "{full} is a symbolic link to a folder it is inside, so it was left out."));
                                    continue;
                                }
                                let sub_prefix = format!("{prefix}{}/", e.path);
                                self.links.push((sub_prefix.clone(), s, path.clone()));
                                self.list(s, &t, &path, &sub_prefix, out).await?;
                            }
                            Loc::Missing => {
                                if !self.notes.iter().any(|n| n["path"] == full.as_str()) {
                                    self.note("symlink_broken", &full, None, format!(
                                        "{full} is a symbolic link to something that is not in the repository, so it was left out."));
                                }
                            }
                        }
                    }
                    Kind::Commit => {
                        if let Some(s) = self.mount(src, &inside, &e.sha).await? {
                            let sub_tree = self.sources[s].tree.clone();
                            let sub_prefix = format!("{prefix}{}/", e.path);
                            self.list(s, &sub_tree, "", &sub_prefix, out).await?;
                        }
                    }
                }
            }
            self.listing.pop();
            Ok(())
        })
    }
}

fn usable(rel: &str) -> bool {
    allowed_file(rel) && !is_local_state_path(rel) && sync_path(rel).is_some()
}

/// Folders (relative, never "") that directly hold a project file.
fn project_dirs<'p>(paths: impl Iterator<Item = &'p String>) -> BTreeSet<String> {
    paths
        .filter(|p| p.ends_with(".kicad_pro"))
        .map(|p| dir_of(p).to_string())
        .filter(|d| !d.is_empty())
        .collect()
}

fn under<'d>(dirs: &'d BTreeSet<String>, path: &str) -> Option<&'d String> {
    dirs.iter().find(|d| path.starts_with(&format!("{d}/")))
}

// ------------------------------------------------------------------ reading a project

/// What a blob names, remembered by blob id.
async fn blob_refs(pool: &sqlx::PgPool, gh: &Gh, repo: &RepoRef, doc_path: &str, f: &RemoteFile) -> AppResult<Vec<String>> {
    // keyed with the reader's version, so what an older reader remembered is not reused
    let key = format!("{}:2", f.sha);
    if let Some(row) = sqlx::query("SELECT refs FROM github_blob_refs WHERE blob_sha = $1").bind(&key).fetch_optional(pool).await? {
        let v: Value = row.get("refs");
        return Ok(v.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect());
    }
    if f.size > MAX_FILE_BYTES {
        return Ok(Vec::new());
    }
    let bytes = gh.blob(repo, &f.sha).await?;
    let refs = refs_of(doc_path, &String::from_utf8_lossy(&bytes));
    sqlx::query("INSERT INTO github_blob_refs (blob_sha, refs) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(&key)
        .bind(json!(refs))
        .execute(pool)
        .await?;
    Ok(refs)
}

/// The project's files on GitHub: the linked folder of the branch head (less the
/// projects nested in it), plus what those files name outside it.  `known` are the
/// outside files the project already has: one that is still in the repository stays
/// part of the project even when nothing names it any more (a library table row
/// removed is not the library deleted).
pub(super) async fn read(pool: &sqlx::PgPool, gh: &Gh, repo: &RepoRef, branch: &str, subdir: &str, known: &[(String, String)]) -> AppResult<Remote> {
    let Some((head, now)) = gh.branch_ref(repo, branch).await? else {
        return Ok(Remote::default());
    };
    let tree = gh.commit_tree(repo, &head).await?;
    let mut w = Walker::new(gh, repo, &head, &tree);
    let mut remote = Remote { head: Some(head), tree: Some(tree), branch: Some(now), ..Default::default() };

    let folder = w.locate(0, subdir).await?;
    let Loc::Dir { src, tree: folder_tree, path: folder_path } = folder else {
        remote.sources = w.sources;
        remote.notes = w.notes;
        return Ok(remote);
    };
    remote.folder_exists = true;
    let mut listed = Vec::new();
    w.list(src, &folder_tree, &folder_path, "", &mut listed).await?;
    let mut files: BTreeMap<String, RemoteFile> = listed.into_iter().filter(|(rel, _)| usable(rel)).collect();

    // A folder below with a project file of its own is another project — when this
    // folder is a project itself.  (A link to a folder that merely contains projects
    // keeps everything, as it always did.)
    let own_project = files.keys().any(|p| p.ends_with(".kicad_pro") && !p.contains('/'));
    let nested = if own_project { project_dirs(files.keys()) } else { BTreeSet::new() };
    let mut set_aside: BTreeMap<String, RemoteFile> = BTreeMap::new();
    if !nested.is_empty() {
        let (keep, aside): (BTreeMap<_, _>, BTreeMap<_, _>) = files
            .into_iter()
            // what the project already has stays with it when a project file appears beside it later
            .partition(|(p, _)| under(&nested, p).is_none() || (!p.ends_with(".kicad_pro") && known.iter().any(|(k, _)| k == p)));
        files = keep;
        set_aside = aside;
    }
    // Only the outermost of nested projects is named.
    remote.nested = nested.iter().filter(|d| !nested.iter().any(|o| o != *d && d.starts_with(&format!("{o}/")))).cloned().collect();

    // Follow what the files name outside the project: a shared library, a sheet kept
    // in another folder, a model.  What they bring in may name more.
    let mut scanned: BTreeSet<String> = BTreeSet::new();
    let mut tried: BTreeSet<String> = BTreeSet::new();
    let mut missing: Vec<(String, String)> = Vec::new();
    loop {
        let todo: Vec<String> = files.keys().filter(|p| names_files(p) && !scanned.contains(*p)).cloned().collect();
        if todo.is_empty() {
            break;
        }
        // Read what is not remembered yet a few at a time.
        let mut named: Vec<Target> = Vec::new();
        for group in todo.chunks(6) {
            let jobs = group.iter().map(|p| {
                let f = &files[p];
                blob_refs(pool, gh, &w.sources[f.src].repo, p, f)
            });
            for (p, refs) in group.iter().zip(futures_util::future::try_join_all(jobs).await?) {
                named.extend(resolve_refs(p, &refs));
            }
        }
        scanned.extend(todo);
        // An absolute path that reads as a path inside a checkout of this repository
        // (a model picked through a file dialog) is the file at that place.
        let mut wanted: Vec<Target> = Vec::new();
        for t in named {
            if !t.absolute {
                wanted.push(t);
                continue;
            }
            for at in absolute_in_repo(&t.path, repo, subdir) {
                let notes = w.notes.len();
                let hit = matches!(w.locate(0, &at).await?, Loc::File(_));
                w.forget_notes(notes);
                if hit {
                    wanted.push(Target { path: project_path(subdir, &at), optional: true, absolute: false });
                    break;
                }
            }
        }
        wanted.sort_by(|a, b| a.path.cmp(&b.path).then(a.optional.cmp(&b.optional)));
        wanted.dedup_by(|b, a| a.path == b.path);
        for Target { path: target, optional, .. } in wanted {
            let outside = target.starts_with("../");
            if !(outside || under(&nested, &target).is_some()) || files.contains_key(&target) || !tried.insert(target.clone()) {
                continue;
            }
            if files.keys().any(|p| p.starts_with(&format!("{target}/"))) {
                continue;
            }
            // Something the project folder holds but another project owns.
            if !outside {
                let prefix = format!("{target}/");
                let hits: Vec<String> = set_aside.keys().filter(|p| **p == target || p.starts_with(&prefix)).cloned().collect();
                for p in hits {
                    if let Some(f) = set_aside.remove(&p) {
                        files.insert(p, f);
                    }
                }
                continue;
            }
            let Some(at) = repo_path(subdir, &target) else {
                if optional {
                    continue;
                }
                w.note("outside_repo", &target, None, format!(
                    "{target} is outside the repository, so it can't come along. Libraries a project shares need to be in the repository."));
                continue;
            };
            let notes_before = w.notes.len();
            match w.locate(0, &at).await? {
                Loc::File(f) => {
                    if usable(&target) {
                        files.insert(target, f);
                    }
                }
                Loc::Dir { src, tree, path } => {
                    let mut found = Vec::new();
                    let prefix = format!("{target}/");
                    // Reached through a symbolic link (or a submodule): new files go to the real folder.
                    if (src, path.as_str()) != (0, at.as_str()) && !w.links.iter().any(|(p, _, _)| *p == prefix) {
                        w.links.push((prefix.clone(), src, path.clone()));
                    }
                    w.list(src, &tree, &path, &prefix, &mut found).await?;
                    files.extend(found.into_iter().filter(|(rel, _)| usable(rel)));
                }
                Loc::Missing => {
                    // A submodule that could not be opened has said so already.
                    if optional {
                        w.forget_notes(notes_before);
                    } else if w.notes.len() == notes_before && !w.notes.iter().any(|n| {
                        n["kind"].as_str().is_some_and(|k| k.starts_with("submodule"))
                            && n["path"].as_str().is_some_and(|m| at == m || at.starts_with(&format!("{m}/")))
                    }) {
                        missing.push((target, at));
                    }
                }
            }
            if files.len() > MAX_FILES * 4 {
                break;
            }
        }
    }

    // What is named but not there, said once per folder rather than once per file.
    let mut by_dir: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for (target, at) in missing {
        by_dir.entry(dir_of(&target).to_string()).or_default().push((target, at));
    }
    for (dir, gone) in by_dir {
        let (target, at) = &gone[0];
        if gone.len() == 1 {
            w.note("missing_ref", target, None, format!("The project names {target} ({at} in the repository), which is not there."));
        } else {
            let at_dir = dir_of(at);
            let mut n = json!({
                "kind": "missing_ref", "path": dir, "count": gone.len(),
                "message": format!("The project names {} files in {dir} ({at_dir} in the repository) that are not there, {} among them.", gone.len(), base_name(target)),
            });
            n["paths"] = json!(gone.iter().map(|(t, _)| t).collect::<Vec<_>>());
            w.notes.push(n);
        }
    }

    for (path, sha) in known {
        if !path.starts_with("../") || files.contains_key(path) || !usable(path) {
            continue;
        }
        let Some(at) = repo_path(subdir, path) else { continue };
        let notes = w.notes.len();
        match w.locate(0, &at).await? {
            Loc::File(f) => {
                files.insert(path.clone(), f);
            }
            // Gone from where it was.  The very same file under another name in the same
            // folder is that file renamed with git (the table that names it not updated
            // yet): it comes along, so it shows as a rename instead of vanishing.
            _ if sha.is_empty() => {}
            _ => {
                if let Loc::Dir { src, tree, path: dir } = w.locate(0, dir_of(&at)).await? {
                    let same: Vec<TreeEntry> = w.entries(src, &tree, false).await?.into_iter().filter(|e| e.kind == Kind::Blob && e.sha == *sha).collect();
                    if let [e] = same.as_slice() {
                        let doc_dir = dir_of(path);
                        let new_path = if doc_dir.is_empty() { e.path.clone() } else { format!("{doc_dir}/{}", e.path) };
                        if usable(&new_path) && !files.contains_key(&new_path) {
                            let inside = if dir.is_empty() { e.path.clone() } else { format!("{dir}/{}", e.path) };
                            files.insert(new_path, RemoteFile { sha: e.sha.clone(), size: e.size, src, path: inside });
                        }
                    }
                }
            }
        }
        w.forget_notes(notes);
    }

    // Files kept with Git LFS are small pointers in the repository; the real content
    // lives elsewhere.  They stay as they are on GitHub and do not come online.
    let maybe: Vec<String> = files.iter().filter(|(_, f)| (100..=200).contains(&f.size)).map(|(p, _)| p.clone()).collect();
    for group in maybe.chunks(6) {
        let jobs = group.iter().map(|p| is_lfs_pointer(pool, gh, &w.sources[files[p].src].repo, &files[p]));
        for (p, lfs) in group.iter().zip(futures_util::future::try_join_all(jobs).await?) {
            if lfs {
                files.remove(p);
                remote.lfs.insert(p.clone());
            }
        }
    }
    if let Some(first) = remote.lfs.iter().next() {
        let n = remote.lfs.len();
        let message = if n == 1 {
            format!("{first} is stored with Git LFS. It stays as it is on GitHub and is not brought online.")
        } else {
            format!("{n} files are stored with Git LFS ({} among them). They stay as they are on GitHub and are not brought online.", base_name(first))
        };
        w.notes.push(json!({ "kind": "lfs", "path": first, "count": n, "message": message, "paths": remote.lfs.iter().collect::<Vec<_>>() }));
    }

    remote.module_paths = w.modules_of(0).await?.into_keys().collect();
    remote.files = files;
    remote.truncated = w.truncated;
    remote.sources = w.sources;
    remote.notes = w.notes;
    remote.links = w.links;
    Ok(remote)
}

/// Whether a small blob is a Git LFS pointer, remembered by blob id.
async fn is_lfs_pointer(pool: &sqlx::PgPool, gh: &Gh, repo: &RepoRef, f: &RemoteFile) -> AppResult<bool> {
    let key = format!("{}:lfs", f.sha);
    if let Some(row) = sqlx::query("SELECT refs FROM github_blob_refs WHERE blob_sha = $1").bind(&key).fetch_optional(pool).await? {
        let v: Value = row.get("refs");
        return Ok(v.as_array().is_some_and(|a| !a.is_empty()));
    }
    let bytes = gh.blob(repo, &f.sha).await?;
    let lfs = lfs_pointer(&bytes);
    sqlx::query("INSERT INTO github_blob_refs (blob_sha, refs) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(&key)
        .bind(if lfs { json!(["lfs"]) } else { json!([]) })
        .execute(pool)
        .await?;
    Ok(lfs)
}

pub(super) fn lfs_pointer(bytes: &[u8]) -> bool {
    bytes.len() <= 400
        && bytes.starts_with(b"version https://git-lfs.github.com/spec/")
        && std::str::from_utf8(bytes).is_ok_and(|t| t.lines().any(|l| l.starts_with("oid sha256:")))
}

// ------------------------------------------------------------------ scanning a repository

pub(super) struct Found {
    pub path: String,
    pub name: String,
    /// Every project file in the folder (KiCad allows several; they travel as one online project).
    pub project_files: Vec<String>,
    pub files: usize,
    /// The project folder this one is inside, if any.
    pub inside: Option<String>,
    /// The submodule repository the folder is in.
    pub submodule: Option<String>,
    /// Libraries the project's tables name outside its folder: (path as written, repository path, there?).
    pub shared: Vec<(String, Option<String>, bool)>,
}

/// Every folder of a branch that holds a KiCad project, submodules included.
pub(super) async fn scan(gh: &Gh, repo: &RepoRef, branch: &str) -> AppResult<(Remote, Vec<Found>)> {
    let Some(head) = gh.branch_head(repo, branch).await? else {
        return Ok((Remote::default(), Vec::new()));
    };
    let tree = gh.commit_tree(repo, &head).await?;
    let mut w = Walker::new(gh, repo, &head, &tree);
    let mut listed = Vec::new();
    w.list(0, &tree, "", "", &mut listed).await?;
    let all: BTreeMap<String, RemoteFile> = listed.into_iter().filter(|(rel, _)| usable(rel)).collect();

    // folder -> its project files
    let mut folders: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for p in all.keys() {
        if let Some(stem) = base_name(p).strip_suffix(".kicad_pro") {
            folders.entry(dir_of(p).to_string()).or_default().push(stem.to_string());
        }
    }
    // KiCad files but no project file anywhere: offer the root as it is.
    if folders.is_empty() && !all.is_empty() {
        folders.insert(String::new(), vec![repo.name.clone()]);
    }
    let dirs: Vec<String> = folders.keys().cloned().collect();
    let prefix = |d: &str| if d.is_empty() { String::new() } else { format!("{d}/") };
    let mut found = Vec::new();
    for (dir, stems) in &folders {
        let pre = prefix(dir);
        // projects nested in this one take their files with them
        let inner: Vec<String> = dirs.iter().filter(|d| *d != dir && d.starts_with(&pre) && (!dir.is_empty() || !d.is_empty())).map(|d| prefix(d)).collect();
        let own = |p: &str| p.starts_with(&pre) && !inner.iter().any(|i| p.starts_with(i.as_str()));
        let files = all.keys().filter(|p| own(p)).count();
        let folder_name = base_name(dir);
        let name = stems.iter().find(|s| s.as_str() == folder_name).or(stems.first()).cloned().unwrap_or_default();
        let inside = dirs
            .iter()
            .filter(|d| *d != dir && dir.starts_with(&prefix(d)) && !(d.is_empty() && !folders.contains_key("")))
            .max_by_key(|d| d.len())
            .cloned();
        let submodule = all
            .iter()
            .find(|(p, f)| f.src != 0 && p.starts_with(&pre) && dir_of(p) == dir)
            .map(|(_, f)| w.sources[f.src].repo.slug());

        // Libraries its tables name outside the folder.
        let mut shared = Vec::new();
        for table in ["sym-lib-table", "fp-lib-table", "design-block-lib-table"] {
            let Some(f) = all.get(&format!("{pre}{table}")) else { continue };
            if f.size > 1024 * 1024 {
                continue;
            }
            let text = String::from_utf8_lossy(&gh.blob(&w.sources[f.src].repo, &f.sha).await?).into_owned();
            for target in resolve_refs(table, &refs_of(table, &text)).into_iter().filter(|t| !t.absolute).map(|t| t.path) {
                if !target.starts_with("../") {
                    continue;
                }
                let at = repo_path(dir, &target);
                let there = match &at {
                    Some(at) => all.contains_key(at) || all.keys().any(|p| p.starts_with(&format!("{at}/"))),
                    None => false,
                };
                if !shared.iter().any(|(t, _, _)| *t == target) {
                    shared.push((target, at, there));
                }
            }
        }
        found.push(Found { path: dir.clone(), name, project_files: stems.clone(), files, inside, submodule, shared });
    }
    let remote = Remote {
        head: Some(head),
        tree: Some(tree),
        files: all,
        truncated: w.truncated,
        sources: w.sources,
        notes: w.notes,
        nested: Vec::new(),
        folder_exists: true,
        branch: None,
        module_paths: w.modules.get(&0).map(|m| m.keys().cloned().collect()).unwrap_or_default(),
        links: w.links,
        lfs: BTreeSet::new(),
    };
    Ok((remote, found))
}

// ------------------------------------------------------------------ a folder that moved

/// Where the project went when its folder is no longer where the link says: folders of
/// the branch (other than `not`, where it was) that hold the files the project had at
/// the last sync, best match first, and whether the first is clearly the one.
/// `base` is project path -> blob id as of that sync.
pub(super) async fn find_moved(gh: &Gh, repo: &RepoRef, tree: &str, base: &HashMap<String, String>, not: &str) -> Result<(Vec<String>, bool), GhErr> {
    let (all, _) = gh.tree(repo, tree).await?;
    let wanted: Vec<(&String, &String)> = base.iter().filter(|(p, _)| !p.starts_with("../")).collect();
    let pro_shas: BTreeSet<&String> = wanted.iter().filter(|(p, _)| p.ends_with(".kicad_pro")).map(|(_, s)| *s).collect();
    if wanted.is_empty() {
        return Ok((Vec::new(), false));
    }
    // Candidate folders: wherever a project file is.
    let dirs: BTreeSet<&str> = all.keys().filter(|p| p.ends_with(".kicad_pro")).map(|p| dir_of(p)).filter(|d| *d != not).collect();
    let mut scored: Vec<(usize, bool, String)> = Vec::new();
    for dir in dirs {
        let pre = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        let same = wanted.iter().filter(|(p, s)| all.get(&format!("{pre}{p}")).is_some_and(|(r, _)| r == *s)).count();
        // The project file itself, under any name (the project may have been renamed too).
        let pro = all.iter().any(|(p, (s, _))| p.ends_with(".kicad_pro") && dir_of(p) == dir && pro_shas.contains(s));
        if pro || same * 2 >= wanted.len() {
            scored.push((same, pro, dir.to_string()));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    // One folder that holds clearly more of the project than any other (and at least
    // half of it) is where it went; a copy of a few of its files elsewhere is not.
    let clear = match scored.as_slice() {
        [only] => only.0 * 2 >= wanted.len() || only.1,
        [first, second, ..] => first.0 > second.0 && first.0 * 2 >= wanted.len(),
        [] => false,
    };
    Ok((scored.into_iter().map(|(_, _, d)| d).collect(), clear))
}

// ------------------------------------------------------------------ the same file under a new name

/// Whether two versions look like one file that was renamed and perhaps edited: the
/// same root uuid (a schematic keeps it for life), or mostly the same lines.
pub(super) fn similar(a: &[u8], b: &[u8]) -> bool {
    if a == b {
        return true;
    }
    let (Ok(a), Ok(b)) = (std::str::from_utf8(a), std::str::from_utf8(b)) else { return false };
    let root_uuid = |t: &str| -> Option<String> {
        let head = &t[..t.len().min(600)];
        // the file's own uuid sits at depth 1, before any item
        let i = head.find("\n\t(uuid ").or_else(|| head.find("\n  (uuid "))?;
        quoted_after(&head[i..], "(uuid").first().map(|s| s.to_string())
    };
    if let (Some(x), Some(y)) = (root_uuid(a), root_uuid(b)) {
        return x == y;
    }
    let mut lines: HashMap<&str, i64> = HashMap::new();
    let mut total_a = 0i64;
    for l in a.lines().map(str::trim).filter(|l| !l.is_empty()) {
        *lines.entry(l).or_default() += 1;
        total_a += 1;
    }
    let (mut common, mut total_b) = (0i64, 0i64);
    for l in b.lines().map(str::trim).filter(|l| !l.is_empty()) {
        total_b += 1;
        if let Some(n) = lines.get_mut(l) {
            if *n > 0 {
                *n -= 1;
                common += 1;
            }
        }
    }
    let most = total_a.max(total_b);
    most >= 4 && common * 10 >= most * 6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(norm_join("hw/keybit", "../lib/lcsc.pretty"), "hw/lib/lcsc.pretty");
        assert_eq!(norm_join("", "../lib/x"), "../lib/x");
        assert_eq!(norm_join("a", "../../x/./y"), "../x/y");
        assert_eq!(norm_join("a/b", "c\\d"), "a/b/c/d");
        assert_eq!(repo_path("hardware/keybit", "../lib/lcsc.kicad_sym").as_deref(), Some("hardware/lib/lcsc.kicad_sym"));
        assert_eq!(repo_path("hardware/keybit", "keybit.kicad_pcb").as_deref(), Some("hardware/keybit/keybit.kicad_pcb"));
        assert_eq!(repo_path("", "../lib/x.kicad_sym"), None, "above the repository root");
        assert_eq!(repo_path("hw", "../../x"), None);
        assert_eq!(sync_path("../lib/a.kicad_sym").as_deref(), Some("../lib/a.kicad_sym"));
        assert_eq!(sync_path("../../lib/a.pretty/R.kicad_mod").as_deref(), Some("../../lib/a.pretty/R.kicad_mod"));
        assert_eq!(sync_path("a/b.kicad_sch").as_deref(), Some("a/b.kicad_sch"));
        assert_eq!(sync_path("a/../b.kicad_sch"), None, "only leading parent segments");
        assert_eq!(sync_path("/etc/x.kicad_sch"), None);
        assert_eq!(sync_path("../"), None);
    }

    #[test]
    fn what_files_name() {
        let named = |path: &str, text: &str| -> Vec<String> {
            let mut v: Vec<String> = resolve_refs(path, &refs_of(path, text)).into_iter().map(|t| format!("{}{}{}", t.path, if t.optional { "?" } else { "" }, if t.absolute { " (absolute)" } else { "" })).collect();
            v.sort();
            v
        };
        let table = "(fp_lib_table\n  (version 7)\n  (lib (name \"lcsc\")(type \"KiCad\")(uri \"${KIPRJMOD}/../lib/lcsc.pretty\")(options \"\")(descr \"\"))\n  (lib (name std)(type KiCad)(uri ${KICAD9_FOOTPRINT_DIR}/R.pretty))\n  (lib (name mine)(type KiCad)(uri $(KIPRJMOD)/mine.pretty))\n)";
        assert_eq!(named("fp-lib-table", table), vec!["../lib/lcsc.pretty", "mine.pretty"]);
        // written on Windows, with no variable at all, as a file URL, and absolute
        let odd = "(sym_lib_table (lib (name a)(type KiCad)(uri \"${KIPRJMOD}\\..\\parts\\a.kicad_sym\"))(lib (name b)(type KiCad)(uri \"../../common/b.kicad_sym\"))\n (lib (name c)(type KiCad)(uri \"file://${KIPRJMOD}/c.kicad_sym\"))(lib (name d)(type KiCad)(uri \"C:\\Users\\me\\keys\\hardware\\lib\\d.kicad_sym\"))(lib (name e)(type KiCad)(uri \"https://example.com/e.kicad_sym\")))";
        assert_eq!(named("sym-lib-table", odd), vec!["../../common/b.kicad_sym", "../parts/a.kicad_sym", "C:/Users/me/keys/hardware/lib/d.kicad_sym? (absolute)", "c.kicad_sym"]);
        let sch = "(kicad_sch\n\t(sheet\n\t\t(property \"Sheetname\" \"psu\")\n\t\t(property \"Sheetfile\" \"../common/psu.kicad_sch\"\n\t\t\t(at 0 0 0))\n\t)\n\t(sheet (property \"Sheetfile\" \"io.kicad_sch\"))\n\t(symbol (property \"Sim.Library\" \"../models/opamp.lib\"))\n)";
        assert_eq!(named("sub/top.kicad_sch", sch), vec!["../models/opamp.lib?", "common/psu.kicad_sch", "sub/io.kicad_sch"]);
        assert_eq!(named("top.kicad_sch", sch), vec!["../common/psu.kicad_sch", "../models/opamp.lib?", "io.kicad_sch"]);
        // a board wants the STEP file beside a VRML model; a footprint in a library does not ask for it
        let pcb = "(kicad_pcb (footprint \"a:b\" (model \"${KIPRJMOD}/../lib/lcsc.3dshapes/X.wrl\" (offset (xyz 0 0 0))) (model \"${KICAD10_3DMODEL_DIR}/R.3dshapes/R.step\") (model \"/Users/me/keys/hardware/lib/lcsc.3dshapes/Y.wrl\") (model \"Resistors_SMD.3dshapes/R_0603.wrl\")))";
        assert_eq!(named("b.kicad_pcb", pcb), vec![
            "../lib/lcsc.3dshapes/X.step?", "../lib/lcsc.3dshapes/X.stp?", "../lib/lcsc.3dshapes/X.wrl", "/Users/me/keys/hardware/lib/lcsc.3dshapes/Y.step? (absolute)",
            "/Users/me/keys/hardware/lib/lcsc.3dshapes/Y.stp? (absolute)", "/Users/me/keys/hardware/lib/lcsc.3dshapes/Y.wrl? (absolute)",
            "Resistors_SMD.3dshapes/R_0603.step?", "Resistors_SMD.3dshapes/R_0603.stp?", "Resistors_SMD.3dshapes/R_0603.wrl?"]);
        assert_eq!(named("../lib/a.pretty/b.kicad_mod", "(footprint \"b\" (model \"${KIPRJMOD}/../lib/lcsc.3dshapes/X.wrl\"))"), vec!["../lib/lcsc.3dshapes/X.wrl"]);
        // the drawing sheet a project file names
        let pro = "{\"pcbnew\": {\"page_layout_descr_file\": \"../shared/frame.kicad_wks\"}, \"schematic\": {\"page_layout_descr_file\": \"\"}, \"uri\": \"${KIPRJMOD}/../x\"}";
        assert_eq!(named("x.kicad_pro", pro), vec!["../shared/frame.kicad_wks?"]);
    }

    #[test]
    fn absolute_paths_into_a_checkout() {
        let repo = RepoRef::parse("me/keys").unwrap();
        assert_eq!(absolute_in_repo("/Users/me/Documents/GitHub/keys/hardware/lib/a.wrl", &repo, "hardware/keyword"), vec!["hardware/lib/a.wrl"]);
        // cloned under another name: the project's own top folder still places it
        assert_eq!(absolute_in_repo("C:/work/kb/hardware/lib/a.wrl", &repo, "hardware/keyword"), vec!["hardware/lib/a.wrl"]);
        assert!(absolute_in_repo("/usr/share/kicad/3dmodels/R.wrl", &repo, "hardware/keyword").is_empty());
        assert_eq!(project_path("hardware/keyword", "hardware/lib/a.wrl"), "../lib/a.wrl");
        assert_eq!(project_path("", "lib/a.wrl"), "lib/a.wrl");
        assert_eq!(project_path("a/b", "a/b/c.wrl"), "c.wrl");
        assert_eq!(project_path("a/b", "x/c.wrl"), "../../x/c.wrl");
    }

    #[test]
    fn gitmodules() {
        let m = parse_gitmodules("[submodule \"hardware/lib\"]\n\tpath = hardware/lib\n\turl = https://github.com/o/parts.git\n\tbranch = main\n# note\n[submodule \"x\"]\n  path=fw/rtos\n  url = git@gitlab.com:a/b.git\n");
        assert_eq!(m["hardware/lib"], Module { url: "https://github.com/o/parts.git".into(), branch: Some("main".into()) });
        assert_eq!(m["fw/rtos"].branch, None);
        let parent = RepoRef::parse("me/board").unwrap();
        let r = |u: &str| submodule_repo(u, &parent, "127.0.0.1:8098").map(|r| r.slug());
        assert_eq!(r("https://github.com/o/parts.git").as_deref(), Some("o/parts"));
        assert_eq!(r("https://github.com/o/parts/").as_deref(), Some("o/parts"));
        assert_eq!(r("git@github.com:o/parts.git").as_deref(), Some("o/parts"));
        assert_eq!(r("ssh://git@github.com/o/parts").as_deref(), Some("o/parts"));
        assert_eq!(r("../parts.git").as_deref(), Some("me/parts"));
        assert_eq!(r("../../other/parts").as_deref(), Some("other/parts"));
        assert_eq!(r("http://127.0.0.1:8098/o/parts.git").as_deref(), Some("o/parts"));
        assert_eq!(r("git@gitlab.com:a/b.git"), None);
        assert_eq!(r("https://example.com/o/parts.git"), None);
        assert_eq!(r("../../../x"), None);
    }

    #[test]
    fn renamed_files_are_recognised() {
        let sch = |uuid: &str, extra: &str| format!("(kicad_sch\n\t(version 20250114)\n\t(generator \"eeschema\")\n\t(uuid \"{uuid}\")\n\t(paper \"A4\")\n{extra})\n");
        assert!(similar(sch("aaaa", "").as_bytes(), sch("aaaa", "\t(wire)\n\t(wire)\n\t(label)\n\t(junction)\n\t(text)\n").as_bytes()), "same root uuid");
        assert!(!similar(sch("aaaa", "").as_bytes(), sch("bbbb", "").as_bytes()), "another schematic");
        let lines = |n: usize, tag: &str| (0..n).map(|i| format!("(fp {tag}{i})\n")).collect::<String>();
        let a = format!("(kicad_pcb\n{}", lines(20, "x"));
        let b = format!("(kicad_pcb\n{}{}", lines(20, "x"), lines(3, "y"));
        assert!(similar(a.as_bytes(), b.as_bytes()), "a board with a few more items");
        assert!(!similar(a.as_bytes(), format!("(kicad_pcb\n{}", lines(20, "z")).as_bytes()));
        assert!(!similar(b"\x00\x01", b"\x00\x02"));
    }
}
