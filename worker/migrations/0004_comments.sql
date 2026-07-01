CREATE TABLE IF NOT EXISTS profiles (
    device_id TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    updated   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
    id        TEXT PRIMARY KEY,
    photo_id  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    body      TEXT NOT NULL,
    created   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_photo ON comments(photo_id, created);
