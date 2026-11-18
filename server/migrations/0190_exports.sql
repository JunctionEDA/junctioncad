-- Files made for a project on the server's side and handed to a person as a link: the fabrication package an
-- assistant builds over MCP (export_fab).  A few per project are kept, for a couple of weeks.

CREATE TABLE IF NOT EXISTS project_exports (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    bytes      BYTEA NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_exports_project ON project_exports (project_id, created_at DESC);
