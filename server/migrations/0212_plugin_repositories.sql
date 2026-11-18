-- Plugin repositories a person added in the Plugin Manager (Manage Repositories), as in KiCad's Plugin and Content
-- Manager: the address of a repository.json in KiCad's PCM format.  The catalog lists the plugins of each beside
-- KiCad's own repository.  A repository belongs to one account, like the plugins installed from it (src/pcm.rs).
CREATE TABLE IF NOT EXISTS plugin_repositories (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    name       TEXT NOT NULL,
    maintainer TEXT NOT NULL DEFAULT '',
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, url)
);
