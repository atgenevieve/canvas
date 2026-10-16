# Contract

What the pieces agree on, so they can be built at the same time: the shape of a capture, the API, and how the overlay,
the board and the plugin talk. The types are in [`shared/contract.ts`](../shared/contract.ts); this file says what
they mean. Change both together.

`BASE` is where the canvas Worker is routed on the app's host, `/__canvas` by default. Everything below is under it.

## Who serves what

| Path | Served by | What |
| --- | --- | --- |
| `BASE/` | Worker | the board |
| `BASE/overlay.js` | Worker | the overlay bundle, built from `client/overlay`. The Vite plugin injects `<script type="module" src="BASE/overlay.js">`, so the overlay's version always matches the Worker's |
| `BASE/api/*` | Worker | the JSON API below |
| `BASE/live` | Worker | a WebSocket: `{ "type": "thread", "id": "…" }` when a thread changes, `{ "type": "screens" }` when the board's screens change |

The overlay and the board are on the app's own origin, so they call the API with the person's Access cookie and no
CORS. The CLI calls it with the project's Access service token; the Worker records the CLI's comments as `claude`.

## A capture

Saved with a thread's first comment. Everything in it is private: it stays in D1 and R2, never in a GitHub comment.

- `element`: the element picked, or null for an area dragged out (`area`) or a point.
  - `selector`: a CSS selector that finds it again. Prefer `[data-testid]`, then `#id`, then a short
    `tag.class:nth-of-type` path from the nearest element with either.
  - `words`: its first 120 characters of visible text.
  - `component`, `source`: from the Vite plugin when present (`PersonRow › Chip`, `src/people/person-row.tsx:42`).
  - `rect`: its box in CSS pixels, relative to the page.
- `env`: URL, viewport and device pixel ratio, light or dark, user agent, the build's branch and commit, the time.
- `steps`: what you did before commenting, oldest first: the last 5 minutes or 100 steps, whichever is shorter.
  - `click`, `input`, `change`, `key`, `nav`, `scroll`, `resize` (see the types).
  - Typing in one field is one `input` step, written when the field loses focus or a different step comes.
  - `key` records only Enter, Escape, Tab, arrows, Backspace and Delete, and only outside text fields.
  - `scroll` is written once scrolling stops for 300ms, only if it moved more than 100px.
- `errors`: console errors and unhandled rejections in that window. `failed`: requests that failed (network error or
  status ≥ 400), with method, URL, status and duration, never bodies.
- `shots`: the upload ids of the element's and the screen's screenshots.

### Masking

A field's value is replaced with `{ "masked": true, "length": n }` when the field, or anything around it, is:

- `type=password` or `type=hidden`, or has `autocomplete` starting `cc-`, `new-password` or `current-password`
- marked `data-canvas-private` (on it or any ancestor)

Elements marked `data-canvas-private` also show as a solid block in screenshots, and their text is left out of
`words` and of `click` steps.

## The API

All bodies are JSON unless noted. Errors are `{ "error": "…" }` with a 4xx or 5xx status.

| Call | Body | Returns |
| --- | --- | --- |
| `GET api/threads` | | `{ me, threads: Thread[] }`, comments included, newest activity first |
| `GET api/threads/:id` | | `{ me, thread }` |
| `POST api/threads` | `NewThread` (with `capture`) | `{ thread }` |
| `POST api/threads/:id/comments` | `{ body }` | `{ thread }` |
| `POST api/threads/:id/resolve`, `…/reopen` | | `{ thread }` |
| `POST api/comments/:id/edit` | `{ body }` | `{ thread }` (author only) |
| `POST api/comments/:id/delete` | | `{ thread }` or `{ deleted: true }` (author only; the first comment takes the thread) |
| `GET api/threads/:id/capture` | | `{ capture, shots: { element?, screen? } }`: shots as `api/uploads/:id` paths; 404 if none or deleted |
| `POST api/uploads` | the image (`image/webp` or `image/png`, ≤ 5 MB) | `{ id, bytes }`. Uploaded before the thread that uses it |
| `GET api/uploads/:id` | | the image |
| `GET api/storage` | | `Storage`: the total, then every upload and capture with its size |
| `POST api/threads/:id/capture/delete` | | `{ thread }`: steps, values and shots gone, thread and comments kept |
| `POST api/threads/:id/delete` | | `{ deleted: true }`: the thread, its comments, capture and shots |
| `POST api/uploads/delete` | `{ ids }` | `{ deleted: n }` |
| `GET api/screens` | | `{ screens: Screen[] }` |
| `POST api/screens` | `NewScreen` | `{ screen }` |
| `POST api/screens/:id/edit` | `Partial<NewScreen>` | `{ screen }` |
| `POST api/screens/:id/delete` | | `{ deleted: true }` |

Nothing is deleted except by these calls. An upload no thread uses (a comment abandoned after its screenshot went up)
shows in `api/storage` with no thread.

## The board's screens

A screen is a page of the app at one or more sizes, optionally with steps that bring it to a state (a dialog open). They
live in D1, added from the overlay's toolbar ("Add to board" saves the current URL and the steps since the page loaded)
or on the board. The board shows each in a same-origin frame and, once the overlay in it says `ready`, sends it the
steps to replay.

## Board ↔ overlay messages

`window.postMessage` between the board and each framed page, same origin only (check `event.origin`). Every message is
`{ "canvas": 1, … }`.

| From | Message | Meaning |
| --- | --- | --- |
| overlay | `{ type: "ready", url }` | loaded; the board may send steps |
| board | `{ type: "replay", steps }` | replay these, then answer `replayed` |
| overlay | `{ type: "replayed", ok, failedAt? }` | done, or the index of the step that couldn't be found |
| board | `{ type: "mode", comment: boolean }` | comment mode on or off for this frame |
| overlay | `{ type: "picked", capture }` | an element picked in a frame; the board opens the comment box |
| board | `{ type: "pins", threads }` | the open threads on this page, for the overlay to draw |

Inside a frame the overlay hides its own toolbar; the board's controls stand in for it.

## The overlay on its own

Used directly on the app (not framed), the overlay shows its toolbar, a floating pill in the plugin's `corner`: comment mode (`C`), the open threads on this
page, "Add to board", and a link to the board. It records steps from the moment it loads, always, in memory only;
nothing leaves the page until you post a comment.

`window.__canvas` exposes `{ steps(), capture(el), mode(on) }` for tests.

## The PR comment

Only: the event, the thread id, the project, `component` and `source` when known, and a link to `BASE/?thread=<id>`.
Never the comment text, URL, `words`, author, steps, values or screenshots. The last line is
`<!-- canvas {"thread":"<id>","event":"<event>"} -->`.

## The Vite plugin

`canvas({ project, base?, target?, corner? })` from `@atgenevieve/canvas/vite`. `corner` is where the overlay's
toolbar sits: `'bottom-right'` (default), `'bottom-left'`, `'top-right'` or `'top-left'`; it's passed to the overlay in
`window.__CANVAS_BUILD__`.


- In `serve`, and in `build` when `CANVAS=1`: injects the overlay's script tag; adds `data-canvas-src="path:line"` to
  every host JSX element (paths relative to the project root); defines `__CANVAS_BRANCH__` and `__CANVAS_COMMIT__`.
- In `serve`, proxies `BASE/*` to `target` (the deployed canvas, or `http://localhost:8787` for `wrangler dev`).
- In a production `build` without `CANVAS=1`: does nothing.

The overlay reads the component chain from React's fiber on the element (`__reactFiber$…`), names from `type.displayName
|| type.name`, skipping anonymous and library components (`node_modules` in their `data-canvas-src`).

## `canvas.config.json` (in the app's repo)

```json
{ "project": "my-app", "url": "https://preview.example.org", "base": "/__canvas" }
```

The CLI reads it to find the canvas. Access credentials come from `CANVAS_ACCESS_CLIENT_ID` and
`CANVAS_ACCESS_CLIENT_SECRET`, or none in a cloud session whose proxy injects them.
