// @ts-check
// The canvas CLI, Claude's side of a project's canvas: reads and answers its comment threads through the canvas
// service's API, so it needs no Cloudflare account access. Replies show as Claude's: the service takes any request
// made with the project's Access service token as Claude's.
//
//   canvas list [--open]                 threads, latest activity first
//   canvas show <code>                   a thread: where it was made, the element, and every comment
//   canvas reply <code> <text>           answers it; <text> may be - to read stdin
//   canvas reply <code> <text> --resolve
//   canvas resolve <code>
//   canvas reopen <code>
//
//   --json   list and show print JSON
//
// Where: canvas.config.json, in this directory or the nearest one above it (docs/CONTRACT.md): its "url" is the app's
// preview host and "base" the canvas's path there (default /__canvas). CANVAS_URL, the canvas's whole address
// (e.g. http://localhost:8787/__canvas), wins over it.
// Who: CANVAS_ACCESS_CLIENT_ID and CANVAS_ACCESS_CLIENT_SECRET, the project's Access service token, sent as
// CF-Access-Client-Id and CF-Access-Client-Secret. Without them nothing is sent (a local `wrangler dev`, or a proxy
// that adds the token itself).
//
// What `show` prints (the comment, the page's URL, the element's words) can hold real people's data: it's for reading
// here, never for copying into commits, pull requests, tests or fixtures.
import fs from 'node:fs';
import path from 'node:path';

const ID = /^[a-z0-9]{8}$/;
export const CONFIG_FILE = 'canvas.config.json';

/**
 * @typedef {{ id: string, author: string, body: string, created_at: string, edited_at?: string | null }} Comment
 * @typedef {{ id: string, status: string, url: string, selector?: string | null, words?: string | null,
 *   component?: string | null, source?: string | null, branch?: string | null, commit_sha?: string | null,
 *   viewport?: string | null, x?: number | null, y?: number | null, w?: number | null, h?: number | null,
 *   resolved_by?: string | null, updated_at: string, comments: Comment[] }} Thread
 * @typedef {{
 *   fetch: typeof fetch,
 *   env: Record<string, string | undefined>,
 *   cwd: string,
 *   out: (line: string) => void,
 *   readStdin: () => string,
 * }} Io
 */

/** The canvas's address: CANVAS_URL, or canvas.config.json's "url" from the nearest directory that has one. */
export function canvasUrl(/** @type {Io} */ io) {
    if (io.env.CANVAS_URL) return io.env.CANVAS_URL.replace(/\/+$/, '');
    for (let dir = path.resolve(io.cwd); ; dir = path.dirname(dir)) {
        const file = path.join(dir, CONFIG_FILE);
        if (fs.existsSync(file)) {
            const { url, base = '/__canvas' } = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error(file + ': give the app\'s preview host as "url", e.g. https://preview.example.org');
            const p = String(base).replace(/^\/+|\/+$/g, '');
            return url.replace(/\/+$/, '') + (p ? '/' + p : '');
        }
        if (path.dirname(dir) === dir) throw new Error('No ' + CONFIG_FILE + ' here or above, and no CANVAS_URL.');
    }
}

/** A client for the canvas's API. */
export function api(/** @type {Io} */ io) {
    const base = canvasUrl(io);
    /** @type {Record<string, string>} */
    const auth = {};
    const { CANVAS_ACCESS_CLIENT_ID: id, CANVAS_ACCESS_CLIENT_SECRET: secret } = io.env;
    if (id && secret) Object.assign(auth, { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret });
    /** @param {string} method @param {string} p @param {object} [body] */
    const call = async (method, p, body) => {
        const res = await io.fetch(base + '/api/' + p, {
            method,
            // the service turns away a POST from any other origin, as it would a page elsewhere
            headers: { ...auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json', origin: new URL(base).origin } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            redirect: 'manual',
        });
        const type = res.headers.get('content-type') || '';
        if (!type.includes('application/json')) {
            // Access answers a request it didn't let through with its sign-in page, or a redirect to it
            if (res.status === 403 || (res.status >= 300 && res.status < 400) || type.includes('text/html'))
                throw new Error('Cloudflare Access turned the request away (' + res.status + '): set CANVAS_ACCESS_CLIENT_ID and CANVAS_ACCESS_CLIENT_SECRET.');
            throw new Error(method + ' ' + p + ': ' + res.status);
        }
        const data = /** @type {{ error?: string, threads?: Thread[], thread?: Thread }} */ (await res.json());
        if (!res.ok) throw new Error(data.error || method + ' ' + p + ': ' + res.status);
        return data;
    };
    return {
        base,
        /** @returns {Promise<Thread[]>} */
        list: async () => (await call('GET', 'threads')).threads || [],
        /** @returns {Promise<Thread>} */
        show: async (/** @type {string} */ id) => /** @type {Thread} */ ((await call('GET', 'threads/' + id)).thread),
        /** @returns {Promise<Thread>} */
        reply: async (/** @type {string} */ id, /** @type {string} */ body) => /** @type {Thread} */ ((await call('POST', 'threads/' + id + '/comments', { body })).thread),
        /** @returns {Promise<Thread>} */
        setStatus: async (/** @type {string} */ id, /** @type {'resolve' | 'reopen'} */ action) =>
            /** @type {Thread} */ ((await call('POST', 'threads/' + id + '/' + action, {})).thread),
    };
}

const who = (/** @type {string | null | undefined} */ a) => (a === 'claude' ? 'Claude' : 'Owner');
const local = (/** @type {string} */ iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const oneLine = (/** @type {unknown} */ s, /** @type {number} */ n) => {
    const t = String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** @param {Thread} t @param {string} base @param {(line: string) => void} out */
function printThread(t, base, out) {
    out('Thread ' + t.id + ' (' + t.status + (t.resolved_by ? ' by ' + who(t.resolved_by) : '') + ')');
    out('Page:      ' + t.url);
    if (t.component) out('Component: ' + t.component);
    if (t.source) out('Source:    ' + t.source);
    out('Element:   ' + (t.words ? '"' + t.words + '"' : t.w ? 'none (an area)' : 'none picked'));
    if (t.selector) out('Selector:  ' + t.selector);
    if (t.w) out('Area:      ' + t.w + ' x ' + t.h + ' from ' + t.x + ', ' + t.y);
    else if (t.x != null) out('Point:     ' + t.x + ', ' + t.y);
    if (t.viewport) out('Screen:    ' + t.viewport);
    if (t.branch || t.commit_sha) out('Build:     ' + [t.branch, t.commit_sha?.slice(0, 12)].filter(Boolean).join(' @ '));
    out('Link:      ' + base + '/?thread=' + t.id);
    for (const c of t.comments) {
        out('');
        out(who(c.author) + ' · ' + local(c.created_at) + (c.edited_at ? ' (edited)' : ''));
        out(c.body.replace(/^/gm, '  '));
    }
}

/** Runs one command. @param {string[]} argv @param {Io} io */
export async function main(argv, io) {
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    const args = argv.filter((a) => !a.startsWith('--'));
    const [cmd, id, ...rest] = args;
    const needId = () => {
        if (!ID.test(id || '')) throw new Error('Give a thread code (8 letters and digits), e.g. `canvas show ab3k9m2x`.');
    };
    if (!['list', 'show', 'reply', 'resolve', 'reopen'].includes(cmd)) {
        io.out(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^\/\/ ?(@ts-check\n)?/gm, '').trim());
        return cmd ? 1 : 0;
    }
    const canvas = api(io);
    if (cmd === 'list') {
        const threads = (await canvas.list()).filter((t) => !flags.has('--open') || t.status === 'open');
        if (flags.has('--json')) return io.out(JSON.stringify(threads, null, 2)), 0;
        if (!threads.length) return io.out(flags.has('--open') ? 'No open threads.' : 'No threads.'), 0;
        for (const t of threads) {
            const last = t.comments[t.comments.length - 1];
            const where = t.component || t.source ? [t.component, t.source].filter(Boolean).join(' at ') : t.words ? '"' + oneLine(t.words, 40) + '"' : '';
            io.out(t.id + '  ' + t.status.padEnd(8) + ' ' + oneLine(t.url, 60) + (where ? ' · ' + where : ''));
            io.out(' '.repeat(10) + who(last?.author) + ': ' + oneLine(last?.body, 90) + (t.comments.length > 1 ? '  (' + t.comments.length + ' comments)' : '') + '  ' + local(t.updated_at));
        }
        return 0;
    }
    needId();
    if (cmd === 'show') {
        const t = await canvas.show(id);
        if (flags.has('--json')) io.out(JSON.stringify(t, null, 2));
        else printThread(t, canvas.base, io.out);
        return 0;
    }
    if (cmd === 'reply') {
        let text = rest.join(' ');
        if (text === '-') text = io.readStdin();
        text = text.replace(/\r\n?/g, '\n').trim();
        if (!text) throw new Error('Give the reply text, or - to read it from stdin.');
        await canvas.reply(id, text);
        if (flags.has('--resolve')) await canvas.setStatus(id, 'resolve');
        io.out('Replied to ' + id + (flags.has('--resolve') ? ' and resolved it.' : '.'));
        return 0;
    }
    const want = cmd === 'resolve' ? 'resolved' : 'open';
    const t = await canvas.show(id);
    if (t.status === want) return io.out(id + ' is already ' + want + '.'), 0;
    await canvas.setStatus(id, cmd === 'resolve' ? 'resolve' : 'reopen');
    io.out((cmd === 'resolve' ? 'Resolved ' : 'Reopened ') + id + '.');
    return 0;
}
