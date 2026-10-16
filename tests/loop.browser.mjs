// The whole loop, end to end, as a project runs it: `npm run test:loop` (Chromium from /opt/pw-browsers/chromium, or
// CHROMIUM=<path>; under a minute).
//
//   - the canvas Worker under `wrangler dev` (tests/loop/wrangler.jsonc): local D1 (migrated with `wrangler d1
//     migrations apply DB --local`), R2 and Live, with GitHub pointed (GITHUB_API) at a fake that records what's posted
//   - examples/basic built with CANVAS=1, served with the Worker on one origin by a small proxy that stands in for
//     Cloudflare Access: a browser is signed in as owner@example.org, the CLI's service token becomes Access's JWT
//   - Playwright types into a field, clicks around, comments on the Save button; then the CLI shows, repros and
//     replies; the generated repro runs against the example; the board and its storage tab show and delete the capture.
//
// Exits 1 if a check fails. Fictional data only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(REPO, 'examples/basic');
const CONFIG = path.join(REPO, 'tests/loop/wrangler.jsonc');
// the generated repro runs from here, inside the checkout, so it finds @playwright/test (gitignored)
const RUN = path.join(REPO, 'tests/loop/.run');
const BIN = (name) => path.join(REPO, 'node_modules/.bin', name);
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';

const OWNER = 'owner@example.org';
const TOKEN = { id: 'loop-test.access', secret: 'loop-test-secret' };
const TYPED = 'Call Jordan at 555-0142';
const COMMENT = 'Save does nothing after I type a note for Jordan';
const REPLY = 'Fixed: Save now keeps the note';
const PAGE_PATH = '/?person=4821';

const started = Date.now();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-loop-'));
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok });
    console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`);
}
const children = [];
const servers = [];
let browser = null;

async function freePort() {
    const s = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
}

async function until(what, fn, ms = 10000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
        await new Promise((r) => setTimeout(r, 100));
    }
}

// async: the proxy and the fake GitHub run in this process, so a child that calls them must not block it
function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('close', (code) => resolve({ code, out, err }));
    });
}

const listen = async (server) => {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return server.address().port;
};

try {
    // ---- a fake GitHub API: no pull request for the branch, so comments go to the inbox PR (7) ----
    const github = [];
    const githubPort = await listen(
        http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                github.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
                res.setHeader('content-type', 'application/json');
                if (req.method === 'GET' && req.url.startsWith('/repos/owner/canvas-example/pulls?')) return res.end('[]');
                if (req.method === 'POST' && req.url === '/repos/owner/canvas-example/issues/7/comments') {
                    res.statusCode = 201;
                    return res.end(JSON.stringify({ id: github.length }));
                }
                res.statusCode = 404;
                res.end('{"message":"Not Found"}');
            });
        }),
    );

    // ---- the example app, built as a preview deploy is ----
    const link = path.join(EXAMPLE, 'node_modules/@atgenevieve/canvas');
    if (!fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(link), REPO), link, 'dir');
    }
    const appDir = path.join(tmp, 'app');
    Object.assign(process.env, { CANVAS: '1', CANVAS_BRANCH: 'feature/notes', CANVAS_COMMIT: '0123456789abcdef0123456789abcdef01234567' });
    await build({ root: EXAMPLE, logLevel: 'silent', build: { outDir: appDir, emptyOutDir: true } });

    // ---- the canvas Worker under wrangler dev ----
    const persist = path.join(tmp, 'wrangler');
    const wenv = { WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };
    const mig = await run(BIN('wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '-c', CONFIG, '--persist-to', persist], { env: wenv, cwd: REPO });
    if (mig.code !== 0) throw new Error('migrations: ' + mig.out + mig.err);
    const wranglerPort = await freePort();
    const wrangler = spawn(
        BIN('wrangler'),
        ['dev', '-c', CONFIG, '--persist-to', persist, '--ip', '127.0.0.1', '--port', String(wranglerPort), '--inspector-port', String(await freePort()),
            '--var', 'GITHUB_TOKEN:loop-test-github-token', '--var', `GITHUB_API:http://127.0.0.1:${githubPort}`],
        { cwd: REPO, env: { ...process.env, ...wenv }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(wrangler);
    let wlog = '';
    wrangler.stdout.on('data', (d) => (wlog += d));
    wrangler.stderr.on('data', (d) => (wlog += d));
    await until('wrangler dev', () => /Ready on/.test(wlog), 30000).catch((e) => {
        throw new Error(e.message + '\n' + wlog);
    });

    // ---- one origin: the app's files, and /__canvas/* through a stand-in for Cloudflare Access ----
    const accessHeaders = (headers) => {
        const out = {};
        for (const [k, v] of Object.entries(headers)) if (!k.startsWith('cf-access-')) out[k] = v;
        if (headers['cf-access-client-id'] === TOKEN.id && headers['cf-access-client-secret'] === TOKEN.secret) {
            const claims = Buffer.from(JSON.stringify({ common_name: TOKEN.id, type: 'app' })).toString('base64url');
            out['cf-access-jwt-assertion'] = ['e30', claims, 'sig'].join('.');
        } else out['cf-access-authenticated-user-email'] = OWNER;
        return out;
    };
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    const proxy = http.createServer((req, res) => {
        if (req.url.startsWith('/__canvas')) {
            const up = http.request({ host: '127.0.0.1', port: wranglerPort, method: req.method, path: req.url, headers: accessHeaders(req.headers) }, (r) => {
                res.writeHead(r.statusCode, r.headers);
                r.pipe(res);
            });
            up.on('error', () => res.destroy());
            req.pipe(up);
            return;
        }
        const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = path.join(appDir, p);
        if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(appDir, 'index.html');
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    // Live's WebSocket
    proxy.on('upgrade', (req, socket, head) => {
        const up = net.connect(wranglerPort, '127.0.0.1', () => {
            const headers = accessHeaders(req.headers);
            up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
            up.write(head);
            up.pipe(socket).pipe(up);
        });
        up.on('error', () => socket.destroy());
        socket.on('error', () => up.destroy());
    });
    const port = await listen(proxy);
    const origin = `http://localhost:${port}`;

    // the app's repo, as Claude's session sees it
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'canvas.config.json'), JSON.stringify({ project: 'canvas-example', url: origin, base: '/__canvas' }));
    const cliEnv = { CANVAS_ACCESS_CLIENT_ID: TOKEN.id, CANVAS_ACCESS_CLIENT_SECRET: TOKEN.secret, TMPDIR: tmp, CANVAS_URL: '' };
    const canvas = (...args) => run(process.execPath, [path.join(REPO, 'client/bin/canvas.mjs'), ...args], { cwd: project, env: cliEnv });

    // ---- a person uses the app, then comments ----
    browser = await chromium.launch({ executablePath: CHROMIUM });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + PAGE_PATH);
    await page.locator('canvas-overlay').getByRole('toolbar', { name: 'Canvas' }).waitFor();
    await page.getByRole('textbox', { name: 'Note' }).fill(TYPED);
    await page.getByRole('heading', { name: 'People' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('status').waitFor();
    await page.keyboard.press('c');
    const save = await page.getByRole('button', { name: 'Save' }).boundingBox();
    await page.mouse.move(save.x + 5, save.y + 5);
    await page.mouse.click(save.x + 10, save.y + 10);
    const box = page.getByRole('dialog', { name: 'New comment' });
    await box.getByRole('textbox', { name: 'Comment' }).fill(COMMENT);
    await box.getByRole('button', { name: 'Post' }).click();
    const pin = page.locator('canvas-overlay .pin');
    await pin.waitFor({ timeout: 15000 });
    check('the comment posts and its pin shows', (await pin.count()) === 1);

    // ---- GitHub gets a pointer, nothing more ----
    const posted = await until('the inbox comment', () => {
        const p = github.filter((g) => g.method === 'POST');
        return p.length ? p : null;
    });
    await new Promise((r) => setTimeout(r, 300));
    const comments = github.filter((g) => g.method === 'POST');
    check('GitHub gets exactly one comment, on the inbox PR', comments.length === 1 && posted[0].url.endsWith('/issues/7/comments'), JSON.stringify(github.map((g) => g.method + ' ' + g.url)));
    check('it is posted with the GitHub token', posted[0].auth === 'Bearer loop-test-github-token');
    const pointer = posted[0].body.body;
    const id = /<!-- canvas \{"thread":"([a-z0-9]{8})","event":"new"\} -->/.exec(pointer)?.[1];
    check('the pointer names the thread', !!id && pointer.includes('`canvas show ' + id + '`'), pointer);
    check('and the component and source', pointer.includes('`App`') && pointer.includes('`src/app.tsx:26`'), pointer);
    const leaks = [COMMENT, 'Save does nothing', TYPED, '555-0142', 'person=4821', 'Jordan', OWNER, origin + '/?', 'feature/notes'].filter((s) => pointer.includes(s));
    check('no comment text, page URL, author or typed value on GitHub', leaks.length === 0, leaks.join(', '));

    // ---- Claude: canvas show ----
    const shown = await canvas('show', id);
    check('canvas show runs', shown.code === 0, shown.err);
    check('canvas show prints the comment', shown.out.includes(COMMENT));
    check('canvas show prints the steps with the typed value', shown.out.includes('type "' + TYPED + '" into Note') && /click "Save"/.test(shown.out), shown.out);
    check('canvas show prints the page and the build', shown.out.includes(PAGE_PATH) && shown.out.includes('feature/notes @ 0123456789ab'));
    const shots = [...shown.out.matchAll(/^\s+(element|screen):\s+(\S+)$/gm)].map((m) => m[2]);
    check('canvas show saves both screenshots', shots.length === 2 && shots.every((f) => fs.existsSync(f) && fs.statSync(f).size > 100), shots.join(' '));

    // ---- canvas repro --fictional, and the test it writes runs against the example ----
    fs.rmSync(RUN, { recursive: true, force: true });
    fs.mkdirSync(RUN, { recursive: true });
    const spec = path.join(RUN, 'repro.spec.ts');
    const repro = await canvas('repro', id, '--fictional', '--out', spec);
    check('canvas repro --fictional writes a test', repro.code === 0 && fs.existsSync(spec), repro.err);
    const source = fs.readFileSync(spec, 'utf8');
    check('the repro has no typed value', !source.includes(TYPED) && !source.includes('555-0142'), source);
    check('the repro fills the field, clicks Save and ends at its TODO', /\.fill\('/.test(source) && source.includes("'Save'") && source.includes('// TODO'));
    fs.writeFileSync(
        path.join(RUN, 'playwright.config.mjs'),
        `export default { testDir: '.', outputDir: './results', reporter: 'line', timeout: 20000, use: { launchOptions: { executablePath: ${JSON.stringify(CHROMIUM)} } } };\n`,
    );
    const pw = await run(BIN('playwright'), ['test', '-c', path.join(RUN, 'playwright.config.mjs')], { cwd: RUN, env: { BASE_URL: origin, CI: '1' } });
    check('the generated repro passes against the example', pw.code === 0, (pw.out + pw.err).slice(-1500));

    // ---- canvas reply shows on the pin, live; nothing new on GitHub ----
    await pin.click();
    const thread = page.getByRole('dialog', { name: 'Comment thread' });
    await thread.waitFor();
    const reply = await canvas('reply', id, REPLY);
    check('canvas reply runs', reply.code === 0, reply.err);
    await thread.getByText(REPLY).waitFor({ timeout: 10000 }).catch(() => {});
    check('the reply shows on the pin in the page, live', (await thread.getByText(REPLY).count()) === 1);
    check('the reply is Claude’s', (await thread.getByText('Claude', { exact: true }).count()) === 1);
    await new Promise((r) => setTimeout(r, 500));
    check("Claude's reply posts nothing to GitHub", github.filter((g) => g.method === 'POST').length === 1);

    // ---- the page goes on the board; its frame's overlay draws the pin, numbered as the board's list ----
    await page.keyboard.press('Escape');
    await page.locator('canvas-overlay').getByRole('button', { name: 'Comment', exact: true }).click({ button: 'right' });
    await page.locator('canvas-overlay').getByRole('menuitem', { name: 'Add to board' }).click();
    await page.locator('canvas-overlay .toast').waitFor();

    // ---- the board shows the thread ----
    const board = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    board.on('pageerror', (e) => errors.push(e.message));
    await board.goto(origin + '/__canvas/?thread=' + id);
    await board.locator('.thread.selected').waitFor();
    const text = await board.locator('.thread.selected').innerText();
    check('the board shows the thread, with the reply', text.includes(COMMENT) && text.includes(REPLY));
    const framed = board.frameLocator('.frame iframe').first().locator('canvas-overlay .pin');
    await framed.waitFor({ timeout: 10000 }).catch(() => {});
    check('the framed page draws the pin, numbered as in the list', (await framed.count()) === 1 && (await framed.textContent()) === (await board.locator('.thread.selected .num').textContent()));
    check('the board draws no pin of its own', (await board.locator('#pins .pin').count()) === 0);

    // ---- storage lists its screenshots; deleting the capture there removes them ----
    await board.locator('#tab-storage').click();
    await board.locator('#st-rows tr').nth(2).waitFor();
    const kinds = (await board.locator('#st-rows tr td:nth-child(4)').allTextContents()).sort();
    check('storage lists the element and screen shots and the recording', kinds.join() === 'Element,Recording,Screen', kinds.join());
    await board.locator('#st-rows tr', { hasText: 'Recording' }).getByRole('checkbox').check();
    await board.locator('#st-delete').click();
    await board.locator('#confirm-yes').click();
    await until('storage to empty', async () => (await board.locator('#st-rows tr').count()) === 0).catch(() => {});
    check('deleting the capture removes it and its screenshots', (await board.locator('#st-rows tr').count()) === 0);
    const after = await canvas('show', id);
    check('canvas show then has the comment but no capture', after.code === 0 && after.out.includes(COMMENT) && !after.out.includes('Steps') && !after.out.includes('Screenshots'), after.out);
    check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
    check('the loop runs', false, e instanceof Error ? e.stack : String(e));
} finally {
    await browser?.close().catch(() => {});
    for (const c of children) c.kill('SIGTERM');
    for (const s of servers) {
        s.closeAllConnections?.();
        s.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(RUN, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok).length;
console.info(`${failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks passed`} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
