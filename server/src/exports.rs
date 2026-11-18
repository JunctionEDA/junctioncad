//! Files made for a project and handed to a person as a link (migration 0190): the fabrication
//! package an assistant builds over MCP.  Stored by a member of the project, downloaded by a member
//! signed in to the site; the newest few per project are kept, for two weeks.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::persist;
use crate::AppState;

const MAX_BYTES: usize = 40 * 1024 * 1024;
const KEEP: i64 = 8;
const KEEP_DAYS: i32 = 14;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/projects/{id}/exports", post(store))
        .route("/api/exports/{id}", get(fetch))
}

#[derive(Deserialize)]
struct StoreQuery {
    name: String,
}

/// A file name a browser can save under: the last path segment, without control characters or quotes.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && *c != '"').take(120).collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() { "export.bin".into() } else { clean }
}

/// `POST /api/projects/{id}/exports?name=board-jlcpcb.zip` with the file as the body.
async fn store(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>, Query(q): Query<StoreQuery>, body: Bytes) -> AppResult<Json<Value>> {
    persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;
    if body.is_empty() || body.len() > MAX_BYTES {
        return Err(AppError::BadRequest("the file is empty or too large".into()));
    }
    let name = safe_name(&q.name);
    let row = sqlx::query("INSERT INTO project_exports (project_id, name, bytes, created_by) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(id).bind(&name).bind(&body[..]).bind(user.id).fetch_one(&state.pool).await?;
    let export: Uuid = row.get("id");
    sqlx::query(
        "DELETE FROM project_exports WHERE created_at < now() - make_interval(days => $2)
            OR (project_id = $1 AND id NOT IN (SELECT id FROM project_exports WHERE project_id = $1 ORDER BY created_at DESC LIMIT $3))")
        .bind(id).bind(KEEP_DAYS).bind(KEEP).execute(&state.pool).await?;
    Ok(Json(json!({ "id": export, "name": name, "bytes": body.len(), "path": format!("/api/exports/{export}"), "keptDays": KEEP_DAYS })))
}

/// `GET /api/exports/{id}`: the file, for a member of its project.
async fn fetch(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>) -> AppResult<Response> {
    let row = sqlx::query("SELECT project_id, name, bytes FROM project_exports WHERE id = $1").bind(id).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    persist::effective_role(&state.pool, user.id, row.get("project_id")).await?.ok_or(AppError::NotFound)?;
    let name: String = row.get("name");
    let kind = if name.ends_with(".zip") { "application/zip" } else if name.ends_with(".csv") { "text/csv; charset=utf-8" } else { "application/octet-stream" };
    Ok(([(header::CONTENT_TYPE, kind.to_string()), (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"")), (header::CACHE_CONTROL, "private, no-store".to_string())],
        row.get::<Vec<u8>, _>("bytes")).into_response())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn names_are_plain_file_names() {
        assert_eq!(safe_name("board-jlcpcb.zip"), "board-jlcpcb.zip");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("a\"b\r\n.zip"), "ab.zip");
        assert_eq!(safe_name(".."), "export.bin");
    }
}
