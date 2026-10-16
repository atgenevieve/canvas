// `npm install` runs this (the prepare script): it points git at .githooks/, so the privacy guard checks every commit.
// Only in this repository's own checkout: installed into an app (node_modules/@atgenevieve/canvas), git would find the
// app's repository above it, and its hooks are its own business.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let top = '';
try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
    // not a git checkout (a tarball install): nothing to do
}
if (top && path.resolve(top) === ROOT) execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT });
