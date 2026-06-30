-- Photo wall metadata (bytes live in R2; this table is metadata only).
-- Ported verbatim from the transplant kit §6. `stored_name` is the R2 object key
-- and is NEVER exposed to clients (see _publicPhoto in the routes).
CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    has_thumb INTEGER NOT NULL DEFAULT 0,
    uploaded REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_uploaded ON photos(uploaded DESC);
