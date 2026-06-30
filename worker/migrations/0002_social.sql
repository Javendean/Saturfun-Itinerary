-- Photo likes: one row = one device's like of one photo (toggle via INSERT/DELETE).
CREATE TABLE IF NOT EXISTS likes (
    photo_id  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    created   REAL NOT NULL,
    PRIMARY KEY (photo_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_photo ON likes(photo_id);
