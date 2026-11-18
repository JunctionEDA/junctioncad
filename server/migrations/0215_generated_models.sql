-- 3D models drawn from footprints (src/modelgen) when a part has no model anywhere, kept for everybody
-- under a hash of what they were drawn from.  `refined`: the datasheet has been read for this one (or
-- there is none), so it will not be drawn again.
CREATE TABLE generated_models (
    key        TEXT PRIMARY KEY,
    step       BYTEA NOT NULL,
    info       JSONB NOT NULL,
    refined    BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Package dimensions read from a datasheet for one package (its family, pin count and pitch), by
-- table parsing or a free vision model, checked against the footprint.  dims is NULL when nothing
-- that fits was found (not asked again for a month).
CREATE TABLE package_dims (
    key        TEXT PRIMARY KEY,
    datasheet  TEXT NOT NULL,
    dims       JSONB,
    how        TEXT NOT NULL,
    page       INT,
    notes      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
