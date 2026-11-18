//! Changes an assistant proposes for a person to accept (migration 0195).  The assistant's MCP host plans the
//! change and stores it here; everyone who has the document open is told, sees it previewed on the canvas and
//! can accept or reject it.  Accepting is done by the editor of the person who accepts, as their own edit: this
//! module only keeps the proposal and its outcome.

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::doc_actor::DocMsg;
use crate::error::{AppError, AppResult};
use crate::persist;
use crate::AppState;

const MAX_BODY: usize = 3 * 1024 * 1024;
const MAX_PENDING: i64 = 12;
const KEEP_DAYS: i32 = 30;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/docs/{id}/proposals", get(list).post(create))
        .route("/api/proposals/{id}", get(fetch).patch(decide))
}

const COLS: &str = "p.id, p.project_id, p.doc_id, p.app, p.title, p.rationale, p.status, p.reason, p.created_at, p.decided_at,
    p.body->'lines' AS lines, p.body->'connectivity' AS connectivity, (p.body->'rules') IS NOT NULL AND p.body->'rules' <> 'null'::jsonb AS has_rules,
    d.path AS doc_path, cu.login AS by_login, cu.name AS by_name, du.login AS decided_login, du.name AS decided_name";
const FROM: &str = "design_proposals p JOIN documents d ON d.id = p.doc_id LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users du ON du.id = p.decided_by";

fn meta(r: &PgRow) -> Value {
    let who = |login: Option<String>, name: Option<String>| login.map(|l| json!({ "login": l, "name": name }));
    json!({
        "id": r.get::<Uuid, _>("id"), "projectId": r.get::<Uuid, _>("project_id"), "docId": r.get::<Uuid, _>("doc_id"),
        "docPath": r.get::<String, _>("doc_path"), "app": r.get::<String, _>("app"),
        "title": r.get::<String, _>("title"), "rationale": r.get::<String, _>("rationale"),
        "status": r.get::<String, _>("status"), "reason": r.get::<String, _>("reason"),
        "lines": r.get::<Option<Value>, _>("lines").unwrap_or(json!([])),
        "connectivity": r.get::<Option<Value>, _>("connectivity"),
        "rules": r.get::<bool, _>("has_rules"),
        "createdAt": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
        "decidedAt": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("decided_at").map(|t| t.to_rfc3339()),
        "by": who(r.get("by_login"), r.get("by_name")),
        "decidedBy": who(r.get("decided_login"), r.get("decided_name")),
    })
}

async fn one(state: &AppState, id: Uuid) -> AppResult<Value> {
    let row = sqlx::query(&format!("SELECT {COLS} FROM {FROM} WHERE p.id = $1")).bind(id).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    Ok(meta(&row))
}

/// The document and the caller's role in its project; `edit` asks for the right to change the design.
async fn access(state: &AppState, user: i64, doc_id: Uuid, edit: bool) -> AppResult<persist::Document> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user, doc.project_id).await?.ok_or(AppError::NotFound)?;
    if edit && role != "editor" {
        return Err(AppError::Forbidden);
    }
    Ok(doc)
}

async fn tell(state: &AppState, action: &str, proposal: &Value) {
    let Some(doc_id) = proposal["docId"].as_str().and_then(|s| Uuid::parse_str(s).ok()) else { return };
    let payload = json!({ "type": "proposal", "docId": doc_id, "action": action, "proposal": proposal });
    state.doc_event(doc_id, DocMsg::Notice { payload }).await;
}

#[derive(Deserialize)]
struct NewProposal {
    title: String,
    #[serde(default)]
    rationale: String,
    #[serde(default)]
    app: String,
    /// lines, changes, basis, rules, connectivity: the planned change as the editor applies it
    body: Value,
}

fn clip(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// `POST /api/docs/{id}/proposals`: store a planned change for the people in the document to decide on.
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, Path(doc_id): Path<Uuid>, Json(req): Json<NewProposal>) -> AppResult<Json<Value>> {
    let doc = access(&state, user.id, doc_id, true).await?;
    let title = clip(&req.title, 160);
    if title.is_empty() {
        return Err(AppError::BadRequest("a proposal needs a title".into()));
    }
    if !req.body["changes"].is_array() || !req.body["lines"].is_array() || !req.body["basis"].is_object() {
        return Err(AppError::BadRequest("a proposal needs its lines, changes and basis".into()));
    }
    if req.body.to_string().len() > MAX_BODY {
        return Err(AppError::BadRequest("this change is too large to propose in one piece: propose it in smaller parts".into()));
    }
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM design_proposals WHERE doc_id = $1 AND status = 'pending'").bind(doc_id).fetch_one(&state.pool).await?;
    if pending >= MAX_PENDING {
        return Err(AppError::BadRequest(format!("{pending} proposals are already waiting on this document: wait for them to be decided, or withdraw some")));
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO design_proposals (project_id, doc_id, created_by, app, title, rationale, body, base_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $2), 0)) RETURNING id")
        .bind(doc.project_id).bind(doc_id).bind(user.id).bind(clip(&req.app, 80)).bind(&title).bind(clip(&req.rationale, 2000)).bind(&req.body)
        .fetch_one(&state.pool).await?;
    sqlx::query("DELETE FROM design_proposals WHERE created_at < now() - make_interval(days => $1)").bind(KEEP_DAYS).execute(&state.pool).await?;
    let proposal = one(&state, id).await?;
    tell(&state, "added", &proposal).await;
    Ok(Json(proposal))
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
}

/// `GET /api/docs/{id}/proposals?status=pending`: the proposals of a document, newest first, without their changes.
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser, Path(doc_id): Path<Uuid>, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    access(&state, user.id, doc_id, false).await?;
    let rows = sqlx::query(&format!("SELECT {COLS} FROM {FROM} WHERE p.doc_id = $1 AND ($2::text IS NULL OR p.status = $2) ORDER BY p.created_at DESC LIMIT 40"))
        .bind(doc_id).bind(q.status.as_deref().filter(|s| !s.is_empty())).fetch_all(&state.pool).await?;
    Ok(Json(json!({ "proposals": rows.iter().map(meta).collect::<Vec<_>>() })))
}

/// `GET /api/proposals/{id}`: one proposal with its changes, for the editor that previews or applies it.
async fn fetch(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let row = sqlx::query("SELECT doc_id, body FROM design_proposals WHERE id = $1").bind(id).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    access(&state, user.id, row.get("doc_id"), false).await?;
    let mut proposal = one(&state, id).await?;
    proposal["body"] = row.get::<Value, _>("body");
    // Has someone edited an item this would change since it was proposed?  The web editor compares the items
    // themselves; the desktop app asks here.
    let touched: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM design_proposals p JOIN ops o ON o.doc_id = p.doc_id AND o.seq > p.base_seq,
                        jsonb_array_elements(CASE WHEN jsonb_typeof(o.changes) = 'array' THEN o.changes ELSE '[]'::jsonb END) c
                        WHERE p.id = $1 AND (p.body->'basis') ? (c->>'id'))")
        .bind(id).fetch_one(&state.pool).await?;
    proposal["stale"] = if touched { json!("An item this would change has been edited since it was proposed.") } else { Value::Null };
    Ok(Json(proposal))
}

#[derive(Deserialize)]
struct Decision {
    status: String,
    #[serde(default)]
    reason: String,
}

/// `PATCH /api/proposals/{id}` `{status: accepted | rejected | withdrawn | stale, reason}`: settle a pending proposal,
/// once.  A second decision is refused with the first one's outcome.
async fn decide(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>, Json(req): Json<Decision>) -> AppResult<Json<Value>> {
    if !matches!(req.status.as_str(), "accepted" | "rejected" | "withdrawn" | "stale") {
        return Err(AppError::BadRequest("status must be accepted, rejected, withdrawn or stale".into()));
    }
    let doc_id: Uuid = sqlx::query_scalar("SELECT doc_id FROM design_proposals WHERE id = $1").bind(id).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    access(&state, user.id, doc_id, true).await?;
    let done = sqlx::query("UPDATE design_proposals SET status = $2, reason = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'pending'")
        .bind(id).bind(&req.status).bind(clip(&req.reason, 500)).bind(user.id).execute(&state.pool).await?.rows_affected();
    let proposal = one(&state, id).await?;
    if done == 0 {
        return Err(AppError::Api(axum::http::StatusCode::CONFLICT, "proposal_decided", format!("This proposal was already {}.", proposal["status"].as_str().unwrap_or("decided"))));
    }
    tell(&state, "decided", &proposal).await;
    Ok(Json(proposal))
}
