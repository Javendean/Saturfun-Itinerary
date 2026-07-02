CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint  TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    p256dh    TEXT NOT NULL,
    auth      TEXT NOT NULL,
    created   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_device ON push_subscriptions(device_id);
