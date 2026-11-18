-- The model file a Junction footprint names (${KICAD_COLLAB_3DMODELS}/<lib>.3dshapes/<name>.step), by that name,
-- with the offset and turn the footprint carries for it: the desktop app asks for it by name (GET /api/parts/model-file).
CREATE TABLE IF NOT EXISTS part_model_names (
    name         TEXT PRIMARY KEY,
    uuid         TEXT NOT NULL,
    model_offset TEXT NOT NULL,
    model_rotate TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
