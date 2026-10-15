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
5. A **board** page on the canvas page shows any screens of the app side by side, live, at phone and desktop width,
   with their comment pins. A screen is a URL, a size, and optionally recorded steps to reach a state (a dialog open, a
   form half-filled), so any part of the app can be a screen.

## Privacy: nothing private reaches GitHub

Apps will hold real people's data. The rule: **GitHub only ever sees a reference code and code-level facts.**

- **The PR comment** says: what happened (new comment, reply, reopened), the thread code, the project, the component
  and source file:line, and a link to the thread. Not the comment text (it can name a person), not the URL (it can carry
  an ID), not the screenshot, steps or typed values.

  ```
  **New canvas comment** · `c7k2m9qp` · my-app
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
- **Nothing is deleted automatically.** You delete by hand on the canvas: a whole thread, or just its recorded steps,
  typed values and screenshots (the comment and element facts stay). Claude can't delete.
- **Each project's pii-guard** (Whipsheet's `scripts/pii-guard.mjs` pattern) stays the last line of defence in its
  own repo.

## How the pieces fit

```
your app's preview host (behind Access)
┌──────────────────────────────┐   same     ┌────────────────────────────────────────────┐
│ overlay: toolbar, picker,    │   origin   │ canvas Worker at /__canvas/*               │
│ recorder (ring buffer), pins ├───────────►│   /api, board page, D1, R2, Live           │
└──────────────────────────────┘            │   └─► GitHub: pointer comment on the PR    │
   added by the Vite plugin                 └──────────────────┬─────────────────────────┘
Claude session ◄── woken by the PR comment ────────────────────┘
   └─ canvas CLI (Access service token): show / repro / reply / resolve
```

**Same site as the app.** Each project deploys its own canvas, inside wherever that project is hosted. On Cloudflare
that's a canvas Worker routed at `/__canvas/*` on the app's own preview and test hosts, with one Access app covering
both. Because the overlay and the API share the app's origin, the overlay calls the API directly: no third-party
cookies (which Safari blocks), no CORS, no second domain.

### Packages (one repo, npm workspaces)

| Path | What | Comes from Whipsheet |
| --- | --- | --- |
| `client/` | The package apps install (`npm i -D github:atgenevieve/canvas`): the Vite plugin, the overlay, the CLI | `app/comments.js` (pins, threads UI), `tools/comments.mjs` (CLI) |
| `worker/` | The canvas service each project deploys: API, D1 migrations, R2, Live, GitHub inbox, the board page | `src/worker.js` (most of it), `migrations/`, `app/app.js` (board pan and zoom), tests |
| `skill/` | `canvas-comment`: how Claude handles a comment; copied into each project's `.claude/skills/` | `.claude/skills/canvas-round` (rewritten generic) |
| `docs/SETUP.md` | Adding canvas to a project: its Worker, route, D1, R2, Access, GitHub token | `wrangler.jsonc` comments |

`publish.mjs` and the `.dc.html` board format don't come over: boards now show the live app.

### The Vite plugin

```ts
// vite.config.ts in an app
import canvas from '@atgenevieve/canvas/vite';
export default { plugins: [react(), canvas({ project: 'my-app' })] };
```

- In `vite dev`, and in builds when `CANVAS=1` (preview and test deploys), it injects the overlay. Production builds
  get nothing.
- It adds `data-canvas-src="src/…/file.tsx:42"` to each JSX element at compile time. React 19 dropped `_debugSource`,
  so this is how a click maps to a file and line. Component names come from walking React's fiber tree.
- It bakes in the git branch and commit, so the comment reaches that branch's PR and Claude knows what code you saw.
- In `vite dev`, it proxies `/__canvas/*` to the project's deployed canvas (or a local `wrangler dev` one), so
  comments from localhost land in the same place.

### The service (one deployment per project)

Each project deploys its own canvas Worker, D1 and R2 next to the app, from `worker/` with the project's settings
(repo, inbox PR, route) in its own wrangler config. On Cloudflare it's a route on the app's zone; another host later
would get its own adapter, with the API kept host-neutral. A project's comments, steps and screenshots never share a
database with another project's.

Tables: `threads` (Whipsheet's, plus url, branch, commit, selector, component, source, viewport);
`comments` (as now); `captures` (steps JSON, environment JSON, screenshot keys).

GitHub: a fine-grained token or a GitHub App for the project's repo, as Whipsheet's worker already supports. The PR is found
with `GET /repos/{repo}/pulls?head={owner}:{branch}&state=open`; none means the inbox PR.

### The CLI (Claude's side)

```
canvas list [--open]                 the project's canvas, from its canvas.config.json
canvas show <code> [--json]          comment, element, steps, typed values, console errors; saves screenshots to a temp dir
canvas repro <code> [--fictional]    a Playwright script that replays the steps (--fictional swaps typed values for fakes)
canvas reply <code> <text|-> [--resolve]
canvas resolve <code> | reopen <code>
```

It calls the service's API with `CF-Access-Client-Id` / `CF-Access-Client-Secret` (or the proxy's injected token in a
cloud session), not `wrangler d1` as Whipsheet's tool does, so it works without Cloudflare account access.

## Build order

Each step ends deployed and usable.

1. **Scaffold and lift.** Workspaces, TypeScript, lint, tests; move Whipsheet's worker and its tests over; the pointer-
   only inbox message; `docs/SETUP.md`.
2. **Point and comment.** The Vite plugin injects the overlay; picker with highlight; comment box; pins on the page
   with replies; `canvas list/show/reply/resolve`. Selector and text only.
3. **Source mapping.** `data-canvas-src`, the component chain, branch and commit, PR lookup by branch.
4. **Recorder and repro.** The ring buffer, masking, screenshots (client side, with private elements blanked),
   `canvas repro`.
5. **Board.** Screens of any part of the app at phone and desktop width, live, with pins; screens defined by recorded
   steps.
6. **Delete and polish.** Delete a thread or just its capture, the `canvas-comment` skill, and a `docs/SETUP.md` a Claude session in the app's own repo can follow start to finish.

## Decided

- Deployed per project, inside the project's own hosting.
- Whipsheet's canvas stays frozen as it is.
- Nothing is deleted automatically; you delete threads or captures by hand.
- The new web app adopts it first, set up by a session in its own repo from `docs/SETUP.md`.
