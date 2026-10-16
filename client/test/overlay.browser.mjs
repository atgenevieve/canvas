// The overlay in a real browser, against examples/basic built with CANVAS=1, the built overlay bundle
// (worker/public/overlay.js; run `npm run build:overlay` first) and a small in-memory stand-in for the canvas API.
// Run by hand (not part of `npm test`):
//
//   node client/test/overlay.browser.mjs [out-dir]     # Chromium from /opt/pw-browsers/chromium, or CHROMIUM=<path>
//
// Saves screenshots at 390×844 to out-dir (a temp folder by default) and exits 1 if a check fails. Fictional data only.
/* global document, window, location */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../..');
const EXAMPLE = path.join(REPO, 'examples/basic');
const BUNDLE = path.join(REPO, 'worker/public/overlay.js');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-overlay-'));
fs.mkdirSync(outDir, { recursive: true });

// ---- the example app, built as a preview deploy would be ----
const link = path.join(EXAMPLE, 'node_modules/@atgenevieve/canvas');
if (!fs.existsSync(link)) {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(link), REPO), link, 'dir');
}
// Unminified, as client/test/vite-example.test.ts builds it: a minifier renames components (see chain.ts).
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-example-'));
process.env.CANVAS = '1';
await build({ root: EXAMPLE, logLevel: 'silent', build: { outDir: dist, emptyOutDir: true, minify: false } });

// ---- a stand-in for the canvas Worker's API ----
const ME = 'jordan@example.org';
const state = { threads: [], uploads: new Map(), screens: [], captures: new Map(), n: 0 };
const id = () => `id${(++state.n).toString().padStart(6, '0')}`;
const now = () => new Date().toISOString();

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}
async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/__canvas/overlay.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(fs.readFileSync(BUNDLE));
    }
    if (p === '/__canvas/' || p === '/board.html') {
        // a minimal board: frames the app and speaks the messages
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!doctype html><body style="margin:0"><iframe id="f" src="/" style="width:390px;height:700px;border:0"></iframe></body>');
    }
    if (p.startsWith('/__canvas/api/')) {
        const parts = p.slice('/__canvas/api/'.length).split('/');
        if (req.method === 'POST' && req.headers.origin !== `http://localhost:${server.address().port}`) return json(res, 403, { error: 'Cross-site request.' });
        if (parts[0] === 'threads' && parts.length === 1 && req.method === 'GET') return json(res, 200, { me: ME, threads: state.threads });
        if (parts[0] === 'threads' && parts.length === 1 && req.method === 'POST') {
            const { body: text, capture } = JSON.parse((await body(req)).toString());
            const el = capture.element;
            const box = el?.rect ?? capture.area ?? (capture.point && { ...capture.point, w: 0, h: 0 });
            const t = {
                id: id(), url: capture.env.url, selector: el?.selector ?? null, words: el?.words ?? null, component: el?.component ?? null,
                source: el?.source ?? null, branch: capture.env.branch ?? null, commit_sha: capture.env.commit ?? null,
                viewport: `${capture.env.viewport.w}x${capture.env.viewport.h}`, x: box?.x ?? null, y: box?.y ?? null, w: box?.w ?? null,
                h: box?.h ?? null, status: 'open', has_capture: true, created_by: ME, created_at: now(), updated_at: now(),
                resolved_by: null, resolved_at: null, comments: [],
            };
            t.comments.push({ id: id(), thread_id: t.id, author: ME, body: text, created_at: now(), edited_at: null });
            state.threads.unshift(t);
            state.captures.set(t.id, capture);
            return json(res, 200, { thread: t });
        }
        const t = state.threads.find((x) => x.id === parts[1]);
        if (parts[0] === 'threads' && t && parts[2] === 'comments') {
            const { body: text } = JSON.parse((await body(req)).toString());
            t.comments.push({ id: id(), thread_id: t.id, author: ME, body: text, created_at: now(), edited_at: null });
            return json(res, 200, { thread: t });
        }
        if (parts[0] === 'threads' && t && (parts[2] === 'resolve' || parts[2] === 'reopen')) {
            t.status = parts[2] === 'resolve' ? 'resolved' : 'open';
            return json(res, 200, { thread: t });
        }
        if (parts[0] === 'uploads' && parts.length === 1 && req.method === 'POST') {
            const bytes = await body(req);
            const u = id();
            state.uploads.set(u, { type: req.headers['content-type'], bytes });
            return json(res, 200, { id: u, bytes: bytes.length });
        }
        if (parts[0] === 'screens' && parts.length === 1 && req.method === 'POST') {
            const s = { ...JSON.parse((await body(req)).toString()), id: id(), created_at: now(), updated_at: now() };
            state.screens.push(s);
            return json(res, 200, { screen: s });
        }
        return json(res, 404, { error: 'Not found.' });
    }
    // the app: its files, else index.html
    const file = path.join(dist, p === '/' ? 'index.html' : p);
    if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        return res.end(fs.readFileSync(file));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(path.join(dist, 'index.html')));
});
await new Promise((resolve) => server.listen(0, 'localhost', resolve));
const origin = `http://localhost:${server.address().port}`;

const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok });
    console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/`);
    const host = page.locator('canvas-overlay');
    await host.waitFor({ state: 'attached' });
    const pill = page.locator('canvas-overlay .pill');
    const modeBtn = pill.getByRole('button', { name: 'Comment' });
    await pill.waitFor();
    check('the overlay loads with a pill', await pill.isVisible());
    check('the host is marked data-canvas-ui', (await host.getAttribute('data-canvas-ui')) === '');
    const pillBox = await pill.boundingBox();
    check('the pill sits bottom right', pillBox.x + pillBox.width > 360 && pillBox.y + pillBox.height > 810, JSON.stringify(pillBox));
    await page.screenshot({ path: path.join(outDir, '1-pill-idle.png') });

    // a click in the app is recorded
    await page.getByRole('button', { name: 'Save' }).click();
    const steps = await page.evaluate(() => window.__canvas.steps());
    check('the recorder has the load and the click', steps[0]?.kind === 'nav' && steps.some((s) => s.kind === 'click'), steps.map((s) => s.kind).join(','));

    // comment mode with C, hover Save
    await page.mouse.click(5, 600);
    await page.keyboard.press('c');
    check('C turns comment mode on', (await modeBtn.getAttribute('aria-pressed')) === 'true');
    const save = await page.getByRole('button', { name: 'Save' }).boundingBox();
    await page.mouse.move(save.x + save.width / 2, save.y + save.height / 2);
    const tag = page.locator('canvas-overlay .tag');
    await tag.waitFor();
    const label = await tag.textContent();
    check('the label names the component and file', label === 'App · app.tsx:26', label);
    await page.screenshot({ path: path.join(outDir, '2-comment-mode-hover-save.png') });

    // pick Save: the app's click doesn't happen; the comment box opens
    const clicksBefore = (await page.evaluate(() => window.__canvas.steps())).filter((s) => s.kind === 'click').length;
    await page.mouse.click(save.x + save.width / 2, save.y + save.height / 2);
    const box = page.getByRole('dialog', { name: 'New comment' });
    await box.waitFor();
    const clicksAfter = (await page.evaluate(() => window.__canvas.steps())).filter((s) => s.kind === 'click').length;
    check('picking does not click the app', clicksAfter === clicksBefore);
    await box.getByRole('textbox', { name: 'Comment' }).fill('Nothing happens after I tap Save');
    check('focus is in the comment box', await box.getByRole('textbox', { name: 'Comment' }).evaluate((el) => el.matches(':focus')));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    check('Tab stays in the comment box', await box.getByRole('textbox', { name: 'Comment' }).evaluate((el) => el.matches(':focus')));
    await page.screenshot({ path: path.join(outDir, '3-comment-popover.png') });
    await box.getByRole('button', { name: 'Post' }).click();
    await box.waitFor({ state: 'hidden' });
    const thread = state.threads[0];
    const capture = thread && state.captures.get(thread.id);
    check('the thread is posted with its capture', !!capture && capture.element?.selector && capture.element.component === 'App', capture?.element?.selector);
    check('the capture has the source, branch and steps', capture?.element?.source === 'src/app.tsx:26' && Array.isArray(capture.steps) && capture.steps.some((s) => s.kind === 'click'));
    check('both screenshots were uploaded', !!capture?.shots.element && !!capture?.shots.screen && state.uploads.size === 2, JSON.stringify(capture?.shots));
    check('comment mode is off after posting', (await modeBtn.getAttribute('aria-pressed')) === 'false');

    // a pin, and its thread
    const pin = page.locator('canvas-overlay .pin');
    await pin.waitFor();
    check('a pin shows on Save', (await pin.count()) === 1 && (await pin.textContent()) === '1');
    check('the pill counts one open thread', (await pill.locator('span').textContent()) === '1');
    await pin.click();
    const threadPop = page.getByRole('dialog', { name: 'Comment thread' });
    await threadPop.waitFor();
    await threadPop.getByRole('textbox', { name: 'Reply' }).fill('Also on the second tap');
    await threadPop.getByRole('button', { name: 'Reply' }).click();
    await threadPop.getByText('Also on the second tap').waitFor();
    check('a reply shows in the thread', state.threads[0].comments.length === 2);
    await page.screenshot({ path: path.join(outDir, '4-pin-thread-open.png') });
    await page.keyboard.press('Escape');
    check('Escape closes the thread', await threadPop.isHidden());

    // pins follow the page
    const pinBefore = await pin.boundingBox();
    await page.evaluate(() => {
        document.querySelector('h1').style.marginTop = '120px';
    });
    await page.waitForTimeout(300);
    const pinAfter = await pin.boundingBox();
    check('a pin moves with its element', Math.round(pinAfter.y - pinBefore.y) >= 90, `${pinBefore.y} → ${pinAfter.y}`);
    await page.evaluate(() => {
        document.querySelector('h1').style.marginTop = '';
    });

    // Add to board (long press)
    const mb = await modeBtn.boundingBox();
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    const add = page.locator('canvas-overlay').getByRole('menuitem', { name: 'Add to board' });
    await add.waitFor();
    check('a long press on 💬 does not toggle comment mode', (await modeBtn.getAttribute('aria-pressed')) === 'false');
    await add.click();
    await page.waitForTimeout(200);
    const screen = state.screens[0];
    check('Add to board saves the path, both sizes and the steps', screen?.path === '/' && screen.sizes.join() === 'phone,desktop' && screen.steps.length > 0, JSON.stringify(screen && { path: screen.path, sizes: screen.sizes, steps: screen.steps.length }));

    // resolve: the pin goes
    await pin.click();
    await threadPop.getByRole('button', { name: 'Resolve' }).click();
    await pin.waitFor({ state: 'detached' });
    check('resolving removes the pin', state.threads[0].status === 'resolved');
    state.threads[0].status = 'open';

    // drag the pill to the top left
    const pb = await pill.boundingBox();
    await page.mouse.move(pb.x + pb.width - 20, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(150, 300, { steps: 6 });
    await page.mouse.move(60, 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const dragged = await pill.boundingBox();
    check('the dragged pill snaps to the top left', dragged.x < 30 && dragged.y < 30, JSON.stringify(dragged));
    check('the corner is kept', (await page.evaluate(() => localStorage.getItem('canvas:corner'))) === 'top-left');
    check('the drag did not toggle comment mode', (await modeBtn.getAttribute('aria-pressed')) === 'false');
    await page.reload();
    await pill.waitFor();
    await pin.waitFor();
    const reloaded = await pill.boundingBox();
    check('the kept corner wins after a reload', reloaded.x < 30 && reloaded.y < 30);
    await page.screenshot({ path: path.join(outDir, '5-pill-top-left.png') });

    // an area
    await page.keyboard.press('c');
    await page.mouse.move(40, 300);
    await page.mouse.down();
    await page.mouse.move(200, 420, { steps: 5 });
    await page.mouse.up();
    await box.waitFor();
    const area = await page.evaluate(() => window.__canvas);
    check('a drag picks an area', !!area && (await box.isVisible()));
    await page.keyboard.press('Escape');
    check('Escape cancels the comment', await box.isHidden());
    await page.keyboard.press('Escape');
    check('Escape leaves comment mode', (await modeBtn.getAttribute('aria-pressed')) === 'false');
    check('no page errors', errors.length === 0, errors.join('; '));

    // framed by a board
    const board = await context.newPage();
    const fromOverlay = [];
    await board.exposeFunction('__got', (m) => fromOverlay.push(m));
    await board.addInitScript(() => window.addEventListener('message', (e) => e.data?.canvas === 1 && window.__got(e.data)));
    await board.goto(`${origin}/board.html`);
    await board.waitForFunction(() => true);
    for (let i = 0; i < 50 && !fromOverlay.some((m) => m.type === 'ready'); i++) await board.waitForTimeout(100);
    check('in a frame, the overlay says ready', fromOverlay.some((m) => m.type === 'ready'));
    const frame = board.frame({ url: `${origin}/` });
    check('in a frame, the pill is hidden', (await frame.locator('canvas-overlay .pill').count()) === 0);
    await board.evaluate(() => {
        const f = document.getElementById('f').contentWindow;
        f.postMessage({ canvas: 1, type: 'replay', steps: [{ kind: 'click', t: 0, selector: 'main > button', words: 'Save', x: 0, y: 0 }] }, location.origin);
    });
    for (let i = 0; i < 50 && !fromOverlay.some((m) => m.type === 'replayed'); i++) await board.waitForTimeout(100);
    const replayed = fromOverlay.find((m) => m.type === 'replayed');
    check('replay answers replayed, and the step ran', replayed?.ok === true && (await frame.getByRole('status').count()) === 1, JSON.stringify(replayed));
    await board.evaluate(() => {
        const f = document.getElementById('f').contentWindow;
        f.postMessage({ canvas: 1, type: 'mode', comment: true }, location.origin);
    });
    await board.waitForTimeout(100);
    const fsave = await frame.getByRole('button', { name: 'Save' }).boundingBox();
    await board.mouse.click(fsave.x + 10, fsave.y + 10);
    for (let i = 0; i < 80 && !fromOverlay.some((m) => m.type === 'picked'); i++) await board.waitForTimeout(100);
    const pickedMsg = fromOverlay.find((m) => m.type === 'picked');
    check('a pick in a frame sends picked with the capture', pickedMsg?.capture?.element?.component === 'App');
    await board.evaluate((threads) => {
        document.getElementById('f').contentWindow.postMessage({ canvas: 1, type: 'pins', threads }, location.origin);
    }, state.threads);
    await frame.locator('canvas-overlay .pin').waitFor();
    check('pins from the board are drawn', (await frame.locator('canvas-overlay .pin').count()) === 1);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(dist, { recursive: true, force: true });
}

console.info(`screenshots in ${outDir}`);
const failed = checks.filter((c) => !c.ok).length;
console.info(failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
