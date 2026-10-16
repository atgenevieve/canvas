# canvas

Comment on a live web app. Point at an element, say what's wrong, and Claude gets the element, its source file, the
steps you took and what you typed, so it can reproduce it. Private data stays out of GitHub.

The design is in [PLAN.md](PLAN.md); adding it to a project, in [docs/SETUP.md](docs/SETUP.md).

| Path | What |
| --- | --- |
| `worker/` | The canvas service each project deploys at `/__canvas/*`: API, D1 migrations, GitHub inbox |
| `client/` | What apps use: the `canvas` CLI now; the Vite plugin and overlay next |
| `scripts/pii-guard.mjs` | Keeps real emails and phones out of commits (`.githooks/`, set up by `npm install`) |

```sh
npm install
npm run typecheck
npm run lint
npm test
```
