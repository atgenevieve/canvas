// The canvas service: one deployment per project, routed at /__canvas/* (BASE_PATH) on the app's own preview and test
// hosts, so the overlay in the app calls it on the app's own origin. It serves the board and the overlay (public/,
// deployed with the Worker), a JSON API for comment threads, their captures and screenshots, and the board's screens,
// and a WebSocket (Live) that says when any of them change. Threads, captures and screens are kept in D1, screenshots
// in R2. Cloudflare Access stands in front of the whole host and says who is asking; the Worker trusts nothing else for
// that, and turns away any request that didn't come through Access. Each comment a person writes is also announced on
// a GitHub pull request (the branch's own, or the inbox), so a Claude session wakes up for it. That message is a
// pointer only: the thread's code and code-level facts, never what the comment says, where it was written, or what
// was recorded with it (PLAN.md, "Privacy"). Claude reads and answers through the canvas CLI, which calls this same API
// with an Access service token.
//
// docs/CONTRACT.md lists the API; shared/contract.ts has its types. In short, under BASE_PATH:
//
//   GET  /api/threads, /api/threads/:id         threads with their comments ({ me, threads } or { me, thread })
//   POST /api/threads                           NewThread { body, capture } starts a thread
//   POST /api/threads/:id/comments              { body } replies; /resolve, /reopen
//   POST /api/comments/:id/edit, …/delete       a comment's author changes or deletes it
//   GET  /api/threads/:id/capture               what was recorded with the thread, and its screenshots' paths
//   POST /api/threads/:id/capture/delete        deletes the capture and screenshots, keeps the thread
//   POST /api/threads/:id/delete                deletes the thread and everything with it
//   POST /api/uploads                           a screenshot (WebP or PNG); GET /api/uploads/:id; POST …/delete { ids }
//   GET  /api/storage                           every screenshot and capture with its size
//   GET  /api/screens, POST /api/screens        the board's screens; POST /api/screens/:id/edit, …/delete
//   GET  /live                                  the WebSocket
//
// Nothing is deleted except by the delete calls above: no clean-up runs on its own.

import { CONTRACT_VERSION, MAX_UPLOAD_BYTES, SIZES } from '../../shared/contract.ts';
import type { Capture, Comment, Rect, Screen, Size, Step, Storage, StorageItem, Thread } from '../../shared/contract.ts';
import { appJwt } from './github-app.ts';

export { Live } from './live.ts';

export interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    // screenshots, as "uploads/<id>"
    FILES?: R2Bucket;
    // the Durable Object behind BASE/live
    LIVE?: DurableObjectNamespace;
    BASE_PATH?: string;
    PROJECT?: string;
    GITHUB_REPO?: string;
    INBOX_PR?: string;
    GITHUB_TOKEN?: string;
    GITHUB_APP_ID?: string;
    GITHUB_APP_KEY?: string;
}

type Input = Record<string, unknown>;
type Event = 'new' | 'reply' | 'reopen' | 'edit' | 'delete' | 'delete-thread';
type LiveMessage = { type: 'thread'; id: string } | { type: 'screens' };

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// wrangler dev has no Access in front of it: requests to localhost are this person
const LOCAL_USER = 'you@localhost';
// who a request made with an Access service token is: the canvas CLI, run by Claude
const CLAUDE = 'claude';
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID = /^[a-z0-9]{8}$/;
const MAX_BODY = 10000;
// A capture is steps and facts, not images: 100 steps with long typed values stay well under this. D1 keeps a row
// under 2 MB.
const MAX_CAPTURE_BYTES = 1024 * 1024;
// a screen's steps are the ones since its page loaded, which may be more than a comment's 100
const MAX_SCREEN_STEPS_BYTES = 256 * 1024;
const MAX_DELETE_IDS = 1000;
// how long a branch's pull request (or its having none) is remembered
const PR_CACHE_MS = 5 * 60 * 1000;
const IMAGE_TYPES = ['image/webp', 'image/png'];

let inboxOffLogged = false;
let installation: { token: string; until: number } | null = null;
const branchPrs = new Map<string, { pr: string | null; until: number }>();

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const user = userOf(request, url);
        if (!user) return new Response('Open the canvas through Cloudflare Access.', { status: 403 });
        const base = basePath(env);
        if (url.pathname === base && base) return Response.redirect(url.origin + base + '/' + url.search, 308);
        if (!url.pathname.startsWith(base + '/')) return new Response('Not found', { status: 404 });
        const path = url.pathname.slice(base.length);
        if (path.startsWith('/api/')) {
            try {
                return await api(request, env, ctx, url, path, user);
            } catch (e) {
                if (e instanceof HttpError) return json({ error: e.message }, e.status);
                console.error(e);
                return json({ error: 'Something went wrong.' }, 500);
            }
        }
        if (path === '/live') return live(request, env, url);
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
        return asset(request, env, url, path);
    },
} satisfies ExportedHandler<Env>;

// "/__canvas" by default; a deployment may sit elsewhere on its host. No trailing slash.
function basePath(env: Env): string {
    const p = (env.BASE_PATH ?? '/__canvas').trim().replace(/^\/+|\/+$/g, '');
    return p ? '/' + p : '';
}

// Access puts the signed-in person's email on every request it lets through. A service token (Claude's, for the CLI)
// has no email: Access lets it through with only its JWT, which names the token as common_name. The JWT is read, not
// verified, for the same reason the email header is trusted: nothing reaches this Worker except through Access.
function userOf(request: Request, url: URL): string | null {
    const email = request.headers.get('cf-access-authenticated-user-email');
    if (email) return email.trim().toLowerCase();
    const claims = jwtClaims(request.headers.get('cf-access-jwt-assertion'));
    if (claims && typeof claims.common_name === 'string' && claims.common_name && !claims.email) return CLAUDE;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return LOCAL_USER;
    return null;
}

function jwtClaims(jwt: string | null): Record<string, unknown> | null {
    const payload = jwt?.split('.')[1];
    if (!payload) return null;
    try {
        const text = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0))));
        return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

// the board and the overlay bundle, deployed with the Worker
function asset(request: Request, env: Env, url: URL, path: string): Promise<Response> {
    const target = new URL(path === '/' ? '/index.html' : path, url);
    return env.ASSETS.fetch(new Request(target, request));
}

// The WebSocket goes to the one Live object. A page elsewhere could open a socket here with the person's Access
// cookie, as it could post a form, so a browser's Origin must be this host's (the CLI sends none).
function live(request: Request, env: Env, url: URL): Promise<Response> | Response {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('Open this as a WebSocket.', { status: 426 });
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return new Response('Cross-site request.', { status: 403 });
    if (!env.LIVE) return new Response('Live is not set up.', { status: 503 });
    return env.LIVE.get(env.LIVE.idFromName('live')).fetch(request);
}

async function broadcast(env: Env, message: LiveMessage): Promise<void> {
    if (!env.LIVE) return;
    try {
        await env.LIVE.get(env.LIVE.idFromName('live')).fetch('https://live/broadcast', { method: 'POST', body: JSON.stringify(message) });
    } catch (e) {
        // the pages miss one update; they still fetch afresh on the next
        console.error('Live: ' + (e instanceof Error ? e.message : String(e)));
    }
}

// What a handler may do once it has changed something: tell the open pages (always), and tell GitHub (for a person's
// own new comment, reply, reopen, edit or delete only).
interface Tell {
    thread(thread: Pick<Thread, 'id'> | null, event?: Event): void;
    screens(): void;
}

async function api(request: Request, env: Env, ctx: ExecutionContext, url: URL, path: string, user: string): Promise<Response> {
    const parts = path.split('/').slice(2);
    const [kind, id, action, sub] = parts;
    if (!['threads', 'comments', 'uploads', 'storage', 'screens'].includes(kind) || parts.length > 4 || parts.some((p) => !p))
        throw new HttpError(404, 'Not found.');
    const n = parts.length;
    if (request.method === 'GET') {
        if (kind === 'threads' && n === 1) return listThreads(request, env, user);
        if (kind === 'threads' && n === 2) return getThread(env, user, id);
        if (kind === 'threads' && n === 3 && action === 'capture') return getCapture(env, id);
        if (kind === 'uploads' && n === 2) return getUpload(env, id);
        if (kind === 'storage' && n === 1) return storage(env);
        if (kind === 'screens' && n === 1) return listScreens(env);
        throw new HttpError(404, 'Not found.');
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    // a page elsewhere can't post here with a person's Access cookie: browsers send Origin on every POST (the CLI
    // sends its own)
    if (request.headers.get('origin') !== url.origin) throw new HttpError(403, 'Cross-site request.');
    const tell: Tell = {
        thread(thread, event) {
            if (!thread) return;
            ctx.waitUntil(broadcast(env, { type: 'thread', id: thread.id }));
            // Claude's own replies stay on the canvas: they'd only wake Claude again
            if (event && user !== CLAUDE) ctx.waitUntil(inbox(env, url, thread as Thread, event));
        },
        screens() {
            ctx.waitUntil(broadcast(env, { type: 'screens' }));
        },
    };
    if (kind === 'threads') {
        if (n === 1) return createThread(env, tell, user, await readJson(request));
        if (!ID.test(id)) throw new HttpError(404, 'No such thread.');
        if (n === 3 && action === 'comments') return addComment(env, tell, user, id, await readJson(request));
        if (n === 3 && (action === 'resolve' || action === 'reopen')) return setStatus(env, tell, user, id, action);
        if (n === 3 && action === 'delete') return deleteThread(env, tell, id);
        if (n === 4 && action === 'capture' && sub === 'delete') return deleteCapture(env, tell, id);
    }
    if (kind === 'comments' && n === 3) {
        if (!ID.test(id)) throw new HttpError(404, 'No such comment.');
        if (action === 'edit') return editComment(env, tell, user, id, await readJson(request));
        if (action === 'delete') return deleteComment(env, tell, user, id);
    }
    if (kind === 'uploads' && n === 1) return createUpload(request, env);
    if (kind === 'uploads' && n === 2 && id === 'delete') return deleteUploads(env, tell, await readJson(request));
    if (kind === 'screens') {
        if (n === 1) return createScreen(env, tell, await readJson(request));
        if (!ID.test(id)) throw new HttpError(404, 'No such screen.');
        if (n === 3 && action === 'edit') return editScreen(env, tell, id, await readJson(request));
        if (n === 3 && action === 'delete') return deleteScreen(env, tell, id);
    }
    throw new HttpError(404, 'Not found.');
}

async function readJson(request: Request): Promise<Input> {
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
    let input: unknown;
    try {
        input = await request.json();
    } catch {
        throw new HttpError(400, 'Send JSON.');
    }
    if (!isObject(input)) throw new HttpError(400, 'Send a JSON object.');
    return input;
}

const isObject = (v: unknown): v is Input => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- threads and comments

// a thread as the API gives it: whether it has a capture is a column of the query, 0 or 1
const THREAD_SELECT = 'SELECT t.*, EXISTS (SELECT 1 FROM captures WHERE thread_id = t.id) AS has_capture FROM threads t';
const threadRow = (row: Record<string, unknown>) => ({ ...row, has_capture: !!row.has_capture });

async function listThreads(request: Request, env: Env, user: string): Promise<Response> {
    // the list's version: polling gets a 304 until something changes
    const stamp = await env.DB.prepare(
        'SELECT (SELECT count(*) FROM threads) AS t, (SELECT count(*) FROM comments) AS c, (SELECT max(updated_at) FROM threads) AS u',
    ).first<{ t: number; c: number; u: string | null }>();
    const etag = 'W/"' + (await shortHash([user, stamp?.t, stamp?.c, stamp?.u].join('|'))) + '"';
    const headers = { etag, 'cache-control': 'no-store' };
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    const [threads, comments] = await env.DB.batch<Record<string, unknown>>([
        env.DB.prepare(THREAD_SELECT + ' ORDER BY t.updated_at DESC'),
        env.DB.prepare('SELECT * FROM comments ORDER BY created_at, rowid'),
    ]);
    const byThread = new Map(threads.results.map((t) => [t.id, { ...threadRow(t), comments: [] as unknown[] }]));
    for (const c of comments.results) byThread.get(c.thread_id)?.comments.push(c);
    return json({ me: user, threads: [...byThread.values()] }, 200, headers);
}

async function getThread(env: Env, user: string, id: string): Promise<Response> {
    const thread = ID.test(id) ? await threadOf(env, id) : null;
    if (!thread) throw new HttpError(404, 'No such thread.');
    return json({ me: user, thread }, 200, { 'cache-control': 'no-store' });
}

// A point or a box on the page, in CSS pixels to a tenth, never off its top or left.
function coord(v: unknown, what: string): number | null {
    if (v == null) return null;
    const n = Number(v);
    if (typeof v === 'boolean' || !Number.isFinite(n)) throw new HttpError(400, 'Give ' + what + ' as numbers.');
    return Math.round(Math.max(n, 0) * 10) / 10;
}

function rectOf(v: unknown, what: string): Rect {
    if (!isObject(v)) throw new HttpError(400, 'Give ' + what + ' as x, y, w and h.');
    const [x, y, w, h] = (['x', 'y', 'w', 'h'] as const).map((k) => coord(v[k], what));
    if (x == null || y == null || w == null || h == null) throw new HttpError(400, 'Give ' + what + ' as x, y, w and h.');
    return { x, y, w, h };
}

// The capture as the overlay sends it, checked enough that the columns taken from it make sense and the CLI can read
// it back. Its steps and values are kept as sent: they're private, and only ever read back through the API.
function captureOf(v: unknown): Capture {
    if (!isObject(v)) throw new HttpError(400, 'Send the capture with the comment.');
    if (v.version !== CONTRACT_VERSION) throw new HttpError(400, 'Send a capture of version ' + CONTRACT_VERSION + '.');
    if (!isObject(v.env) || !short(v.env.url, 2000)) throw new HttpError(400, "Give the page's URL in the capture's env.");
    if (v.element != null && (!isObject(v.element) || !short(v.element.selector, 1000))) throw new HttpError(400, "Give the element's selector.");
    for (const k of ['steps', 'errors', 'failed']) if (!Array.isArray(v[k])) throw new HttpError(400, "Give the capture's " + k + ' as a list.');
    const shots = v.shots ?? {};
    if (!isObject(shots) || [shots.element, shots.screen].some((s) => s != null && !(typeof s === 'string' && ID.test(s))))
        throw new HttpError(400, "Give the capture's shots as upload ids.");
    return { ...(v as unknown as Capture), element: (v.element ?? null) as Capture['element'], shots: shots as Capture['shots'] };
}

async function createThread(env: Env, tell: Tell, user: string, input: Input): Promise<Response> {
    const body = bodyOf(input);
    const capture = captureOf(input.capture);
    const { element, env: where } = capture;
    // the pin: the element's box, else the area dragged out (at least 4 px each way), else the point clicked
    let box: { x: number | null; y: number | null; w: number | null; h: number | null } = { x: null, y: null, w: null, h: null };
    if (element) box = rectOf(element.rect, "the element's box");
    else if (capture.area != null) {
        const a = rectOf(capture.area, 'the area');
        box = { ...a, w: Math.max(4, a.w), h: Math.max(4, a.h) };
    } else if (capture.point != null) {
        const p: unknown = capture.point;
        const x = isObject(p) ? coord(p.x, 'the point on the page') : null;
        const y = isObject(p) ? coord(p.y, 'the point on the page') : null;
        if (x == null || y == null) throw new HttpError(400, 'Give the point on the page as numbers.');
        box = { x, y, w: null, h: null };
    }
    const vp: unknown = where.viewport;
    const viewport =
        isObject(vp) && Number.isFinite(Number(vp.w)) && Number.isFinite(Number(vp.h)) ? Math.round(Number(vp.w)) + 'x' + Math.round(Number(vp.h)) : null;
    const captureJson = JSON.stringify(capture);
    const bytes = new TextEncoder().encode(captureJson).length;
    if (bytes > MAX_CAPTURE_BYTES) throw new HttpError(413, 'That capture is too big to save.');
    const id = newId();
    // An upload is claimed by the first thread that names it, so one thread can't take another's screenshot.
    const claim = (shot: string | undefined, kind: 'element' | 'screen') =>
        shot ? [env.DB.prepare('UPDATE uploads SET thread_id = ?1, kind = ?2 WHERE id = ?3 AND thread_id IS NULL').bind(id, kind, shot)] : [];
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO threads (id, url, selector, words, component, source, branch, commit_sha, viewport, x, y, w, h, status, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'open', ?14, ${NOW}, ${NOW})`,
        ).bind(
            id,
            short(where.url, 2000),
            element ? short(element.selector, 1000) : null,
            element ? short(element.words, 200) : null,
            element ? short(element.component, 300) : null,
            element ? short(element.source, 300) : null,
            short(where.branch, 200),
            short(where.commit, 64),
            viewport,
            box.x,
            box.y,
            box.w,
            box.h,
            user,
        ),
        env.DB.prepare(`INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?1, ?2, ?3, ?4, ${NOW})`).bind(newId(), id, user, body),
        env.DB.prepare(`INSERT INTO captures (thread_id, json, bytes, created_at) VALUES (?1, ?2, ?3, ${NOW})`).bind(id, captureJson, bytes),
        ...claim(capture.shots.element, 'element'),
        ...claim(capture.shots.screen, 'screen'),
    ]);
    const thread = await threadOf(env, id);
    tell.thread(thread, 'new');
    return json({ thread }, 201);
}

async function addComment(env: Env, tell: Tell, user: string, id: string, input: Input): Promise<Response> {
    const body = bodyOf(input);
    const [, updated] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO comments (id, thread_id, author, body, created_at) SELECT ?1, id, ?2, ?3, ${NOW} FROM threads WHERE id = ?4`).bind(
            newId(),
            user,
            body,
            id,
        ),
        env.DB.prepare(`UPDATE threads SET updated_at = ${NOW} WHERE id = ?1`).bind(id),
    ]);
    if (!updated.meta.changes) throw new HttpError(404, 'No such thread.');
    const thread = await threadOf(env, id);
    tell.thread(thread, 'reply');
    return json({ thread }, 201);
}

// a comment of this person's, and its thread's id and first comment's
async function ownComment(env: Env, user: string, id: string) {
    const c = await env.DB.prepare(
        'SELECT c.id, c.thread_id, c.author, (SELECT id FROM comments WHERE thread_id = c.thread_id ORDER BY created_at, rowid LIMIT 1) AS first FROM comments c WHERE c.id = ?1',
    )
        .bind(id)
        .first<{ id: string; thread_id: string; author: string; first: string }>();
    if (!c) throw new HttpError(404, 'No such comment.');
    if (c.author !== user) throw new HttpError(403, 'Only its author can change a comment.');
    return c;
}

async function editComment(env: Env, tell: Tell, user: string, id: string, input: Input): Promise<Response> {
    const body = bodyOf(input);
    const c = await ownComment(env, user, id);
    await env.DB.batch([
        env.DB.prepare(`UPDATE comments SET body = ?1, edited_at = ${NOW} WHERE id = ?2`).bind(body, id),
        env.DB.prepare(`UPDATE threads SET updated_at = ${NOW} WHERE id = ?1`).bind(c.thread_id),
    ]);
    const thread = await threadOf(env, c.thread_id);
    tell.thread(thread, 'edit');
    return json({ thread });
}

// a thread's first comment is the thread: deleting it deletes the thread and everything with it
async function deleteComment(env: Env, tell: Tell, user: string, id: string): Promise<Response> {
    const c = await ownComment(env, user, id);
    const before = await threadOf(env, c.thread_id);
    if (c.first === id) {
        await removeThread(env, c.thread_id);
        tell.thread(before, 'delete-thread');
        return json({ deleted: true });
    }
    await env.DB.batch([
        env.DB.prepare('DELETE FROM comments WHERE id = ?1').bind(id),
        env.DB.prepare(`UPDATE threads SET updated_at = ${NOW} WHERE id = ?1`).bind(c.thread_id),
    ]);
    tell.thread(before, 'delete');
    return json({ thread: await threadOf(env, c.thread_id) });
}

async function setStatus(env: Env, tell: Tell, user: string, id: string, action: 'resolve' | 'reopen'): Promise<Response> {
    const res = await (
        action === 'resolve'
            ? env.DB.prepare(
                  `UPDATE threads SET status = 'resolved', resolved_by = ?2, resolved_at = ${NOW}, updated_at = ${NOW} WHERE id = ?1 AND status = 'open'`,
              ).bind(id, user)
            : env.DB.prepare(
                  `UPDATE threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ${NOW} WHERE id = ?1 AND status = 'resolved'`,
              ).bind(id)
    ).run();
    const thread = await threadOf(env, id);
    if (!thread) throw new HttpError(404, 'No such thread.');
    // a resolve is news for the pages but not for Claude; a reopen is news for both
    if (res.meta.changes) tell.thread(thread, action === 'reopen' ? 'reopen' : undefined);
    return json({ thread });
}

// Deleted by hand from the canvas (anyone signed in may): the thread, its comments, its capture and its screenshots.
async function deleteThread(env: Env, tell: Tell, id: string): Promise<Response> {
    const before = await threadOf(env, id);
    if (!before) throw new HttpError(404, 'No such thread.');
    await removeThread(env, id);
    tell.thread(before, 'delete-thread');
    return json({ deleted: true });
}

// The screenshots go from R2 first: if that fails, the rows are still there to say what's left, and the call can be
// made again.
async function removeThread(env: Env, id: string): Promise<void> {
    await removeFiles(env, await uploadIdsOf(env, id));
    await env.DB.batch([
        env.DB.prepare('DELETE FROM uploads WHERE thread_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM captures WHERE thread_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM comments WHERE thread_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM threads WHERE id = ?1').bind(id),
    ]);
}

async function threadOf(env: Env, id: string): Promise<Thread | null> {
    const [t, c] = await env.DB.batch([
        env.DB.prepare(THREAD_SELECT + ' WHERE t.id = ?1').bind(id),
        env.DB.prepare('SELECT * FROM comments WHERE thread_id = ?1 ORDER BY created_at, rowid').bind(id),
    ]);
    const row = t.results[0] as Record<string, unknown> | undefined;
    return row ? ({ ...threadRow(row), comments: c.results as unknown as Comment[] } as unknown as Thread) : null;
}

function bodyOf(input: Input): string {
    const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : '';
    if (!body) throw new HttpError(400, 'Write a comment.');
    if (body.length > MAX_BODY) throw new HttpError(400, 'Keep a comment under ' + MAX_BODY + ' characters.');
    return body;
}

// ---- captures and screenshots

// The capture as it was saved, with its shots as they are now (one may have been deleted from the storage view since),
// and where to fetch each screenshot.
async function getCapture(env: Env, id: string): Promise<Response> {
    if (!ID.test(id)) throw new HttpError(404, 'No such thread.');
    const [cap, ups] = await env.DB.batch([
        env.DB.prepare('SELECT json FROM captures WHERE thread_id = ?1').bind(id),
        env.DB.prepare('SELECT id, kind FROM uploads WHERE thread_id = ?1 AND kind IS NOT NULL ORDER BY created_at').bind(id),
    ]);
    const row = cap.results[0] as { json: string } | undefined;
    if (!row) throw new HttpError(404, 'This thread has no capture.');
    const ids: Capture['shots'] = {};
    const shots: { element?: string; screen?: string } = {};
    for (const u of ups.results as { id: string; kind: 'element' | 'screen' }[]) {
        ids[u.kind] = u.id;
        shots[u.kind] = 'api/uploads/' + u.id;
    }
    const capture = { ...(JSON.parse(row.json) as Capture), shots: ids };
    return json({ capture, shots }, 200, { 'cache-control': 'no-store' });
}

async function deleteCapture(env: Env, tell: Tell, id: string): Promise<Response> {
    if (!(await env.DB.prepare('SELECT 1 FROM threads WHERE id = ?1').bind(id).first())) throw new HttpError(404, 'No such thread.');
    await removeFiles(env, await uploadIdsOf(env, id));
    await env.DB.batch([
        env.DB.prepare('DELETE FROM uploads WHERE thread_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM captures WHERE thread_id = ?1').bind(id),
        env.DB.prepare(`UPDATE threads SET updated_at = ${NOW} WHERE id = ?1`).bind(id),
    ]);
    const thread = await threadOf(env, id);
    tell.thread(thread);
    return json({ thread });
}

function files(env: Env): R2Bucket {
    if (!env.FILES) throw new HttpError(503, 'No file storage (the FILES bucket) is set up.');
    return env.FILES;
}

const fileKey = (id: string) => 'uploads/' + id;

async function uploadIdsOf(env: Env, threadId: string): Promise<string[]> {
    const { results } = await env.DB.prepare('SELECT id FROM uploads WHERE thread_id = ?1').bind(threadId).all<{ id: string }>();
    return results.map((r) => r.id);
}

async function removeFiles(env: Env, ids: string[]): Promise<void> {
    if (ids.length) await files(env).delete(ids.map(fileKey));
}

// A screenshot, uploaded before the comment that uses it. Its first bytes must say what its type does, so nothing
// but an image is ever served back from here.
async function createUpload(request: Request, env: Env): Promise<Response> {
    const bucket = files(env);
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw new HttpError(415, 'Send a WebP or PNG image.');
    const tooBig = 'Keep a screenshot under ' + MAX_UPLOAD_BYTES / 1024 / 1024 + ' MB.';
    if (Number(request.headers.get('content-length')) > MAX_UPLOAD_BYTES) throw new HttpError(413, tooBig);
    const data = new Uint8Array(await request.arrayBuffer());
    if (!data.length) throw new HttpError(400, 'Send the image.');
    if (data.length > MAX_UPLOAD_BYTES) throw new HttpError(413, tooBig);
    if (!isImage(type, data)) throw new HttpError(415, 'That is not a WebP or PNG image.');
    const id = newId();
    await bucket.put(fileKey(id), data, { httpMetadata: { contentType: type } });
    try {
        await env.DB.prepare(`INSERT INTO uploads (id, thread_id, kind, bytes, content_type, created_at) VALUES (?1, NULL, NULL, ?2, ?3, ${NOW})`)
            .bind(id, data.length, type)
            .run();
    } catch (e) {
        // not saved after all: take back the file no row would ever list
        await bucket.delete(fileKey(id));
        throw e;
    }
    return json({ id, bytes: data.length }, 201);
}

function isImage(type: string, d: Uint8Array): boolean {
    const ascii = (from: number, to: number) => String.fromCharCode(...d.subarray(from, to));
    if (type === 'image/png') return d.length > 8 && d[0] === 0x89 && ascii(1, 4) === 'PNG';
    return d.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}

async function getUpload(env: Env, id: string): Promise<Response> {
    if (!ID.test(id)) throw new HttpError(404, 'No such upload.');
    const row = await env.DB.prepare('SELECT content_type FROM uploads WHERE id = ?1').bind(id).first<{ content_type: string }>();
    const object = row ? await files(env).get(fileKey(id)) : null;
    if (!row || !object) throw new HttpError(404, 'No such upload.');
    // an upload never changes under its id, but it's private: kept by this browser only
    return new Response(object.body, {
        headers: {
            'content-type': row.content_type,
            'content-length': String(object.size),
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
        },
    });
}

// Screenshots deleted from the storage view. Their threads stay, and show they've lost them.
async function deleteUploads(env: Env, tell: Tell, input: Input): Promise<Response> {
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== 'string' || !ID.test(v))) throw new HttpError(400, 'Give the ids of the uploads to delete.');
    if (ids.length > MAX_DELETE_IDS) throw new HttpError(400, 'Delete at most ' + MAX_DELETE_IDS + ' at once.');
    const wanted = JSON.stringify([...new Set(ids)]);
    const { results } = await env.DB.prepare('SELECT id, thread_id FROM uploads WHERE id IN (SELECT value FROM json_each(?1))')
        .bind(wanted)
        .all<{ id: string; thread_id: string | null }>();
    if (!results.length) return json({ deleted: 0 });
    await removeFiles(
        env,
        results.map((r) => r.id),
    );
    const threads = [...new Set(results.map((r) => r.thread_id).filter((t): t is string => !!t))];
    await env.DB.batch([
        env.DB.prepare('DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?1))').bind(wanted),
        env.DB.prepare(`UPDATE threads SET updated_at = ${NOW} WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(threads)),
    ]);
    for (const t of threads) tell.thread({ id: t });
    return json({ deleted: results.length });
}

// What the screenshots and captures take up, from the sizes recorded as each was saved, largest first.
async function storage(env: Env): Promise<Response> {
    const { results } = await env.DB.prepare(
        `SELECT 'shot' AS kind, kind AS shot_kind, id, thread_id, bytes, created_at FROM uploads
         UNION ALL SELECT 'capture' AS kind, NULL AS shot_kind, thread_id AS id, thread_id, bytes, created_at FROM captures
         ORDER BY bytes DESC, created_at DESC`,
    ).all<StorageItem>();
    const total = { bytes: 0, shots: 0, captures: 0 };
    for (const item of results) {
        total.bytes += item.bytes;
        if (item.kind === 'shot') total.shots++;
        else total.captures++;
    }
    const body: Storage = { total, items: results };
    return json(body, 200, { 'cache-control': 'no-store' });
}

// ---- the board's screens

type ScreenFields = Omit<Screen, 'id' | 'created_at' | 'updated_at'>;

const screenOf = (row: Record<string, unknown>): Screen => ({
    ...(row as unknown as Screen),
    sizes: JSON.parse(String(row.sizes)) as Size[],
    steps: JSON.parse(String(row.steps)) as Step[],
});

// The fields given, checked. A new screen needs a name, a path and a size; its steps and place default to none and
// the board's top left.
function screenFields(input: Input, before: ScreenFields | null): ScreenFields {
    const has = (k: string) => input[k] !== undefined;
    const out: ScreenFields = before ? { ...before } : { name: '', path: '', sizes: [], steps: [], x: 0, y: 0 };
    if (has('name') || !before) {
        const name = short(input.name, 200);
        if (!name) throw new HttpError(400, 'Name the screen.');
        out.name = name;
    }
    if (has('path') || !before) {
        const p = typeof input.path === 'string' ? input.path.trim() : '';
        // a path on the app's own host, so its frame stays on this origin
        if (!p.startsWith('/') || p.startsWith('//') || p.length > 2000) throw new HttpError(400, "Give the screen's path on the app, starting with /.");
        out.path = p;
    }
    if (has('sizes') || !before) {
        const sizes = input.sizes;
        if (!Array.isArray(sizes) || !sizes.length || sizes.some((s) => typeof s !== 'string' || !Object.hasOwn(SIZES, s)))
            throw new HttpError(400, 'Give the sizes as phone, tablet or desktop.');
        out.sizes = [...new Set(sizes as Size[])];
    }
    if (has('steps')) {
        const steps = input.steps;
        if (!Array.isArray(steps) || steps.some((s) => !isObject(s) || typeof s.kind !== 'string')) throw new HttpError(400, 'Give the steps as a list.');
        if (JSON.stringify(steps).length > MAX_SCREEN_STEPS_BYTES) throw new HttpError(413, 'Those steps are too many to save.');
        out.steps = steps as Step[];
    }
    for (const k of ['x', 'y'] as const) {
        if (!has(k)) continue;
        const n = Number(input[k]);
        if (typeof input[k] === 'boolean' || !Number.isFinite(n)) throw new HttpError(400, "Give the screen's place on the board as numbers.");
        out[k] = Math.round(n * 10) / 10;
    }
    return out;
}

async function listScreens(env: Env): Promise<Response> {
    const { results } = await env.DB.prepare('SELECT * FROM screens ORDER BY created_at, rowid').all<Record<string, unknown>>();
    return json({ screens: results.map(screenOf) }, 200, { 'cache-control': 'no-store' });
}

async function screenById(env: Env, id: string): Promise<Screen | null> {
    const row = await env.DB.prepare('SELECT * FROM screens WHERE id = ?1').bind(id).first<Record<string, unknown>>();
    return row ? screenOf(row) : null;
}

async function createScreen(env: Env, tell: Tell, input: Input): Promise<Response> {
    const s = screenFields(input, null);
    const id = newId();
    await env.DB.prepare(
        `INSERT INTO screens (id, name, path, sizes, steps, x, y, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ${NOW}, ${NOW})`,
    )
        .bind(id, s.name, s.path, JSON.stringify(s.sizes), JSON.stringify(s.steps), s.x, s.y)
        .run();
    tell.screens();
    return json({ screen: await screenById(env, id) }, 201);
}

async function editScreen(env: Env, tell: Tell, id: string, input: Input): Promise<Response> {
    const before = await screenById(env, id);
    if (!before) throw new HttpError(404, 'No such screen.');
    const s = screenFields(input, before);
    await env.DB.prepare(`UPDATE screens SET name = ?2, path = ?3, sizes = ?4, steps = ?5, x = ?6, y = ?7, updated_at = ${NOW} WHERE id = ?1`)
        .bind(id, s.name, s.path, JSON.stringify(s.sizes), JSON.stringify(s.steps), s.x, s.y)
        .run();
    tell.screens();
    return json({ screen: await screenById(env, id) });
}

async function deleteScreen(env: Env, tell: Tell, id: string): Promise<Response> {
    const res = await env.DB.prepare('DELETE FROM screens WHERE id = ?1').bind(id).run();
    if (!res.meta.changes) throw new HttpError(404, 'No such screen.');
    tell.screens();
    return json({ deleted: true });
}

// ---- helpers

const short = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function newId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

async function shortHash(s: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

// ---- the GitHub inbox

// The message is a pointer: Claude runs `canvas show <code>` for the rest. It goes to the open pull request for the
// branch the app was built from, so the session working on that branch wakes up; a build from a branch with none
// (main, say) goes to the inbox pull request, INBOX_PR. It's posted with the GITHUB_TOKEN secret, a fine-grained
// personal access token for this repository alone that can write pull requests and nothing else, so it shows under the
// owner's GitHub name. Without one it's posted by a GitHub App installed on this repository alone: GITHUB_APP_ID is the
// app's ID and the GITHUB_APP_KEY secret its private key, as GitHub downloads it.
async function inbox(env: Env, url: URL, thread: Thread, event: Event): Promise<void> {
    const repo = env.GITHUB_REPO || '';
    const inboxPr = String(env.INBOX_PR || '').trim();
    const signedIn = env.GITHUB_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_KEY);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !signedIn || (!/^\d+$/.test(inboxPr) && !thread.branch)) {
        if (!inboxOffLogged)
            console.info(
                'GitHub inbox off: set GITHUB_REPO, INBOX_PR, and the GITHUB_TOKEN secret (or GITHUB_APP_ID and the GITHUB_APP_KEY secret) to post comments to pull requests.',
            );
        inboxOffLogged = true;
        return;
    }
    try {
        const token = env.GITHUB_TOKEN ? env.GITHUB_TOKEN.trim() : await installationToken(env, repo);
        const pr = (await branchPr(repo, thread.branch, token)) ?? (/^\d+$/.test(inboxPr) ? inboxPr : null);
        if (!pr) return;
        const body = inboxMessage(thread, event, { link: url.origin + basePath(env) + '/', project: env.PROJECT || '' });
        await github('POST', '/repos/' + repo + '/issues/' + pr + '/comments', token, { body });
    } catch (e) {
        installation = null;
        console.error('GitHub inbox: ' + (e instanceof Error ? e.message : String(e)));
    }
}

// The open pull request from this branch, remembered for five minutes so a burst of comments asks GitHub once; a
// branch with none is remembered too. If GitHub can't say, the comment goes to the inbox and nothing is remembered.
async function branchPr(repo: string, branch: string | null, token: string): Promise<string | null> {
    if (!branch) return null;
    const known = branchPrs.get(branch);
    if (known && Date.now() < known.until) return known.pr;
    const owner = repo.split('/')[0];
    let pr: string | null;
    try {
        const pulls = await github<{ number: number }[]>('GET', '/repos/' + repo + '/pulls?head=' + encodeURIComponent(owner + ':' + branch) + '&state=open', token);
        pr = Array.isArray(pulls) && pulls[0] ? String(pulls[0].number) : null;
    } catch (e) {
        console.error('GitHub inbox: ' + (e instanceof Error ? e.message : String(e)));
        return null;
    }
    branchPrs.set(branch, { pr, until: Date.now() + PR_CACHE_MS });
    return pr;
}

// The app's token for its installation lasts an hour; it's kept until five minutes before then, and narrowed to this
// repository's pull requests.
async function installationToken(env: Env, repo: string): Promise<string> {
    if (installation && Date.now() < installation.until) return installation.token;
    const jwt = await appJwt(env.GITHUB_APP_ID || '', env.GITHUB_APP_KEY || '');
    const { id } = await github<{ id: number }>('GET', '/repos/' + repo + '/installation', jwt);
    const { token, expires_at } = await github<{ token: string; expires_at: string }>('POST', '/app/installations/' + id + '/access_tokens', jwt, {
        repositories: [repo.split('/')[1]],
        permissions: { pull_requests: 'write' },
    });
    installation = { token, until: Date.parse(expires_at) - 5 * 60 * 1000 };
    return token;
}

async function github<T = unknown>(method: string, path: string, token: string, body?: object): Promise<T> {
    const res = await fetch('https://api.github.com' + path, {
        method,
        headers: {
            authorization: 'Bearer ' + token,
            accept: 'application/vnd.github+json',
            'user-agent': 'canvas',
            'x-github-api-version': '2022-11-28',
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    // the query is left out of the log: it names the branch, which is a code fact but needn't be in every error
    if (!res.ok) throw new Error(method + ' ' + path.split('?')[0] + ': ' + res.status + ' ' + (await res.text()).slice(0, 300));
    return res.json();
}

// What GitHub sees of a thread (PLAN.md, "Privacy"): what happened, the thread's code, the project, and the element's
// component and source file, which are facts about the code. Never the comment's text (it can name a person), the
// page's URL (it can carry an ID), the element's words or selector, who wrote it, or anything from its capture: the
// pull request may be public.
// event: new, reply, reopen, edit or delete (a comment of the thread), or delete-thread.
export function inboxMessage(
    thread: Pick<Thread, 'id' | 'component' | 'source'>,
    event: Event,
    { link, project }: { link: string; project: string },
): string {
    const head = {
        new: 'New canvas comment',
        reply: 'Canvas reply',
        reopen: 'Canvas thread reopened',
        edit: 'Canvas comment edited',
        delete: 'Canvas comment deleted',
        'delete-thread': 'Canvas thread deleted: nothing more to do for it',
    }[event];
    const lines = ['**' + head + '** · ' + code(thread.id) + (project ? ' · ' + project : '')];
    if (thread.component || thread.source)
        lines.push(
            '- Element: ' + [thread.component ? code(thread.component) : '', thread.source ? code(thread.source) : ''].filter(Boolean).join(' at '),
        );
    if (event !== 'delete-thread')
        lines.push('Run ' + code('canvas show ' + thread.id) + ' for the comment and where it was made. [Open the thread](' + link + '?thread=' + thread.id + ')');
    lines.push('<!-- canvas ' + JSON.stringify({ thread: thread.id, event }) + ' -->');
    return lines.join('\n');
}

// Markdown that shows text exactly as written: no formatting, links or @mentions inside.
function code(text: string): string {
    const s = String(text).replace(/\s+/g, ' ');
    const run = Math.max(0, ...Array.from(s.matchAll(/`+/g), (m) => m[0].length));
    const f = '`'.repeat(run + 1);
    return run ? f + ' ' + s + ' ' + f : f + s + f;
}
