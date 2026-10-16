-- Step 4 to 6 of PLAN.md: what was recorded with a thread, its screenshots, and the board's screens.
--
-- A thread is now started from a capture (shared/contract.ts, Capture), and threads keeps the capture's element and
-- environment facts as columns so lists and the inbox never parse JSON. Its x, y, w, h now come from the element's box
-- (rect), the area dragged out, or the point clicked, in that order.

-- A thread's capture, as the overlay sent it: steps, typed values, console errors, failed requests. Private: it never
-- reaches GitHub. bytes is the JSON's size, so the storage view can show what it takes up. Deleting it by hand
-- (POST api/threads/:id/capture/delete) keeps the thread and its comments.
CREATE TABLE captures (
    thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
    json TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

-- A screenshot in R2 (FILES, key "uploads/<id>"). It's uploaded before the thread that uses it, so thread_id and kind
-- stay empty until a capture's shots name it. If a thread ever goes without its uploads going first, they become
-- uploads with no thread (SET NULL), still listed in the storage view: nothing is deleted except by hand.
CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
    kind TEXT CHECK (kind IN ('element', 'screen')),
    bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX uploads_thread ON uploads (thread_id);

-- The board's screens: a page of the app (path), the sizes to show it at (a JSON array of "phone", "tablet",
-- "desktop"), the steps that bring it to a state (a JSON array of Step), and where it sits on the board.
CREATE TABLE screens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    sizes TEXT NOT NULL,
    steps TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
