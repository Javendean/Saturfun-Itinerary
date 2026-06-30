-- Emoji reactions: one row = one (photo, device, emoji). A device may add many emojis.
CREATE TABLE IF NOT EXISTS reactions (
    photo_id  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    emoji     TEXT NOT NULL,
    created   REAL NOT NULL,
    PRIMARY KEY (photo_id, device_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_photo ON reactions(photo_id);

-- Carry forward existing binary likes as ❤️ reactions (likes table left dormant).
INSERT OR IGNORE INTO reactions (photo_id, device_id, emoji, created)
    SELECT photo_id, device_id, '❤️', created FROM likes;
