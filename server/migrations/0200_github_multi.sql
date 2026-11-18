-- GitHub sync: several projects in one repository, shared libraries, submodules,
-- renames and deletes (src/github.rs, src/github/remote.rs).

-- The document each synced file was, so a file renamed online is seen as the same
-- file under a new name instead of a delete plus a new file.
ALTER TABLE project_github_files ADD COLUMN IF NOT EXISTS doc_id UUID;

-- A file a pull removed because it was deleted on GitHub: its last content stays
-- here, so it can be put back from the sync page.
CREATE TABLE IF NOT EXISTS project_github_removed (
    id          BIGSERIAL PRIMARY KEY,
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    doc_type    TEXT NOT NULL,
    content     BYTEA NOT NULL,
    removed_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    removed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_github_removed_project ON project_github_removed (project_id, removed_at DESC);

-- What a file names outside itself (library table rows, sheet files, 3D models), by
-- git blob id: a blob never changes, so the file is read once to learn it.
CREATE TABLE IF NOT EXISTS github_blob_refs (
    blob_sha   TEXT PRIMARY KEY,
    refs       JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
