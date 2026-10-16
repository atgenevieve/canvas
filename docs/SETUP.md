# Setting up canvas in a project

For a Claude session working in an app's own repository, with nothing else to go on. It adds canvas to an app hosted
on Cloudflare: a canvas Worker at `/__canvas/*` on the app's preview host, its own D1 database and R2 bucket, all
behind Cloudflare Access, and a GitHub token so comments wake Claude on a pull request.

Placeholders, to replace everywhere below: `my-app` (the project's short name), `preview.example.org` (the preview
host, the one that should get comments), `example.org` (its Cloudflare zone), `owner/my-app` (the GitHub repository).

Some steps happen in the Cloudflare or GitHub dashboard and need the owner: they're marked **Owner**. Ask for them
together, in one message, with the exact settings given here, and carry on with the rest.

Nothing is ever deleted automatically: threads, comments, steps and screenshots stay until someone deletes them by
hand on the canvas.

## What you need

- Node 20 or later, and `wrangler` in the app (`npm i -D wrangler` if it isn't there).
- A Cloudflare API token for wrangler (`CLOUDFLARE_API_TOKEN`) with D1 edit, R2 edit, Workers Scripts edit and Workers
  Routes edit on the account and zone, or a `wrangler login`. **Owner**, if the session has neither.
- The preview host already serving the app through Cloudflare (proxied, orange cloud) on the `example.org` zone.

## 1. Install

```sh
npm i -D github:atgenevieve/canvas
```

This gives the app the `canvas` CLI (`npx canvas`) and, in `node_modules/@atgenevieve/canvas/worker/`, the Worker the
project deploys.

## 2. The Vite plugin

The plugin (the overlay you comment with) comes in step 2 of canvas's `PLAN.md`. Once
`node_modules/@atgenevieve/canvas` has a `vite` export, add it; until then, skip this step.

```ts
// vite.config.ts
import canvas from '@atgenevieve/canvas/vite';

export default defineConfig({ plugins: [react(), canvas({ project: 'my-app' })] });
```

It does nothing in a production build. The preview build is built with `CANVAS=1` to get the overlay.

## 3. `canvas.config.json`

At the app's repository root, committed (it holds no secrets):

```json
{ "project": "my-app", "url": "https://preview.example.org", "base": "/__canvas" }
```

The CLI finds the canvas from it.

## 4. The canvas Worker's config

Create `canvas.wrangler.jsonc` at the app's repository root. It's the template at
`node_modules/@atgenevieve/canvas/worker/wrangler.jsonc` with its paths pointed into `node_modules`:

```jsonc
{
    "$schema": "node_modules/wrangler/config-schema.json",
    // The canvas Worker for this project (github:atgenevieve/canvas, docs/SETUP.md).
    "name": "my-app-canvas",
    "main": "node_modules/@atgenevieve/canvas/worker/src/worker.ts",
    "compatibility_date": "2026-08-15",
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

- `workers_dev` and `preview_urls` stay off, so Access (step 7) is the only way in.
- For a second host (a test host), add another route with the same `/__canvas/*` path; one Access app covers both.
- Add to `package.json`: `"canvas:deploy": "wrangler d1 migrations apply DB --remote -c canvas.wrangler.jsonc && wrangler deploy -c canvas.wrangler.jsonc"`.

## 5. D1 and R2

```sh
npx wrangler d1 create my-app-canvas
npx wrangler r2 bucket create my-app-canvas-files
```

Put the printed `database_id` in `canvas.wrangler.jsonc`. The bucket is for screenshots, from a later step; the
binding is there now so the Worker needn't change when they arrive.

## 6. Deploy

```sh
npm run canvas:deploy
```

This applies the migrations and adds the route. If the app itself is served by a Worker on a Custom Domain for this
host rather than by a route, check step 10 reaches the canvas; if it gets the app instead, serve the app on a route
(`preview.example.org/*`) so the more specific `/__canvas/*` route wins.

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

Then give Claude the token, never in the repo: as `CANVAS_ACCESS_CLIENT_ID` and `CANVAS_ACCESS_CLIENT_SECRET` in the
environment Claude runs in (a cloud environment's secrets, or the shell's environment locally).

## 8. The inbox pull request

Comments wake Claude by a comment on a pull request. Open one that stays open as the inbox:

```sh
git switch -c canvas/inbox && git commit --allow-empty -m "Canvas inbox" && git push -u origin canvas/inbox
gh pr create --draft --title "Canvas inbox" --body "Canvas comments arrive here as pointers. Don't merge."
```

Put its number in `INBOX_PR`. The message on it is a pointer only: the event, the thread code, the project, the
component and source file when known, and a link. Never the comment's text, the page's URL, who wrote it, or anything
typed.

## 9. GitHub sign-in (**Owner**) and secrets

Either:

- **A fine-grained personal access token**: GitHub → Settings → Developer settings → Fine-grained tokens. Repository
  access: only `owner/my-app`. Permissions: **Pull requests: Read and write**, nothing else. Comments then show under
  the owner's name. Then:

  ```sh
  npx wrangler secret put GITHUB_TOKEN -c canvas.wrangler.jsonc
  ```

- **Or a GitHub App** installed on `owner/my-app` only, with **Pull requests: Read and write**. Put its App ID in
  `GITHUB_APP_ID`, and its private key (the `.pem` GitHub downloads, pasted whole) as a secret:

  ```sh
  npx wrangler secret put GITHUB_APP_KEY -c canvas.wrangler.jsonc
  ```

With neither, comments are saved and nothing is posted. Deploy again after changing vars (`npm run canvas:deploy`).

## 10. Check it

1. In a browser, open `https://preview.example.org/__canvas/`: Access asks you to sign in, then the canvas page shows.
2. With the service token:

   ```sh
   curl -s https://preview.example.org/__canvas/api/threads \
     -H "CF-Access-Client-Id: $CANVAS_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CANVAS_ACCESS_CLIENT_SECRET"
   ```

   answers `{"me":"claude","threads":[]}`. An HTML page or a 403 means the service token policy (step 7) is missing.
3. `npx canvas list` says `No threads.`
4. Without the token, the same `curl` gets Access's sign-in page, not JSON.
5. Once the plugin is in (step 2), comment on the preview build: the inbox pull request gets a pointer within seconds,
   and `npx canvas show <code>` prints the comment. Then `npx canvas reply <code> "Seen"`: the reply shows on the pin,
   and nothing new appears on GitHub.

## Keeping private data out of the repo

What `canvas show` prints can name real people. Never copy a comment, a page URL, an element's words, typed values or
screenshots into commits, pull requests, tests or fixtures; when a repro becomes a test, swap in fictional values. If
the project has no privacy guard yet, add one like canvas's own `scripts/pii-guard.mjs` and `.githooks/`.
