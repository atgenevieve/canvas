// The board page in a real browser. Run by hand (not part of `npm test`):
//
//   npm run build:board && node client/test/board.browser.mjs [out-dir]   # Chromium from /opt/pw-browsers/chromium, or CHROMIUM=<path>
//
// Builds examples/basic with CANVAS=1, serves it with the built board (worker/public) at /__canvas/, a mock of the API
// kept in memory, and a stub overlay that answers `ready`, `replay` and `mode` and sends `picked` on a click in comment
// mode. Then drives the board at 1280×800 and 390×844, checks it, and saves screenshots to out-dir (default: a temp
// folder). Exits 1 if a check fails. Fictional data only.
/* global document */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../..');
const EXAMPLE = path.join(REPO, 'examples/basic');
const PUBLIC = path.join(REPO, 'worker/public');
const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-board-'));
fs.mkdirSync(outDir, { recursive: true });

if (!fs.existsSync(path.join(PUBLIC, 'board.js'))) {
    console.error('Run `npm run build:board` first.');
    process.exit(1);
}

// ---- the example app, built as a preview deploy would be ----
const link = path.join(EXAMPLE, 'node_modules/@atgenevieve/canvas');
if (!fs.existsSync(link)) {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(link), REPO), link, 'dir');
}
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-board-app-'));
process.env.CANVAS = '1';
await build({ root: EXAMPLE, logLevel: 'silent', build: { outDir: appDir, emptyOutDir: true } });

// ---- the stub overlay: just enough of the contract for the board ----
const overlay = `(() => {
  if (window.parent === window) return;
  let comment = false;
  const send = (m) => parent.postMessage({ canvas: 1, ...m }, location.origin);
  const sel = (el) => { const p = []; for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) { const same = [...n.parentElement.children].filter((s) => s.localName === n.localName); p.unshift(n.localName + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : '')); } return 'body > ' + p.join(' > '); };
  addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || !ev.data || ev.data.canvas !== 1) return;
    const d = ev.data;
    if (d.type === 'mode') { comment = d.comment; document.documentElement.style.cursor = comment ? 'crosshair' : ''; }
    if (d.type === 'pins') window.__pins = { found: d.threads.filter((t) => { try { return !!document.querySelector(t.selector); } catch { return false; } }).length, numbers: d.numbers, selected: d.selected };
    if (d.type === 'replay') {
      for (let i = 0; i < d.steps.length; i++) {
        const s = d.steps[i];
        const el = s.selector && document.querySelector(s.selector);
        if (!el) return send({ type: 'replayed', ok: false, failedAt: i });
        if (s.kind === 'click') el.click();
      }
      send({ type: 'replayed', ok: true });
    }
  });
  document.addEventListener('click', (ev) => {
    if (!comment) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = ev.target;
    const r = el.getBoundingClientRect();
    send({ type: 'picked', capture: {
      version: 1,
      element: { selector: sel(el), words: (el.textContent || '').trim().slice(0, 120), tag: el.localName, component: 'App › ' + el.localName, source: el.getAttribute('data-canvas-src') || undefined, rect: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } },
      env: { url: location.href, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, scheme: 'light', userAgent: navigator.userAgent, at: new Date().toISOString() },
      steps: [], errors: [], failed: [], shots: {},
    } });
  }, true);
  const ready = () => setTimeout(() => send({ type: 'ready', url: location.href }), 50);
  if (document.readyState === 'complete') ready(); else addEventListener('load', ready);
})();`;

// ---- the mock API, in memory ----
const ME = 'jordan@example.org';
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
let origin = '';
let seq = 0;
const db = { threads: [], screens: [], uploads: [], captures: [] };

function comment(threadId, author, body, minAgo) {
    return { id: 'c' + ++seq, thread_id: threadId, author, body, created_at: iso(minAgo), edited_at: null };
}
function thread(id, o) {
    const t = {
        id,
        url: origin + o.path,
        selector: o.selector,
        words: o.words,
        component: o.component,
        source: 'src/app.tsx:10',
        branch: 'main',
        commit_sha: 'abc1234',
        viewport: o.viewport || '390x844',
        x: 0, y: 0, w: 0, h: 0,
        status: o.status || 'open',
        has_capture: true,
        created_by: o.comments[0][0],
        created_at: iso(o.comments[0][2]),
        updated_at: iso(o.comments[o.comments.length - 1][2]),
        resolved_by: o.status === 'resolved' ? ME : null,
        resolved_at: o.status === 'resolved' ? iso(1) : null,
        comments: [],
    };
    t.comments = o.comments.map(([a, b, m]) => comment(id, a, b, m));
    return t;
}
function seed() {
    db.threads = [
        thread('t1', {
            path: '/',
            selector: 'li.person:nth-of-type(2)',
            words: 'Ruth Adeyemi ruth@example.org',
            component: 'PersonRow',
            comments: [
                [ME, 'Ruth’s email wraps under her name on a phone', 12],
                ['claude', 'Reproduced at 390px. Fixing in src/app.tsx.', 2],
            ],
        }),
        thread('t2', { path: '/?tab=settings', selector: 'button', words: 'Save', component: 'App › button', viewport: '1440x900', comments: [[ME, 'Nothing happens after I tap Save', 60]] }),
        thread('t3', { path: '/', selector: 'h1', words: 'People', component: 'App › h1', status: 'resolved', comments: [['ruth@example.org', 'The heading could be bigger', 3000]] }),
    ];
    db.screens = [
        { id: 's1', name: 'People', path: '/', sizes: ['phone', 'desktop'], steps: [], x: 0, y: 0 },
        { id: 's2', name: 'Settings', path: '/?tab=settings', sizes: ['desktop'], steps: [{ t: now, kind: 'click', selector: '#settings-tab', words: 'Settings', x: 0, y: 0 }], x: 430, y: 1000 },
        { id: 's3', name: 'Saved', path: '/?state=saved', sizes: ['phone'], steps: [{ t: now, kind: 'click', selector: 'button', words: 'Save', x: 0, y: 0 }], x: 0, y: 1000 },
    ].map((s) => ({ ...s, created_at: iso(100), updated_at: iso(100) }));
    db.uploads = [
        { id: 'u1', thread_id: 't1', bytes: 1_800_000, created_at: iso(12) },
        { id: 'u2', thread_id: 't1', bytes: 420_000, created_at: iso(12) },
        { id: 'u3', thread_id: 't3', bytes: 1_600_000, created_at: iso(3000) },
        { id: 'u4', thread_id: null, bytes: 1_500_000, created_at: iso(4000) },
    ];
    db.captures = [
        { thread_id: 't1', bytes: 38_000, created_at: iso(12) },
        { thread_id: 't3', bytes: 24_000, created_at: iso(3000) },
    ];
}

const calls = [];
function storage() {
    const items = [
        ...db.uploads.map((u, i) => ({ kind: 'shot', shot_kind: u.thread_id ? (i % 2 ? 'element' : 'screen') : null, id: u.id, thread_id: u.thread_id, bytes: u.bytes, created_at: u.created_at })),
        ...db.captures.map((c) => ({ kind: 'capture', shot_kind: null, id: c.thread_id, thread_id: c.thread_id, bytes: c.bytes, created_at: c.created_at })),
    ].sort((a, b) => b.bytes - a.bytes);
    return { total: { bytes: items.reduce((n, i) => n + i.bytes, 0), shots: db.uploads.length, captures: db.captures.length }, items };
}
const thumb = (id) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="250"><rect width="390" height="250" fill="#eef2ff"/><rect x="20" y="20" width="${120 + (id.charCodeAt(1) % 5) * 40}" height="20" rx="4" fill="#c7d2fe"/><rect x="20" y="60" width="350" height="12" rx="4" fill="#e0e7ff"/><rect x="20" y="84" width="300" height="12" rx="4" fill="#e0e7ff"/></svg>`;

async function api(method, parts, body) {
    const [kind, id, action] = parts;
    const t = db.threads.find((x) => x.id === id);
    if (method === 'GET') {
        if (kind === 'threads' && !id) return [200, { me: ME, threads: db.threads }];
        if (kind === 'threads' && t) return [200, { me: ME, thread: t }];
        if (kind === 'screens') return [200, { screens: db.screens }];
        if (kind === 'storage') return [200, storage()];
        return [404, { error: 'Not found.' }];
    }
    calls.push(method + ' ' + parts.join('/'));
    if (kind === 'threads' && !id) {
        const nt = { ...thread('t' + ++seq, { path: '/', selector: body.capture.element?.selector, words: body.capture.element?.words, component: body.capture.element?.component, comments: [[ME, body.body, 0]] }) };
        nt.url = body.capture.env.url;
        db.threads.unshift(nt);
        return [200, { thread: nt }];
    }
    if (kind === 'threads' && t && action === 'comments') {
        t.comments.push(comment(t.id, ME, body.body, 0));
        t.updated_at = new Date().toISOString();
        return [200, { thread: t }];
    }
    if (kind === 'threads' && t && (action === 'resolve' || action === 'reopen')) {
        t.status = action === 'resolve' ? 'resolved' : 'open';
        t.updated_at = new Date().toISOString();
        return [200, { thread: t }];
    }
    if (kind === 'threads' && t && action === 'capture') {
        db.captures = db.captures.filter((c) => c.thread_id !== t.id);
        db.uploads = db.uploads.filter((u) => u.thread_id !== t.id);
        t.has_capture = false;
        return [200, { thread: t }];
    }
    if (kind === 'uploads' && id === 'delete') {
        const before = db.uploads.length;
        db.uploads = db.uploads.filter((u) => !body.ids.includes(u.id));
        return [200, { deleted: before - db.uploads.length }];
    }
    if (kind === 'screens' && !id) {
        const s = { ...body, id: 's' + ++seq, created_at: iso(0), updated_at: iso(0) };
        db.screens.push(s);
        return [200, { screen: s }];
    }
    const s = db.screens.find((x) => x.id === id);
    if (kind === 'screens' && s && action === 'edit') return [200, { screen: Object.assign(s, body) }];
    if (kind === 'screens' && s && action === 'delete') {
        db.screens = db.screens.filter((x) => x !== s);
        return [200, { deleted: true }];
    }
    return [404, { error: 'Not found.' }];
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    const sendFile = (file) => {
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
    };
    if (p === '/__canvas/overlay.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(overlay);
    }
    if (req.method === 'GET' && p.startsWith('/__canvas/api/uploads/')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        return res.end(thumb(p.split('/').pop()));
    }
    if (p.startsWith('/__canvas/api/')) {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const [status, out] = await api(req.method, p.slice('/__canvas/api/'.length).split('/'), raw ? JSON.parse(raw) : {});
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
    }
    if (p === '/__canvas/') return sendFile(path.join(PUBLIC, 'index.html'));
    if (p.startsWith('/__canvas/')) {
        const f = path.join(PUBLIC, p.slice('/__canvas/'.length));
        if (f.startsWith(PUBLIC) && fs.existsSync(f)) return sendFile(f);
        res.writeHead(404);
        return res.end();
    }
    const f = path.join(appDir, p);
    if (p !== '/' && f.startsWith(appDir) && fs.existsSync(f)) return sendFile(f);
    return sendFile(path.join(appDir, 'index.html'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = 'http://127.0.0.1:' + server.address().port;

// ---- the checks ----
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok });
    console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
const shots = [];
async function shoot(page, name) {
    const file = path.join(outDir, name + '.png');
    await page.screenshot({ path: file });
    shots.push(file);
}
const settle = (page, ms = 600) => page.waitForTimeout(ms);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
try {
    for (const [w, h, tag] of [
        [1280, 800, 'desktop'],
        [390, 844, 'phone'],
    ]) {
        seed();
        calls.length = 0;
        const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        // the board: three screens, four frames, pins
        await page.goto(origin + '/__canvas/');
        await page.waitForFunction(() => document.querySelectorAll('.frame').length === 4);
        const pinsSent = () =>
            page.evaluate(() => [...document.querySelectorAll('.frame iframe')].reduce((n, f) => n + (f.contentWindow.__pins?.found || 0), 0));
        for (let i = 0; i < 100 && (await pinsSent()) < 3; i++) await page.waitForTimeout(100);
        await settle(page);
        check(`${tag}: four frames for three screens`, (await page.locator('.frame').count()) === 4);
        const pins = await pinsSent();
        check(`${tag}: open threads sent to their frames to pin`, pins === 3, pins + ' pins');
        check(`${tag}: the board draws no pins of its own`, (await page.locator('#pins .pin').count()) === 0);
        check(`${tag}: open threads numbered in the list`, (await page.locator('.thread .num').count()) === 2);
        const fail = await page.locator('.label .fail:not([hidden])').allTextContents();
        check(`${tag}: a replay that can't find its step is marked`, fail.join() === 'Step 1 failed', fail.join());
        const saved = await page.frames().find((f) => f.url().endsWith('?state=saved'))?.evaluate(() => !!document.querySelector('[role=status]'));
        check(`${tag}: steps replayed into their frame`, saved === true);
        check(`${tag}: project name from the app`, (await page.locator('#project').textContent()) === 'canvas-example');
        await shoot(page, `board-${w}x${h}`);

        // a thread open, from the PR's link
        await page.goto(origin + '/__canvas/?thread=t1');
        await page.waitForSelector('.thread.selected');
        await page.waitForFunction(() => [...document.querySelectorAll('.frame iframe')].some((f) => f.contentWindow.__pins?.selected === 't1'));
        await settle(page, 900);
        check(`${tag}: ?thread opens it`, (await page.locator('.thread.selected .msg').count()) === 2);
        await shoot(page, `thread-${w}x${h}`);

        if (tag === 'desktop') {
            // reply, then resolve
            await page.fill('.thread.selected textarea', 'Thanks, that looks right now');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelectorAll('.thread.selected .msg').length === 3);
            check('desktop: reply posts', calls.includes('POST threads/t1/comments'));
            await page.click('.thread.selected .reply .btn:has-text("Resolve")');
            await page.waitForFunction(() => document.querySelector('#list-resolved[aria-selected="true"]'));
            check('desktop: resolve moves it to Resolved', calls.includes('POST threads/t1/resolve'));
            await page.keyboard.press('Escape');

            // comment mode: a click in a frame opens the comment box there; Post saves it
            await page.click('#comment');
            await page.waitForFunction(() => document.body.classList.contains('commenting'));
            const people = page.frames().find((f) => f.url() === origin + '/' && f.parentFrame());
            await people.evaluate(() => document.querySelector('h1').click());
            await page.waitForSelector('.composer textarea');
            await page.fill('.composer textarea', 'Add a count beside the heading');
            await page.click('.composer button[type=submit]');
            await page.waitForFunction(() => !document.querySelector('.composer'));
            check('desktop: picked → comment posted', calls.includes('POST threads') && (await page.locator('.thread.selected').count()) === 1);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            check('desktop: Esc leaves comment mode', !(await page.evaluate(() => document.body.classList.contains('commenting'))));
        }

        // storage: two selected
        seed();
        calls.length = 0;
        await page.goto(origin + '/__canvas/?tab=storage');
        await page.waitForSelector('#st-rows tr');
        await page.waitForFunction(() => [...document.querySelectorAll('#st-rows img')].every((i) => i.complete || !i.offsetParent));
        check(`${tag}: storage total`, (await page.locator('#st-total').textContent()) === '5.4 MB');
        const boxes = page.locator('#st-rows input[type=checkbox]');
        await boxes.nth(0).click();
        await boxes.nth(1).click({ modifiers: ['Shift'] });
        const sel = await page.locator('#st-selected').textContent();
        check(`${tag}: shift-click selects a range, totalled`, sel === '2 selected · 3.4 MB', sel);
        await shoot(page, `storage-${w}x${h}`);

        // the confirm: Cancel deletes nothing; Delete does
        await page.click('#st-delete');
        await page.waitForSelector('#confirm[open]');
        const q = await page.locator('#confirm-text').textContent();
        check(`${tag}: confirm names the count and size`, q === 'Delete 2 screenshots (3.4 MB)?', q);
        await shoot(page, `confirm-${w}x${h}`);
        await page.click('#confirm-no');
        await settle(page, 200);
        check(`${tag}: Cancel deletes nothing`, !calls.some((c) => c.includes('delete')));
        await page.click('#st-delete');
        await page.click('#confirm-yes');
        await page.waitForFunction(() => document.querySelector('#st-bar').hidden);
        check(`${tag}: Delete removes the selected shots`, calls.includes('POST uploads/delete') && (await page.locator('#st-rows tr').count()) === 4);

        check(`${tag}: no page errors`, errors.length === 0, errors.join('; '));
        await page.close();
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(appDir, { recursive: true, force: true });
}

console.info('\nScreenshots:\n' + shots.join('\n'));
const failed = checks.filter((c) => !c.ok);
if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exit(1);
}
console.info(`\nall ${checks.length} checks passed`);
