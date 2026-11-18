-- Project chat: one running conversation per project, beside the pinned review threads
-- (comments).  A message may carry a link to a place in the design (a part, a net or a spot
-- on a document), which a click in the chat brings into view.
--
--   link  {"docId": uuid, "kind": "item"|"net"|"spot", "id": text, "label": text,
--          "x": nm, "y": nm}   (null: plain text)
CREATE TABLE chat_messages (
    id         BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_id  BIGINT NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    link       JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at  TIMESTAMPTZ
);

CREATE INDEX chat_messages_project_idx ON chat_messages (project_id, id);

-- How far each person has read a project's chat: the unread badge counts what is newer.
CREATE TABLE chat_reads (
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, user_id)
);
