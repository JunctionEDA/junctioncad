//! "Devboard Demo": the project every new account starts with, so there is a real board to tinker with on the
//! first visit.
//!
//! It is a snapshot of the Cyberboard project (github.com/notaroomba/cyberboard, hardware/): schematic, board,
//! project file, library tables and the project's own symbol, footprint and 3D model library.  The files are
//! compiled in as `seed/devboard-demo.zip`, written by `scripts/seed/devboard-demo.py`, so making a copy reads
//! nothing from GitHub.  Each account gets its own private copy, owned by it, shared with nobody.
//!
//! `users.demo_seeded` (migration 0205) makes it happen once: a new account is inserted with false, and the copy
//! is made in the same transaction that sets it to true, so a repeated or concurrent sign-in finds it done.
//! Accounts from before the migration are marked done.

use std::io::Read;

use uuid::Uuid;

use crate::http::doc_type_for;
use crate::AppState;

/// The name the project gets in the person's list.
pub const NAME: &str = "Devboard Demo";

const SEED: &[u8] = include_bytes!("../seed/devboard-demo.zip");

/// The seed's files, project-relative path and content, in archive order.
fn files() -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(SEED)).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = crate::http::safe_zip_name(f.name()).ok_or_else(|| format!("bad path {}", f.name()))?;
        let mut data = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut data).map_err(|e| e.to_string())?;
        out.push((name, data));
    }
    Ok(out)
}

/// `fonts/<face>/<file>`: a font the design's text names by `face`, kept as the project's font rather than as a
/// project file (the web editor, its plots and the desktop fetch a face that is not installed from there).
fn font_entry(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("fonts/")?;
    let (face, file) = rest.split_once('/')?;
    (!face.is_empty() && !file.is_empty() && !file.contains('/')).then_some((face, file))
}

fn hex_sha256(data: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// Give `user_id` its Devboard Demo if it is still owed one.  Returns the new project's id, or None when the
/// account already had it (or never was owed it).  All or nothing: on any error nothing is kept and the
/// account stays owed, so the next sign-in or project list tries again.
pub async fn ensure(state: &AppState, user_id: i64) -> anyhow::Result<Option<Uuid>> {
    // Cheap check first: this runs on every project list.
    let owed: Option<bool> = sqlx::query_scalar("SELECT NOT demo_seeded FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    if owed != Some(true) {
        return Ok(None);
    }

    let files = tokio::task::spawn_blocking(files).await?.map_err(|e| anyhow::anyhow!("demo seed: {e}"))?;
    let mut tx = state.pool.begin().await?;
    // Claiming the flag locks the account's row: a second sign-in racing this one waits here, then finds
    // nothing to claim.
    let claimed = sqlx::query("UPDATE users SET demo_seeded = true WHERE id = $1 AND NOT demo_seeded")
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if claimed == 0 {
        return Ok(None);
    }
    let project = copy_into(&mut tx, user_id, &files).await?;
    tx.commit().await?;
    tracing::info!(user_id, %project, files = files.len(), "gave a new account its Devboard Demo");
    Ok(Some(project))
}

/// Make a copy of the seed owned by `user_id` inside `tx`; returns the new project's id.
async fn copy_into(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i64,
    files: &[(String, Vec<u8>)],
) -> anyhow::Result<Uuid> {
    let project: Uuid =
        sqlx::query_scalar("INSERT INTO projects (owner_id, name, public) VALUES ($1, $2, false) RETURNING id")
            .bind(user_id)
            .bind(NAME)
            .fetch_one(&mut **tx)
            .await?;
    for (path, content) in files {
        if let Some((face, file_name)) = font_entry(path) {
            let font = crate::fonts::inspect(content, 0).map_err(|e| anyhow::anyhow!("demo font {path}: {e:?}"))?;
            sqlx::query(
                "INSERT INTO project_font_files (project_id, family_key, family, bold, italic, file_name, fs_type, license, sha256, bytes, data, uploaded_by)
                 VALUES ($1, $2, $3, false, false, $4, $5, $6, $7, $8, $9, $10)",
            )
            .bind(project)
            .bind(face.to_lowercase())
            .bind(face)
            .bind(file_name)
            .bind(font.fs_type.unwrap_or(0) as i32)
            .bind(&font.license)
            .bind(hex_sha256(&font.data))
            .bind(font.data.len() as i64)
            .bind(&font.data)
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
            continue;
        }
        let doc: Uuid = sqlx::query_scalar(
            "INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(project)
        .bind(path)
        .bind(doc_type_for(path))
        .fetch_one(&mut **tx)
        .await?;
        sqlx::query("INSERT INTO snapshots (doc_id, seq, content, uploader_id) VALUES ($1, 0, $2, $3)")
            .bind(doc)
            .bind(content.as_slice())
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(project)
}

/// The caller's Devboard Demo: their newest project of that name, made for them first when they have none
/// (an account from before the demo, or one that deleted its copy).  The home page's "Keep going in a real
/// project" opens it.
async fn find_or_make(state: &AppState, user_id: i64) -> anyhow::Result<Uuid> {
    ensure(state, user_id).await?;
    let find = "SELECT id FROM projects WHERE owner_id = $1 AND name = $2 AND deleted_at IS NULL AND parent_id IS NULL
                ORDER BY created_at DESC LIMIT 1";
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(find).bind(user_id).bind(NAME).fetch_optional(&state.pool).await? {
        return Ok(id);
    }
    let files = tokio::task::spawn_blocking(files).await?.map_err(|e| anyhow::anyhow!("demo seed: {e}"))?;
    let mut tx = state.pool.begin().await?;
    // the account's row is the lock: two clicks at once make one copy
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE").bind(user_id).execute(&mut *tx).await?;
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(find).bind(user_id).bind(NAME).fetch_optional(&mut *tx).await? {
        return Ok(id);
    }
    let project = copy_into(&mut tx, user_id, &files).await?;
    tx.commit().await?;
    tracing::info!(user_id, %project, "made a Devboard Demo on request");
    Ok(project)
}

/// POST /api/projects/demo: `{ projectId }` of the caller's Devboard Demo (see `find_or_make`).
pub async fn open(
    axum::extract::State(state): axum::extract::State<AppState>,
    crate::auth::AuthUser(user): crate::auth::AuthUser,
) -> crate::error::AppResult<axum::Json<serde_json::Value>> {
    let id = find_or_make(&state, user.id).await?;
    Ok(axum::Json(serde_json::json!({ "projectId": id, "name": NAME })))
}

/// `ensure`, with a failure logged instead of returned: a missing demo must never stop a sign-in or a list.
pub async fn ensure_quietly(state: &AppState, user_id: i64) {
    if let Err(e) = ensure(state, user_id).await {
        tracing::warn!(user_id, "Devboard Demo not made: {e:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seed_is_a_whole_kicad_project_with_its_libraries_and_models() {
        let files = files().expect("seed unpacks");
        let names: std::collections::HashSet<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        for need in ["Devboard_Demo.kicad_pro", "Devboard_Demo.kicad_sch", "Devboard_Demo.kicad_pcb",
                     "sym-lib-table", "fp-lib-table", "lib/lcsc.kicad_sym"] {
            assert!(names.contains(need), "{need} missing");
        }
        assert!(files.iter().any(|(n, _)| n.starts_with("lib/lcsc.pretty/") && n.ends_with(".kicad_mod")));
        let text = |n: &str| String::from_utf8(files.iter().find(|(p, _)| p == n).unwrap().1.clone()).unwrap();
        let pcb = text("Devboard_Demo.kicad_pcb");
        // every model the board names inside the project is in the seed
        let mut models = 0;
        for line in pcb.lines() {
            if let Some(rest) = line.trim().strip_prefix("(model \"${KIPRJMOD}/") {
                let path = rest.split('"').next().unwrap();
                assert!(names.contains(path), "board names {path}, which the seed lacks");
                let step = path.rsplit_once('.').unwrap().0.to_string() + ".step";
                assert!(names.contains(step.as_str()), "{step} missing (the web 3D view reads STEP)");
                models += 1;
            }
            assert!(!line.contains("(model \"/"), "an absolute model path is left: {line}");
        }
        assert!(models >= 14, "only {models} project models on the board");
        assert!(!pcb.contains("(sheetfile \"Cyberboard"));
        assert!(!text("Devboard_Demo.kicad_sch").contains("(project \"Cyberboard\""));
        assert!(text("Devboard_Demo.kicad_pro").contains("\"filename\": \"Devboard_Demo.kicad_pro\""));
        // the two faces the text uses travel with the project, and their licences let them
        let pcb_sch = pcb.clone() + &text("Devboard_Demo.kicad_sch");
        let fonts: Vec<_> = files.iter().filter_map(|(n, d)| font_entry(n).map(|(face, _)| (face, d))).collect();
        assert_eq!(fonts.len(), 2);
        for (face, data) in fonts {
            assert!(pcb_sch.contains(&format!("(face \"{face}\")")), "{face} is not used");
            let f = crate::fonts::inspect(data, 0).expect("a font");
            assert!(crate::fonts::may_embed(f.fs_type), "{face} may not be embedded: fsType {:?}", f.fs_type);
        }
        for (n, _) in files.iter().filter(|(n, _)| font_entry(n).is_none()) {
            assert_ne!(doc_type_for(n), "other", "{n} would not be stored as a project file");
        }
    }
}
