-- Changes an assistant proposes over MCP (propose_changes) for a person to preview and accept or reject in the
-- editor.  Nothing in the design changes until someone with edit access accepts; the outcome is kept so the
-- assistant can read it back.

CREATE TABLE IF NOT EXISTS design_proposals (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    app        TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL,
    rationale  TEXT NOT NULL DEFAULT '',
    body       JSONB NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ,
    reason     TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_proposals_doc ON design_proposals (doc_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS design_proposals_project ON design_proposals (project_id, created_at DESC);
