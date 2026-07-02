CREATE TABLE IF NOT EXISTS manga_panels (
    id           TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manga_panels_device ON manga_panels(device_id, created);

CREATE TABLE IF NOT EXISTS taste_profiles (
    device_id TEXT NOT NULL,
    domain    TEXT NOT NULL,
    data      TEXT NOT NULL,
    updated   REAL NOT NULL,
    PRIMARY KEY (device_id, domain)
);
CREATE TABLE IF NOT EXISTS taste_signals (
    id         TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    domain     TEXT NOT NULL,
    target_ref TEXT,
    signal     TEXT NOT NULL,
    created    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taste_signals ON taste_signals(device_id, domain, created);
