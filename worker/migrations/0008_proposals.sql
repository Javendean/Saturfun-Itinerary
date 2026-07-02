CREATE TABLE IF NOT EXISTS proposals (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    pitch           TEXT NOT NULL,
    fits_where      TEXT NOT NULL DEFAULT '',
    neighborhood    TEXT NOT NULL DEFAULT '',
    needs_verifying INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'pending',
    created         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created DESC);
