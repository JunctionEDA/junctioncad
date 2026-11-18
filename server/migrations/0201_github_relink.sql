-- Where a project was linked before it was unlinked.  What the last sync knew of each
-- file (project_github_files) is kept across an unlink, so that linking the project to
-- the very same place again carries on where it left off (an edit made in between is a
-- push, not a conflict); linking it anywhere else forgets it.
CREATE TABLE project_github_last (
    project_id  UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    repo_owner  TEXT NOT NULL,
    repo_name   TEXT NOT NULL,
    branch      TEXT NOT NULL,
    subdir      TEXT NOT NULL DEFAULT ''
);
