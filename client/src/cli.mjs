// @ts-check
// The canvas CLI, Claude's side of a project's canvas: reads and answers its comment threads through the canvas
// service's API, so it needs no Cloudflare account access. Replies show as Claude's: the service takes any request
// made with the project's Access service token as Claude's.
//
//   canvas list [--open]                 threads, latest activity first
//   canvas show <code>                   a thread and its comments, then what was captured with it: the element, the
//                                        page, the steps, console errors and failed requests; saves its screenshots
//                                        to a temp dir and prints their paths
//   canvas repro <code> [--fictional] [--out <file>]
//                                        a Playwright test that replays the steps, written to a temp dir (or <file>);
//                                        --fictional swaps every typed value for a fake of the same shape
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
// What `show` prints and saves (the comment, the URL, the words, typed values, screenshots) and what `repro` writes
// can hold real people's data: they're for reading here, never for copying into commits, pull requests, tests or
// fixtures. Swap in fictional values (`repro --fictional`) before a repro becomes a committed test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureLines } from './cli-capture.mjs';
import { repro } from './cli-repro.mjs';

const ID = /^[a-z0-9]{8}$/;
export const CONFIG_FILE = 'canvas.config.json';
const DEFAULT_BASE = '/__canvas';

/**
 * @typedef {import('../../shared/contract.ts').Thread} Thread
 * @typedef {import('../../shared/contract.ts').Capture} Capture
 * @typedef {{ element?: string, screen?: string }} Shots
 * @typedef {{
 *   fetch: typeof fetch,
 *   env: Record<string, string | undefined>,
 *   cwd: string,
 *   out: (line: string) => void,
 *   warn?: (line: string) => void,
 *   readStdin: () => string,
 *   tmpdir?: string,
 * }} Io
 */

/** The nearest canvas.config.json's "url" and "base", or null when there's none here or above. */
function findConfig(/** @type {string} */ cwd) {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const file = path.join(dir, CONFIG_FILE);
        if (fs.existsSync(file)) {
            const { url, base = DEFAULT_BASE } = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error(file + ': give the app\'s preview host as "url", e.g. https://preview.example.org');
            return { url: url.replace(/\/+$/, ''), base: String(base).replace(/^\/+|\/+$/g, '') };
        }
        if (path.dirname(dir) === dir) return null;
    }
}

/** The canvas's address: CANVAS_URL, or canvas.config.json's "url" and "base" from the nearest directory that has one. */
export function canvasUrl(/** @type {Io} */ io) {
    if (io.env.CANVAS_URL) return io.env.CANVAS_URL.replace(/\/+$/, '');
    const config = findConfig(io.cwd);
    if (!config) throw new Error('No ' + CONFIG_FILE + ' here or above, and no CANVAS_URL.');
    return config.url + (config.base ? '/' + config.base : '');
}

/** The app's address, for repro: canvas.config.json's "url", or else CANVAS_URL's origin. */
export function appUrl(/** @type {Io} */ io) {
    const config = findConfig(io.cwd);
    return config ? config.url : new URL(canvasUrl(io)).origin;
}

/** A client for the canvas's API. */
export function api(/** @type {Io} */ io) {
    const base = canvasUrl(io);
    /** @type {Record<string, string>} */
    const auth = {};
    const { CANVAS_ACCESS_CLIENT_ID: id, CANVAS_ACCESS_CLIENT_SECRET: secret } = io.env;
    if (id && secret) Object.assign(auth, { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret });
    /** @param {string} method @param {string} p @param {Record<string, string>} headers @param {object} [body] */
    const send = (method, p, headers, body) =>
        io.fetch(base + '/' + p, { method, headers: { ...auth, ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    /** Access answers a request it didn't let through with its sign-in page, or a redirect to it. */
    const turnedAway = (/** @type {Response} */ res) => {
        const type = res.headers.get('content-type') || '';
        if (res.status === 403 || (res.status >= 300 && res.status < 400) || type.includes('text/html'))
            return new Error('Cloudflare Access turned the request away (' + res.status + '): set CANVAS_ACCESS_CLIENT_ID and CANVAS_ACCESS_CLIENT_SECRET.');
    };
    /** @param {string} method @param {string} p @param {object} [body] */
    const call = async (method, p, body) => {
        // the service turns away a POST from any other origin, as it would a page elsewhere
        const res = await send(method, 'api/' + p, { accept: 'application/json', ...(body ? { 'content-type': 'application/json', origin: new URL(base).origin } : {}) }, body);
        if (!(res.headers.get('content-type') || '').includes('application/json')) throw turnedAway(res) || new Error(method + ' ' + p + ': ' + res.status);
        const data = /** @type {{ error?: string, threads?: Thread[], thread?: Thread, capture?: Capture, shots?: Shots }} */ (await res.json());
        if (!res.ok) throw Object.assign(new Error(data.error || method + ' ' + p + ': ' + res.status), { status: res.status });
        return data;
    };
    return {
        base,
        /** @returns {Promise<Thread[]>} */
        list: async () => (await call('GET', 'threads')).threads || [],
        /** @returns {Promise<Thread>} */
        show: async (/** @type {string} */ id) => /** @type {Thread} */ ((await call('GET', 'threads/' + id)).thread),
        /** The thread's capture and its screenshots' API paths, or null when it has none (or it was deleted). */
        capture: async (/** @type {string} */ id) => {
            try {
                const data = await call('GET', 'threads/' + id + '/capture');
                return { capture: /** @type {Capture} */ (data.capture), shots: data.shots || {} };
            } catch (e) {
                if (/** @type {{ status?: number }} */ (e).status === 404) return null;
                throw e;
            }
        },
        /** An upload, from its `api/uploads/:id` path. */
        download: async (/** @type {string} */ p) => {
            const res = await send('GET', p.replace(/^\/+/, ''), { accept: 'image/webp,image/png' });
            const type = res.headers.get('content-type') || '';
            if (!res.ok || !type.startsWith('image/')) throw turnedAway(res) || new Error('GET ' + p + ': ' + res.status);
            return { type, bytes: new Uint8Array(await res.arrayBuffer()) };
        },
        /** @returns {Promise<Thread>} */
        reply: async (/** @type {string} */ id, /** @type {string} */ body) => /** @type {Thread} */ ((await call('POST', 'threads/' + id + '/comments', { body })).thread),
        /** @returns {Promise<Thread>} */
        setStatus: async (/** @type {string} */ id, /** @type {'resolve' | 'reopen'} */ action) =>
            /** @type {Thread} */ ((await call('POST', 'threads/' + id + '/' + action, {})).thread),
    };
}

/** Where a thread's files go: <tmp>/canvas/<id>. */
const scratch = (/** @type {Io} */ io, /** @type {string} */ id) => path.join(io.tmpdir || os.tmpdir(), 'canvas', id);

const who = (/** @type {string | null | undefined} */ a) => (a === 'claude' ? 'Claude' : 'Owner');
const local = (/** @type {string} */ iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const oneLine = (/** @type {unknown} */ s, /** @type {number} */ n) => {
    const t = String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** @param {Thread} t @param {string} base @param {(line: string) => void} out @param {boolean} facts  the element facts, when there's no capture to print them */
function printThread(t, base, out, facts) {
    out('Thread ' + t.id + ' (' + t.status + (t.resolved_by ? ' by ' + who(t.resolved_by) : '') + ')');
    out('Page:      ' + t.url);
    if (facts) {
        if (t.component) out('Component: ' + t.component);
        if (t.source) out('Source:    ' + t.source);
        out('Element:   ' + (t.words ? '"' + t.words + '"' : t.w ? 'none (an area)' : 'none picked'));
        if (t.selector) out('Selector:  ' + t.selector);
        if (t.w) out('Area:      ' + t.w + ' x ' + t.h + ' from ' + t.x + ', ' + t.y);
        else if (t.x != null) out('Point:     ' + t.x + ', ' + t.y);
        if (t.viewport) out('Screen:    ' + t.viewport);
        if (t.branch || t.commit_sha) out('Build:     ' + [t.branch, t.commit_sha?.slice(0, 12)].filter(Boolean).join(' @ '));
    }
    out('Link:      ' + base + '/?thread=' + t.id);
    for (const c of t.comments) {
        out('');
        out(who(c.author) + ' · ' + local(c.created_at) + (c.edited_at ? ' (edited)' : ''));
        out(c.body.replace(/^/gm, '  '));
    }
}

/** Saves a capture's screenshots to the thread's temp dir. @returns {Promise<Record<string, string>>} name → file */
async function saveShots(/** @type {ReturnType<typeof api>} */ canvas, /** @type {Shots} */ shots, /** @type {string} */ dir) {
    /** @type {Record<string, string>} */
    const files = {};
    for (const name of /** @type {const} */ (['element', 'screen'])) {
        const p = shots[name];
        if (!p) continue;
        const { type, bytes } = await canvas.download(p);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name + (type.includes('png') ? '.png' : '.webp'));
        fs.writeFileSync(file, bytes);
        files[name] = file;
    }
    return files;
}

const USAGE = 'Give a thread code (8 letters and digits), e.g. `canvas show ab3k9m2x`.';
const VALUED = new Set(['--out']);

/** Runs one command. @param {string[]} argv @param {Io} io */
export async function main(argv, io) {
    /** @type {Set<string>} */
    const flags = new Set();
    /** @type {Record<string, string>} */
    const values = {};
    /** @type {string[]} */
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (VALUED.has(a)) {
            if (i + 1 >= argv.length) throw new Error(a + ' needs a value.');
            values[a] = argv[++i];
        } else if (a.startsWith('--')) flags.add(a);
        else args.push(a);
    }
    const [cmd, id, ...rest] = args;
    if (!['list', 'show', 'repro', 'reply', 'resolve', 'reopen'].includes(cmd)) {
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
    if (!ID.test(id || '')) throw new Error(USAGE);
    if (cmd === 'show') {
        const t = await canvas.show(id);
        const got = await canvas.capture(id);
        const files = got ? await saveShots(canvas, got.shots, scratch(io, id)) : {};
        if (flags.has('--json')) return io.out(JSON.stringify({ thread: t, capture: got?.capture ?? null, shots: got?.shots ?? {}, files }, null, 2)), 0;
        printThread(t, canvas.base, io.out, !got);
        if (!got) return 0;
        io.out('');
        captureLines(got.capture).forEach((l) => io.out(l));
        const names = Object.keys(files);
        if (names.length) {
            io.out('');
            io.out('Screenshots');
            for (const n of names) io.out('  ' + (n + ':').padEnd(10) + files[n]);
        }
        return 0;
    }
    if (cmd === 'repro') {
        const got = await canvas.capture(id);
        if (!got) throw new Error(id + ' has no capture: none was recorded, or it was deleted.');
        const fictional = flags.has('--fictional');
        const source = repro(got.capture, { id, base: appUrl(io), fictional });
        const file = values['--out'] ? path.resolve(io.cwd, values['--out']) : path.join(scratch(io, id), 'repro.spec.ts');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
        if (!fictional) (io.warn || io.out)('Warning: typed values are as recorded and may be real data: never commit or post them (use --fictional).');
        io.out(file);
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
