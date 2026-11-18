//! Project chat: one running conversation per project, for the people working on it together.
//!
//! Review threads (comments) stay pinned to a part or a net; the chat is the room beside them,
//! where people talk about the work as it happens (the screenshot that asked for it showed people
//! typing to each other in text items on the sheet).  A message may carry a link to a place in
//! the design: a part, a net or a spot on one of the project's documents.
//!
//! Who may do what follows the comment rights (access.rs): anyone who can see the project reads
//! the chat, the commenter role or more writes in it, a message's author edits it, and the author
//! or the project's owner deletes it.  A change reaches every open document of the project at once
//! (each socket joins one document) as `{"type": "chat", ...}` through DocMsg::Notice, so it rides
//! the relay to the other replicas too.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::access::{self, Viewer};
use crate::error::{AppError, AppResult};
use crate::lenient_json::LenientJson;
use crate::persist;
use crate::AppState;

/// The longest message, in bytes.
pub const MAX_BODY: usize = 4000;
/// How many messages one page of history holds at most.
pub const MAX_PAGE: i64 = 200;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChatMessage {
    pub id: i64,
    pub project_id: Uuid,
    pub author_id: i64,
    pub author_login: String,
    pub author_name: Option<String>,
    pub author_avatar: Option<String>,
    pub body: String,
    pub link: Option<Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub edited_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl ChatMessage {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "projectId": self.project_id,
            "authorId": self.author_id,
            "authorLogin": self.author_login,
            "authorName": self.author_name,
            "authorAvatar": self.author_avatar,
            "body": self.body,
            "link": self.link,
            "createdAt": self.created_at.to_rfc3339(),
            "editedAt": self.edited_at.map(|t| t.to_rfc3339()),
        })
    }
}

const COLS: &str = "m.id, m.project_id, m.author_id, u.login AS author_login, u.name AS author_name,
                    u.avatar_url AS author_avatar, m.body, m.link, m.created_at, m.edited_at";

/// A link as a client sends it, checked and cut down to the fields the chat keeps.
#[derive(Debug, Deserialize)]
pub struct LinkIn {
    #[serde(rename = "docId")]
    pub doc_id: Uuid,
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub x: Option<i64>,
    #[serde(default)]
    pub y: Option<i64>,
    /// For a net: the item it was picked from (an unnamed net has no name to find it by).
    #[serde(default)]
    pub item: Option<String>,
    /// Exactly what was selected: item uuids, a pad ("<footprint>#<number>"), a pin ("pin:<symbol>#<number>"),
    /// a field ("field:<item>#<name>").  The reader's editor selects the same and outlines it.
    #[serde(default)]
    pub sel: Option<Vec<String>>,
    /// The union box of the selection on the writer's screen, nm: [x0, y0, x1, y1].
    #[serde(default)]
    pub bbox: Option<Vec<i64>>,
}

/// The kinds of place a message can point at.
pub const LINK_KINDS: &[&str] = &["item", "net", "pin", "pad", "field", "spot"];

/// Check a link against the project: its document must be one of the project's, and its
/// kind one the editors know.  Returns the JSON stored with the message.
pub fn checked_link(link: &LinkIn, docs: &[persist::Document]) -> Result<Value, AppError> {
    let doc = docs
        .iter()
        .find(|d| d.id == link.doc_id)
        .ok_or_else(|| AppError::BadRequest("the link's document is not in this project".into()))?;
    if !LINK_KINDS.contains(&link.kind.as_str()) {
        return Err(AppError::BadRequest(format!("link kind must be one of {}", LINK_KINDS.join(", "))));
    }
    let id = link.id.as_deref().unwrap_or("").trim();
    if link.kind != "spot" && id.is_empty() {
        return Err(AppError::BadRequest("an item or net link needs its id".into()));
    }
    let clip = |s: &str, n: usize| -> String { s.chars().take(n).collect() };
    let sel: Vec<String> = link.sel.as_deref().unwrap_or(&[]).iter()
        .map(|t| clip(t.trim(), 120)).filter(|t| !t.is_empty()).take(200).collect();
    let bbox = link.bbox.as_ref().filter(|b| b.len() == 4).cloned();
    Ok(json!({
        "docId": doc.id,
        "path": doc.path,
        "kind": link.kind,
        "id": clip(id, 200),
        "label": clip(link.label.as_deref().unwrap_or("").trim(), 120),
        "x": link.x.unwrap_or(0),
        "y": link.y.unwrap_or(0),
        "item": link.item.as_deref().map(|i| clip(i.trim(), 120)),
        "sel": sel,
        "bbox": bbox,
    }))
}

/// The text of a message as it is stored, or why it cannot be.
pub fn checked_body(body: &str) -> Result<&str, AppError> {
    let body = body.trim();
    if body.is_empty() || body.len() > MAX_BODY {
        return Err(AppError::BadRequest(format!("a message must be 1-{MAX_BODY} characters")));
    }
    Ok(body)
}

// ---------------------------------------------------------------- database

pub async fn list(pool: &PgPool, project_id: Uuid, before: Option<i64>, limit: i64) -> sqlx::Result<Vec<ChatMessage>> {
    // newest first from the database (the page ends at `before`), handed back oldest first
    let mut rows = sqlx::query_as::<_, ChatMessage>(&format!(
        "SELECT {COLS} FROM chat_messages m JOIN users u ON u.id = m.author_id
         WHERE m.project_id = $1 AND ($2::bigint IS NULL OR m.id < $2)
         ORDER BY m.id DESC LIMIT $3"
    ))
    .bind(project_id)
    .bind(before)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.reverse();
    Ok(rows)
}

pub async fn get(pool: &PgPool, id: i64) -> sqlx::Result<Option<ChatMessage>> {
    sqlx::query_as::<_, ChatMessage>(&format!(
        "SELECT {COLS} FROM chat_messages m JOIN users u ON u.id = m.author_id WHERE m.id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn insert(pool: &PgPool, project_id: Uuid, author_id: i64, body: &str, link: Option<&Value>) -> sqlx::Result<ChatMessage> {
    sqlx::query_as::<_, ChatMessage>(&format!(
        "WITH m AS (
            INSERT INTO chat_messages (project_id, author_id, body, link) VALUES ($1, $2, $3, $4) RETURNING *
         )
         SELECT {COLS} FROM m JOIN users u ON u.id = m.author_id"
    ))
    .bind(project_id)
    .bind(author_id)
    .bind(body)
    .bind(link)
    .fetch_one(pool)
    .await
}

pub async fn set_body(pool: &PgPool, id: i64, body: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE chat_messages SET body = $2, edited_at = now() WHERE id = $1")
        .bind(id)
        .bind(body)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete(pool: &PgPool, id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM chat_messages WHERE id = $1").bind(id).execute(pool).await?;
    Ok(())
}

/// The last message this person has read in the project's chat (0: none).
pub async fn last_read(pool: &PgPool, project_id: Uuid, user_id: i64) -> sqlx::Result<i64> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT last_read_id FROM chat_reads WHERE project_id = $1 AND user_id = $2")
        .bind(project_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.0).unwrap_or(0))
}

/// Move the read mark forward (never back: two tabs may report out of order).
pub async fn mark_read(pool: &PgPool, project_id: Uuid, user_id: i64, id: i64) -> sqlx::Result<i64> {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO chat_reads (project_id, user_id, last_read_id) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE
           SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)
         RETURNING last_read_id",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

pub async fn unread(pool: &PgPool, project_id: Uuid, user_id: i64, after: i64) -> sqlx::Result<i64> {
    let row: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM chat_messages WHERE project_id = $1 AND id > $2 AND author_id <> $3",
    )
    .bind(project_id)
    .bind(after)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

// ---------------------------------------------------------------- access

/// The project and whoever is asking, if they may read its chat (and write in it, with `write`).
async fn chat_access(state: &AppState, viewer: &Viewer, project_id: Uuid, write: bool) -> Result<(persist::Project, access::Access), AppError> {
    let project = persist::get_project(&state.pool, project_id).await?.ok_or(AppError::NotFound)?;
    let access = access::resolve(&state.pool, viewer, project_id).await?.ok_or(AppError::Forbidden)?;
    if write && !access.can_comment() {
        return Err(if viewer.user.is_none() {
            AppError::Unauthorized
        } else {
            AppError::Api(StatusCode::FORBIDDEN, "chat_denied", "You can view this project but not write in its chat.".into())
        });
    }
    Ok((project, access))
}

/// Tell every open document of the project.
async fn announce(state: &AppState, project_id: Uuid, action: &str, message: Value) {
    let Ok(docs) = persist::project_documents(&state.pool, project_id).await else { return };
    for d in docs {
        let payload = json!({ "type": "chat", "docId": d.id, "projectId": project_id, "action": action, "message": message });
        state.doc_event(d.id, crate::doc_actor::DocMsg::Notice { payload }).await;
    }
}

// ---------------------------------------------------------------- routes

#[derive(Deserialize)]
pub struct ListQuery {
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

/// GET /api/projects/{id}/chat?before=&limit=: a page of messages, oldest first, and where the
/// caller left off.
pub async fn list_messages(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(project_id): Path<Uuid>,
    Query(q): Query<ListQuery>,
) -> AppResult<Response> {
    let (_, access) = chat_access(&state, &viewer, project_id, false).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, MAX_PAGE);
    let rows = list(&state.pool, project_id, q.before, limit + 1).await?;
    // one more than asked for says whether there is an older page
    let more = rows.len() as i64 > limit;
    let rows = if more { &rows[1..] } else { &rows[..] };
    let (last_read_id, unread_n) = match &viewer.user {
        Some(u) => {
            let lr = last_read(&state.pool, project_id, u.id).await?;
            (lr, unread(&state.pool, project_id, u.id, lr).await?)
        }
        None => (0, 0),
    };
    Ok(Json(json!({
        "messages": rows.iter().map(ChatMessage::to_json).collect::<Vec<_>>(),
        "more": more,
        "lastReadId": last_read_id,
        "unread": unread_n,
        "canWrite": access.can_comment(),
    }))
    .into_response())
}

#[derive(Deserialize)]
pub struct NewMessage {
    pub body: String,
    #[serde(default)]
    pub link: Option<LinkIn>,
}

/// POST /api/projects/{id}/chat {body, link?}
pub async fn post_message(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(project_id): Path<Uuid>,
    LenientJson(req): LenientJson<NewMessage>,
) -> AppResult<Response> {
    let _ = chat_access(&state, &viewer, project_id, true).await?;
    let user = viewer.user.clone().ok_or(AppError::Unauthorized)?;
    let body = checked_body(&req.body)?;
    let link = match &req.link {
        Some(l) => Some(checked_link(l, &persist::project_documents(&state.pool, project_id).await?)?),
        None => None,
    };
    let msg = insert(&state.pool, project_id, user.id, body, link.as_ref()).await?;
    // what you wrote yourself is read
    mark_read(&state.pool, project_id, user.id, msg.id).await?;
    let out = msg.to_json();
    announce(&state, project_id, "added", out.clone()).await;
    Ok(Json(out).into_response())
}

#[derive(Deserialize)]
pub struct EditMessage {
    pub body: String,
}

/// PATCH /api/chat/{id} {body}: its author rewrites a message.
pub async fn edit_message(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<i64>,
    LenientJson(req): LenientJson<EditMessage>,
) -> AppResult<Response> {
    let msg = get(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let _ = chat_access(&state, &viewer, msg.project_id, true).await?;
    let user = viewer.user.clone().ok_or(AppError::Unauthorized)?;
    if msg.author_id != user.id {
        return Err(AppError::Forbidden);
    }
    set_body(&state.pool, id, checked_body(&req.body)?).await?;
    let updated = get(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let out = updated.to_json();
    announce(&state, updated.project_id, "updated", out.clone()).await;
    Ok(Json(out).into_response())
}

/// DELETE /api/chat/{id}: its author, or the project's owner, takes a message back.
pub async fn delete_message(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let msg = get(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    // taking one's own words back needs no right to write new ones
    let (project, _) = chat_access(&state, &viewer, msg.project_id, false).await?;
    let user = viewer.user.clone().ok_or(AppError::Unauthorized)?;
    if msg.author_id != user.id && project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    delete(&state.pool, id).await?;
    announce(&state, msg.project_id, "deleted", json!({ "id": id, "projectId": msg.project_id })).await;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
pub struct ReadMark {
    pub id: i64,
}

/// POST /api/projects/{id}/chat/read {id}: the caller has read up to message `id`.
pub async fn mark_messages_read(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(project_id): Path<Uuid>,
    LenientJson(req): LenientJson<ReadMark>,
) -> AppResult<Response> {
    let _ = chat_access(&state, &viewer, project_id, false).await?;
    let user = viewer.user.clone().ok_or(AppError::Unauthorized)?;
    let last = mark_read(&state.pool, project_id, user.id, req.id.max(0)).await?;
    let unread_n = unread(&state.pool, project_id, user.id, last).await?;
    Ok(Json(json!({ "lastReadId": last, "unread": unread_n })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(path: &str) -> persist::Document {
        persist::Document { id: Uuid::new_v4(), project_id: Uuid::nil(), path: path.into(), doc_type: "kicad_sch".into() }
    }

    #[test]
    fn body_is_trimmed_and_bounded() {
        assert_eq!(checked_body("  hi there \n").unwrap(), "hi there");
        assert!(checked_body("   ").is_err());
        assert!(checked_body(&"x".repeat(MAX_BODY + 1)).is_err());
        assert!(checked_body(&"x".repeat(MAX_BODY)).is_ok());
    }

    #[test]
    fn link_must_name_a_project_document() {
        let docs = vec![doc("main.kicad_sch"), doc("board.kicad_pcb")];
        let ok = LinkIn { doc_id: docs[1].id, kind: "item".into(), id: Some("abc".into()), label: Some(" U3 ".into()), x: Some(5), y: None, item: None, sel: Some(vec!["abc".into(), " ".into()]), bbox: Some(vec![1, 2, 3, 4]) };
        let v = checked_link(&ok, &docs).unwrap();
        assert_eq!(v["path"], "board.kicad_pcb");
        assert_eq!(v["label"], "U3");
        assert_eq!(v["y"], 0);
        assert_eq!(v["sel"], serde_json::json!(["abc"]));
        assert_eq!(v["bbox"], serde_json::json!([1, 2, 3, 4]));

        let stranger = LinkIn { doc_id: Uuid::new_v4(), kind: "spot".into(), id: None, label: None, x: None, y: None, item: None, sel: None, bbox: None };
        assert!(checked_link(&stranger, &docs).is_err());
        let bad_kind = LinkIn { doc_id: docs[0].id, kind: "url".into(), id: Some("x".into()), label: None, x: None, y: None, item: None, sel: None, bbox: None };
        assert!(checked_link(&bad_kind, &docs).is_err());
        let pin = LinkIn { doc_id: docs[0].id, kind: "pin".into(), id: Some("pin:abc#5".into()), label: Some("U1 pin 5".into()), x: None, y: None, item: None, sel: None, bbox: None };
        assert_eq!(checked_link(&pin, &docs).unwrap()["kind"], "pin");
        let no_id = LinkIn { doc_id: docs[0].id, kind: "net".into(), id: Some("  ".into()), label: None, x: None, y: None, item: None, sel: None, bbox: None };
        assert!(checked_link(&no_id, &docs).is_err());
        let spot = LinkIn { doc_id: docs[0].id, kind: "spot".into(), id: None, label: None, x: Some(1), y: Some(2), item: None, sel: None, bbox: None };
        assert_eq!(checked_link(&spot, &docs).unwrap()["kind"], "spot");
    }
}
