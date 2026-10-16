# Setting up canvas in a project

For a Claude session working in an app's own repository, with nothing else to go on. It adds canvas to a Vite + React
app hosted on Cloudflare: an overlay in the app's preview build for commenting, a canvas Worker at `/__canvas/*` on the
app's preview host with its own D1 database and R2 bucket, all behind Cloudflare Access, and a GitHub token so each
comment wakes Claude on a pull request.

Placeholders, to replace everywhere below: `my-app` (the project's short name), `preview.example.org` (the preview
host, the one that should get comments), `example.org` (its Cloudflare zone), `owner/my-app` (the GitHub repository).

Some steps happen in the Cloudflare or GitHub dashboard and need the owner: they're marked **Owner**. Ask for them
together, in one message, with the exact settings given here, and carry on with the rest.

Nothing is ever deleted automatically: threads, comments, steps and screenshots stay until someone deletes them by
hand on the canvas (a thread, or just its capture, or screenshots from the Storage tab).

## What you need

- Node 20 or later, Vite 7 or 8, and `wrangler` in the app (`npm i -D wrangler` if it isn't there).
- A Cloudflare API token for wrangler (`CLOUDFLARE_API_TOKEN`) with D1 edit, R2 edit, Workers Scripts edit and Workers
  Routes edit on the account and zone, or a `wrangler login`. **Owner**, if the session has neither.
- The preview host already serving the app through Cloudflare (proxied, orange cloud) on the `example.org` zone.

## 1. Install

```sh
npm i -D github:atgenevieve/canvas
```

This gives the app the Vite plugin (`@atgenevieve/canvas/vite`), the `canvas` CLI (`npx canvas`), and, in
`node_modules/@atgenevieve/canvas/worker/`, the Worker the project deploys (its source, migrations and the built
board and overlay in `public/`).

## 2. The Vite plugin

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import canvas from '@atgenevieve/canvas/vite';

export default defineConfig({
    plugins: [react(), canvas({ project: 'my-app', corner: 'bottom-right', target: 'https://preview.example.org' })],
});
```

- `project`: the name the inbox message shows. `corner`: where the toolbar sits, `'bottom-right'` (default),
  `'bottom-left'`, `'top-right'` or `'top-left'`; a person can drag it to another corner, kept per browser.
  `target` (optional): in `vite dev`, `/__canvas/*` is proxied there, so comments from localhost land on the deployed
  canvas (with `CANVAS_ACCESS_CLIENT_ID` and `CANVAS_ACCESS_CLIENT_SECRET` in the shell, it sends the service token).
- It is on in `vite dev` and in builds made with `CANVAS=1`, and does nothing in any other build or in vitest. Build
  the preview deploy with it on, e.g. in `package.json`: `"build:preview": "CANVAS=1 vite build"`. Production stays
  as it is.
- It bakes in the branch and commit (from `CANVAS_BRANCH`/`CANVAS_COMMIT`, Cloudflare's or GitHub's CI variables, or
  git), so a comment reaches the open pull request for the branch the preview was built from.

## 3. `canvas.config.json`

At the app's repository root, committed (it holds no secrets):

```json
{ "project": "my-app", "url": "https://preview.example.org", "base": "/__canvas" }
```

The CLI finds the canvas from it, from any directory in the repo.

## 4. The canvas Worker's config

Create `canvas.wrangler.jsonc` at the app's repository root, with its paths pointed into `node_modules` (the
template, with comments on every field, is `node_modules/@atgenevieve/canvas/worker/wrangler.jsonc`):

```jsonc
{
    "$schema": "node_modules/wrangler/config-schema.json",
    // The canvas Worker for this project (github:atgenevieve/canvas, docs/SETUP.md).
    "name": "my-app-canvas",
    "main": "node_modules/@atgenevieve/canvas/worker/src/worker.ts",
    "compatibility_date": "2026-08-15",
    // the route behind Access is the only way in
    "workers_dev": false,
    "preview_urls": false,
    "routes": [{ "pattern": "preview.example.org/__canvas/*", "zone_name": "example.org" }],
    "assets": {
        "directory": "node_modules/@atgenevieve/canvas/worker/public",
        "binding": "ASSETS",
        "run_worker_first": true,
        "html_handling": "none",
        "not_found_handling": "none"
    },
    "d1_databases": [
        {
            "binding": "DB",
            "database_name": "my-app-canvas",
            "database_id": "<from step 5>",
            "migrations_dir": "node_modules/@atgenevieve/canvas/worker/migrations"
        }
    ],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "my-app-canvas-files" }],
    // Live: the WebSocket that shows replies on the pins as they come
    "durable_objects": { "bindings": [{ "name": "LIVE", "class_name": "Live" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Live"] }],
    "vars": {
        "BASE_PATH": "/__canvas",
        "PROJECT": "my-app",
        "GITHUB_REPO": "owner/my-app",
        "INBOX_PR": "<from step 8>",
        "GITHUB_APP_ID": ""
    },
    "observability": { "enabled": true }
}
```

- For a second host (a test host), add another route with the same `/__canvas/*` path; one Access app covers both.
- Add to `package.json`:
  `"canvas:deploy": "wrangler d1 migrations apply DB --remote -c canvas.wrangler.jsonc && wrangler deploy -c canvas.wrangler.jsonc"`.
- Check the config with `npx wrangler deploy --dry-run -c canvas.wrangler.jsonc`: it lists the bindings LIVE, DB,
  FILES and ASSETS.

## 5. D1 and R2

```sh
npx wrangler d1 create my-app-canvas
npx wrangler r2 bucket create my-app-canvas-files
```

Put the printed `database_id` in `canvas.wrangler.jsonc`.

## 6. Deploy

```sh
npm run canvas:deploy
```

This applies the migrations (`node_modules/@atgenevieve/canvas/worker/migrations`) and adds the route. After updating
the package (`npm i -D github:atgenevieve/canvas`), run it again: new migrations apply, and the Worker, board and
overlay update together. If the app itself is served by a Worker on a Custom Domain for this host rather than by a
route, check step 11 reaches the canvas; if it gets the app instead, serve the app on a route (`preview.example.org/*`)
so the more specific `/__canvas/*` route wins.

## 7. Cloudflare Access (**Owner**)

In Cloudflare One (Zero Trust) → Access → Applications:

1. **Add a self-hosted application** covering the whole preview host: domain `preview.example.org`, path empty (and the
   test host as a second domain, if there is one). Policy: **Allow**, the people who may comment (their emails, or an
   email domain). The app and the canvas are then both behind it.
2. **A service token for Claude**: Access → Service Auth → Service Tokens → **Create**, named `my-app-canvas-claude`.
   Copy the Client ID and Client Secret (the secret shows once).
3. In the application, **add a second policy**: action **Service Auth**, include **Service Token** →
   `my-app-canvas-claude`.

The Worker records a request made with any service token as `claude`, and a person's request by their Access email.
It turns away any request that didn't come through Access.

Then give Claude the token, never in the repo:

- **Locally**: `CANVAS_ACCESS_CLIENT_ID` and `CANVAS_ACCESS_CLIENT_SECRET` in the shell's environment. The CLI sends
  them as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- **In a Claude Code cloud session**: in the cloud environment's settings, add them as network secrets for
  `preview.example.org`, so the session's proxy adds the two headers to requests for that host; then the CLI sends
  none itself and the secret never enters the session. Where network secrets aren't offered, add
  `CANVAS_ACCESS_CLIENT_ID` and `CANVAS_ACCESS_CLIENT_SECRET` as the environment's variables instead. Either way the
  owner does it; never ask for the secret in chat.

## 8. The inbox pull request

A comment on a build from a branch with an open pull request goes to that pull request; any other (a build from `main`,
say) goes to the inbox. Open one that stays open:

```sh
git switch -c canvas/inbox && git commit --allow-empty -m "Canvas inbox" && git push -u origin canvas/inbox
gh pr create --draft --title "Canvas inbox" --body "Canvas comments arrive here as pointers. Don't merge."
```

Put its number in `INBOX_PR`. The message on it is a pointer only: the event, the thread code, the project, the
component and source file when known, and a link to the thread. Never the comment's text, the page's URL, who wrote it,
or anything typed.

## 9. GitHub token (**Owner**)

A **fine-grained personal access token**: GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate. Repository access: **Only select repositories** → `owner/my-app`. Permissions:
**Pull requests: Read and write**, nothing else. Comments then show under the owner's name. Then:

```sh
npx wrangler secret put GITHUB_TOKEN -c canvas.wrangler.jsonc
```

(Or a GitHub App installed on `owner/my-app` only, with **Pull requests: Read and write**: its App ID in
`GITHUB_APP_ID`, and its private key, the whole `.pem`, as the `GITHUB_APP_KEY` secret.)

With neither, comments are saved and nothing is posted. Deploy again after changing vars (`npm run canvas:deploy`).

## 10. The skill, and private data

Copy the skill that tells Claude how to handle a canvas comment into the app's repo, and commit it:

```sh
mkdir -p .claude/skills/canvas-comment
cp node_modules/@atgenevieve/canvas/skill/canvas-comment/SKILL.md .claude/skills/canvas-comment/
```

Mark every element that shows personal data the overlay shouldn't keep with `data-canvas-private` (a member's
contact details, notes about a person). Inside it, typed values record only their length (`typed 12 characters`),
clicks leave out its words, and screenshots show it as a solid block. Password, hidden and card fields are never
recorded, marked or not.

```tsx
<section data-canvas-private>…</section>
```

What `canvas show` prints can still name real people. Never copy a comment, a page URL, an element's words, typed
values or screenshots into commits, pull requests, tests or fixtures. If the project has no privacy guard yet, add one
like canvas's own `node_modules/@atgenevieve/canvas/scripts/pii-guard.mjs` with its `.githooks/`.

## 11. Check it

1. In a browser, open `https://preview.example.org/__canvas/`: Access asks you to sign in, then the board shows.
2. With the service token:

   ```sh
   curl -s https://preview.example.org/__canvas/api/threads \
     -H "CF-Access-Client-Id: $CANVAS_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CANVAS_ACCESS_CLIENT_SECRET"
   ```

   answers `{"me":"claude","threads":[]}` (in a cloud session with network secrets, leave out the two `-H`). An HTML
   page or a 403 means the service token policy (step 7) is missing.
3. Without the token, the same `curl` gets Access's sign-in page, not JSON.
4. `npx canvas list` says `No threads.`
5. Deploy the preview built with `CANVAS=1` and open it: the toolbar sits in its corner. Press `C`, click an element,
   write a comment, Post. Within seconds the branch's pull request (or the inbox) gets a pointer naming the thread code.
6. `npx canvas show <code>` prints the comment, the element and the steps, and saves the screenshots. Then
   `npx canvas reply <code> "Seen"`: the reply shows on the pin in the page, and nothing new appears on GitHub.
7. Delete that test thread on the board (`/__canvas/`, the thread's ⋯ → Delete on its first comment).
