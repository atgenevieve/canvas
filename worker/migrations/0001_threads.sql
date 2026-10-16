-- A project's canvas comment threads. A thread is pinned to an element of the app (or an area dragged out on it) on one
-- page; its first comment opens it. An author is the Cloudflare Access email of the person who wrote it, or 'claude'
-- for a request made with the project's Access service token (the canvas CLI).
-- Times are UTC ISO strings from the database's own clock, so every writer agrees on their order.
--
-- Whipsheet's canvas pinned threads to boards from its layout (page, board, a CSS path inside the board's frame). Here
-- they're pinned to the live app, so those columns give way to the element's facts, all optional but the URL:
--   url         the page's URL as the browser had it. It can carry an ID, so it never reaches GitHub.
--   selector    a CSS selector for the element; words, its first words (they can name a person: never on GitHub)
--   component   its React component chain, e.g. "PersonRow › Chip"; source, its file and line ("src/a.tsx:42")
--   branch, commit_sha   what the build was built from
--   viewport    the screen size, e.g. "390x844"
--   x, y        the point on the page in CSS pixels; w, h an area's size (a thread on an element has neither)
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    selector TEXT,
    words TEXT,
    component TEXT,
    source TEXT,
    branch TEXT,
    commit_sha TEXT,
    viewport TEXT,
    x REAL,
    y REAL,
    w REAL,
    h REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_by TEXT,
    resolved_at TEXT
);

CREATE INDEX threads_updated ON threads (updated_at);

-- A comment its author has edited keeps the time of the last edit.
CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT
);

CREATE INDEX comments_thread ON comments (thread_id, created_at);
