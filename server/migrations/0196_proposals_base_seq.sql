-- The document's last edit when a proposal was made: an edit after it to an item the proposal changes makes the
-- proposal stale.  The server answers that for editors that cannot compare the items themselves (the desktop app).

ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS base_seq BIGINT NOT NULL DEFAULT 0;
