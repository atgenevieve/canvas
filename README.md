# canvas

Comment on a live web app. Point at an element, say what's wrong, and Claude gets the element, its source file, the
steps you took and what you typed, so it can reproduce it. Private data stays out of GitHub: the pull request only
gets a pointer.

The design is in [PLAN.md](PLAN.md), what the pieces agree on in [docs/CONTRACT.md](docs/CONTRACT.md), and adding it to
a project in [docs/SETUP.md](docs/SETUP.md).

| Path | What |
| --- | --- |
| `client/src/vite/` | The Vite plugin (`@atgenevieve/canvas/vite`): injects the overlay in dev and `CANVAS=1` builds, tags JSX with `file:line`, bakes in branch and commit |
| `client/src/overlay/` | The overlay: toolbar, picker, comment box, pins, recorder, screenshots (built to `worker/public/overlay.js`) |
| `client/src/board/` | The board at `/__canvas/`: screens live at phone and desktop width, threads, storage (built to `worker/public/`) |
| `client/bin/canvas.mjs` | The `canvas` CLI, Claude's side: `list`, `show`, `repro`, `reply`, `resolve`, `reopen` |
| `worker/` | The canvas service each project deploys at `/__canvas/*`: API, D1 migrations, R2, Live, GitHub inbox |
| `skill/canvas-comment/` | How Claude handles a canvas comment; copied into each project's `.claude/skills/` |
| `examples/basic/` | A minimal app with the plugin, for the tests |
| `scripts/pii-guard.mjs` | Keeps real emails and phones out of commits (`.githooks/`, set up by `npm install`) |

## Quick start

In an app (Vite + React, on Cloudflare), the short version of [docs/SETUP.md](docs/SETUP.md):

```sh
npm i -D github:atgenevieve/canvas
```

```ts
// vite.config.ts
import canvas from '@atgenevieve/canvas/vite';
export default defineConfig({ plugins: [react(), canvas({ project: 'my-app', corner: 'bottom-right' })] });
```

Then `canvas.config.json`, a `canvas.wrangler.jsonc` deploying `node_modules/@atgenevieve/canvas/worker`, Access in
front of the preview host, and a GitHub token. Build the preview with `CANVAS=1`, press `C` on it, and comment.

## Working on canvas

```sh
npm install
npm run typecheck && npm run lint && npm test
npm run test:loop        # the whole loop: wrangler dev, the example, a fake GitHub, the CLI, in Chromium
npm run build:overlay && npm run build:board   # after changing the overlay or the board; the bundles are committed
```

`test:loop` uses Chromium at `/opt/pw-browsers/chromium` (or `CHROMIUM=<path>`). By-hand browser checks:
`node client/test/overlay.browser.mjs`, `node client/test/board.browser.mjs`, `node client/test/shots.browser.mjs`.
