# Canvas: plan

A comment layer for my React + Vite + TypeScript apps on Cloudflare. It grows out of Whipsheet's review canvas
(`atgenevieve/whipsheet`, `workers/canvas/`), which put static prototype boards on an infinite canvas and sent each
comment to a pull request so a Claude session woke up and acted on it. This one works on the real app.

## What it does

1. In a dev or preview build of an app, a small toolbar sits in a corner. Turn on comment mode (or press `C`), hover to
   highlight an element, click it, write the comment.
2. The comment is saved with:
   - **The element:** a CSS selector, its text, its React component chain (`PersonRow › Chip`), its source file and
     line (`src/client/people/person-row.tsx:42`), its size and position, and a screenshot of it and of the screen.
   - **Where you were:** URL, screen size, light or dark, browser, the build's git branch and commit.
   - **How you got there:** the last ~5 minutes or ~100 actions, whichever is shorter: clicks, typing (with the values),
     route changes, scrolls that moved the page, console errors, and requests that failed.
3. Claude is woken by a comment on the pull request for that build's branch (or the project's inbox PR when the branch
   has none). That GitHub comment holds a reference code, never the content (see Privacy).
4. Claude runs `canvas show <code>` to read everything, `canvas repro <code>` to get a Playwright script that replays
   your steps, fixes the bug, and answers with `canvas reply <code> …`. Its answer shows on the pin in your app.
5. A **board** page on the canvas site shows any screens of the app side by side, live, at phone and desktop width,
   with their comment pins. A screen is a URL, a size, and optionally recorded steps to reach a state (a dialog open, a
   form half-filled), so any part of the app can be a screen.

## Privacy: nothing private reaches GitHub

Apps will hold real people's data. The rule: **GitHub only ever sees a reference code and code-level facts.**

- **The PR comment** says: what happened (new comment, reply, reopened), the thread code, the project, the component
  and source file:line, and a link to the thread. Not the comment text (it can name a person), not the URL (it can carry
  an ID), not the screenshot, steps or typed values.

  ```
  **New canvas comment** · `c7k2m9qp` · whipsheet
  - Element: `PersonRow` at `src/client/people/person-row.tsx:42`
  Run `canvas show c7k2m9qp` for the comment, the steps and the screenshot. [Open the thread](https://…)
  <!-- canvas {"thread":"c7k2m9qp","event":"new"} -->
  ```

- **Everything else** lives in the canvas service: D1 for threads, comments and steps; R2 for screenshots. Both sit
  behind Cloudflare Access. Claude reads them with the `canvas` CLI using an Access service token, the way Whipsheet's
  sessions already reach test.whipsheet.app.
- **Claude's replies** go to the canvas thread, never GitHub. The skill (below) tells Claude never to copy names,
  emails, phones, typed values or screenshots into commits, PR text, tests or fixtures, and to swap in fictional values
  when a repro becomes a committed test.
- **Never recorded:** password and payment fields (`type=password`, `autocomplete=cc-*`), and anything inside an
  element marked `data-canvas-private`, which records as "typed 12 characters". Screenshots blank those elements too.
- **Retention:** steps, typed values and screenshots are deleted 30 days after a thread is resolved (a daily cron).
  The comment text and element facts stay, so the history still reads.
- **Each project's pii-guard** (Whipsheet's `scripts/pii-guard.mjs` pattern) stays the last line of defence in its
  own repo.

## How the pieces fit

```
your app (dev / preview build)              canvas service (canvas.<domain>, behind Access)
┌──────────────────────────────┐            ┌────────────────────────────────────────────┐
│ overlay: toolbar, picker,    │ postMessage│ comment window / board page                │
│ recorder (ring buffer), pins ├───────────►│   (all API calls happen here, first-party) │
└──────────────────────────────┘            │ Worker: /api, D1, R2, Live (WebSocket)     │
   added by the Vite plugin                 │   └─► GitHub: pointer comment on the PR    │
                                            └──────────────────┬─────────────────────────┘
Claude session ◄── woken by the PR comment ────────────────────┘
   └─ canvas CLI (Access service token): show / repro / reply / resolve
```

**Why postMessage, not direct API calls from the app:** the app and the canvas are different sites. Calling an
Access-protected API from the app needs third-party cookies, which Safari blocks and Chrome is phasing out. So the
overlay never talks to the API. It hands the capture to a canvas page, either the board (when the app is framed in
it) or a small comment window it opens; that page is on the canvas's own site and makes the calls.

### Packages (one repo, npm workspaces)

| Path | What | Comes from Whipsheet |
| --- | --- | --- |
| `client/` | The package apps install (`npm i -D github:atgenevieve/canvas`): the Vite plugin, the overlay, the CLI | `app/comments.js` (pins, threads UI), `tools/comments.mjs` (CLI) |
| `worker/` | The canvas service: API, D1 migrations, R2, Live, GitHub inbox, retention cron, the board and comment pages | `src/worker.js` (most of it), `migrations/`, `app/app.js` (board pan and zoom), tests |
| `skill/` | `canvas-comment`: how Claude handles a comment; copied into each project's `.claude/skills/` | `.claude/skills/canvas-round` (rewritten generic) |
| `docs/SETUP.md` | One-time Cloudflare and GitHub setup, and adding canvas to a project | `wrangler.jsonc` comments |

`publish.mjs` and the `.dc.html` board format don't come over: boards now show the live app.

### The Vite plugin

```ts
// vite.config.ts in an app
import canvas from '@atgenevieve/canvas/vite';
export default { plugins: [react(), canvas({ project: 'whipsheet', service: 'https://canvas.example.org' })] };
```

- In `vite dev`, and in builds when `CANVAS=1` (preview and test deploys), it injects the overlay. Production builds
  get nothing.
- It adds `data-canvas-src="src/…/file.tsx:42"` to each JSX element at compile time. React 19 dropped `_debugSource`,
  so this is how a click maps to a file and line. Component names come from walking React's fiber tree.
- It bakes in the git branch and commit, so the comment reaches that branch's PR and Claude knows what code you saw.
- In preview builds it sets `frame-ancestors` to allow the canvas site, so the board can show the app.

### The service (one deployment for all projects)

One Worker, one D1 and one R2 serve every project. A `projects` table maps a project key to its GitHub repo, inbox PR
and the preview origins allowed to send captures. This departs from the earlier "template repo, one copy per project"
idea: with the app carrying the overlay, one service is less setup per project (one Access app, one token, one domain).

Tables: `projects`; `threads` (Whipsheet's, plus project, url, branch, commit, selector, component, source, viewport);
`comments` (as now); `captures` (steps JSON, environment JSON, screenshot keys, `purge_after`).

GitHub: a fine-grained token or a GitHub App per project repo, as Whipsheet's worker already supports. The PR is found
with `GET /repos/{repo}/pulls?head={owner}:{branch}&state=open`; none means the inbox PR.

### The CLI (Claude's side)

```
canvas list [--open] [--project whipsheet]
canvas show <code> [--json]          comment, element, steps, typed values, console errors; saves screenshots to a temp dir
canvas repro <code> [--fictional]    a Playwright script that replays the steps (--fictional swaps typed values for fakes)
canvas reply <code> <text|-> [--resolve]
canvas resolve <code> | reopen <code>
```

It calls the service's API with `CF-Access-Client-Id` / `CF-Access-Client-Secret` (or the proxy's injected token in a
cloud session), not `wrangler d1` as Whipsheet's tool does, so it works from any project without Cloudflare account
access.

## Build order

Each step ends deployed and usable.

1. **Scaffold and lift.** Workspaces, TypeScript, lint, tests; move Whipsheet's worker and its tests over; the pointer-
   only inbox message; the `projects` table; `docs/SETUP.md`.
2. **Point and comment.** The Vite plugin injects the overlay; picker with highlight; comment window; pins on the page
   with replies; `canvas list/show/reply/resolve`. Selector and text only.
3. **Source mapping.** `data-canvas-src`, the component chain, branch and commit, PR lookup by branch.
4. **Recorder and repro.** The ring buffer, masking, screenshots (client side, with private elements blanked),
   `canvas repro`.
5. **Board.** Screens of any part of the app at phone and desktop width, live, with pins; screens defined by recorded
   steps.
6. **Retention and polish.** The purge cron, `canvas-comment` skill, adopt in the first project.

## Open questions

1. **Domain.** Where does the service live? `canvas.whipsheet.app` is frozen with the old boards. A neutral domain
   (e.g. a subdomain of a domain you own for personal projects) fits "all my projects" better.
2. **Old Whipsheet canvas.** Leave it frozen as is (my pick), or move its threads into the new service as history?
3. **Screenshots in retention.** Delete them with the steps after 30 days (my pick), or keep them?
4. **First project to adopt it.** Whipsheet, or the new web app you're building?
