-- Product photos of vendor parts, fetched once and kept: LCSC's photo links are signed for half an
-- hour, so the link itself cannot be kept (src/parts/mod.rs, store_part).
CREATE TABLE part_images (
    vendor       TEXT NOT NULL,
    vendor_id    TEXT NOT NULL,
    content_type TEXT NOT NULL,
    bytes        BYTEA NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vendor, vendor_id)
);
