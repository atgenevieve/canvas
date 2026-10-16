// The canvas service: one deployment per project, routed at /__canvas/* (BASE_PATH) on the app's own preview and test
// hosts, so the overlay in the app calls it on the app's own origin. It serves the canvas page (public/, deployed with
// the Worker) and a small JSON API for comment threads, kept in D1. Cloudflare Access stands in front of the whole host
// and says who is asking; the Worker trusts nothing else for that, and turns away any request that didn't come through
// Access. Each comment a person writes is also announced on a GitHub pull request (the inbox), so a Claude session
// wakes up for it. That message is a pointer only: the thread's code and code-level facts, never what the comment
// says or where it was written (PLAN.md, "Privacy"). Claude reads and answers through the canvas CLI, which calls this
// same API with an Access service token.
//
//   GET  /api/threads                     every thread with its comments, and who is asking ({ me, threads })
//   GET  /api/threads/:id                 one thread with its comments ({ me, thread })
//   POST /api/threads                     { url, selector?, words?, component?, source?, branch?, commit?, viewport?,
//                                           x?, y?, w?, h?, body } starts a thread (w, h: an area)
//   POST /api/threads/:id/comments        { body } replies
//   POST /api/threads/:id/resolve         resolves; /reopen opens it again
//   POST /api/comments/:id/edit           { body } changes a comment's text (its author only)
//   POST /api/comments/:id/delete         deletes a comment (its author only); a thread's first comment takes the thread
//                                         ({ deleted: true })
//
// The paths above are under BASE_PATH: /__canvas/api/threads, and so on.

import { appJwt } from './github-app.ts';

export interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    // for screenshots, from step 4 of PLAN.md; nothing uses it yet
    FILES?: R2Bucket;
    BASE_PATH?: string;
    PROJECT?: string;
    GITHUB_REPO?: string;
    INBOX_PR?: string;
    GITHUB_TOKEN?: string;
    GITHUB_APP_ID?: string;
    GITHUB_APP_KEY?: string;
}

interface Thread {
    id: string;
    url: string;
    selector: string | null;
    words: string | null;
    component: string | null;
    source: string | null;
    branch: string | null;
    commit_sha: string | null;
    viewport: string | null;
    x: number | null;
    y: number | null;
    w: number | null;
    h: number | null;
    status: 'open' | 'resolved';
    created_by: string;
    created_at: string;
    updated_at: string;
    resolved_by: string | null;
    resolved_at: string | null;
    comments: Comment[];
}

interface Comment {
    id: string;
    thread_id: string;
    author: string;
    body: string;
    created_at: string;
    edited_at: string | null;
}

type Input = Record<string, unknown>;
type Event = 'new' | 'reply' | 'reopen' | 'edit' | 'delete' | 'delete-thread';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// wrangler dev has no Access in front of it: requests to localhost are this person
const LOCAL_USER = 'you@localhost';
// who a request made with an Access service token is: the canvas CLI, run by Claude
const CLAUDE = 'claude';
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID = /^[a-z0-9]{8}$/;
const MAX_BODY = 10000;

let inboxOffLogged = false;
let installation: { token: string; until: number } | null = null;

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

// the canvas page itself, deployed with the Worker
function asset(request: Request, env: Env, url: URL, path: string): Promise<Response> {
    const target = new URL(path === '/' ? '/index.html' : path, url);
    return env.ASSETS.fetch(new Request(target, request));
}

async function api(request: Request, env: Env, ctx: ExecutionContext, url: URL, path: string, user: string): Promise<Response> {
    const [, , kind, id, action, extra] = path.split('/');
    if ((kind !== 'threads' && kind !== 'comments') || extra !== undefined) throw new HttpError(404, 'Not found.');
    if (request.method === 'GET' && kind === 'threads' && !id) return listThreads(request, env, user);
    if (request.method === 'GET' && kind === 'threads' && !action) return getThread(env, user, id);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    // a page elsewhere can't post here with a person's Access cookie: browsers send Origin on every POST (the CLI
    // sends its own)
    if (request.headers.get('origin') !== url.origin) throw new HttpError(403, 'Cross-site request.');
    const say = (thread: Thread | null, event: Event) => {
        // Claude's own replies stay on the canvas: they'd only wake Claude again
        if (thread && user !== CLAUDE) ctx.waitUntil(inbox(env, url, thread, event));
    };
    if (kind === 'comments') {
        if (!ID.test(id || '')) throw new HttpError(404, 'No such comment.');
        if (action === 'edit') return editComment(env, say, user, id, await readJson(request));
        if (action === 'delete') return deleteComment(env, say, user, id);
        throw new HttpError(404, 'Not found.');
    }
    const input = await readJson(request);
    if (!id) return createThread(env, say, user, input);
    if (!ID.test(id)) throw new HttpError(404, 'No such thread.');
    if (action === 'comments') return addComment(env, say, user, id, input);
    if (action === 'resolve' || action === 'reopen') return setStatus(env, say, user, id, action);
    throw new HttpError(404, 'Not found.');
}

type Say = (thread: Thread | null, event: Event) => void;

async function readJson(request: Request): Promise<Input> {
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
    let input: unknown;
    try {
        input = await request.json();
    } catch {
        throw new HttpError(400, 'Send JSON.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Send a JSON object.');
    return input as Input;
}

async function listThreads(request: Request, env: Env, user: string): Promise<Response> {
    // the list's version: polling gets a 304 until something changes
    const stamp = await env.DB.prepare(
        'SELECT (SELECT count(*) FROM threads) AS t, (SELECT count(*) FROM comments) AS c, (SELECT max(updated_at) FROM threads) AS u',
    ).first<{ t: number; c: number; u: string | null }>();
    const etag = 'W/"' + (await shortHash([user, stamp?.t, stamp?.c, stamp?.u].join('|'))) + '"';
    const headers = { etag, 'cache-control': 'no-store' };
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    const [threads, comments] = await env.DB.batch<Record<string, unknown>>([
        env.DB.prepare('SELECT * FROM threads ORDER BY updated_at DESC'),
        env.DB.prepare('SELECT * FROM comments ORDER BY created_at, rowid'),
    ]);
    const byThread = new Map(threads.results.map((t) => [t.id, { ...t, comments: [] as unknown[] }]));
    for (const c of comments.results) byThread.get(c.thread_id)?.comments.push(c);
    return json({ me: user, threads: [...byThread.values()] }, 200, headers);
}

async function getThread(env: Env, user: string, id: string): Promise<Response> {
    const thread = ID.test(id) ? await threadOf(env, id) : null;
    if (!thread) throw new HttpError(404, 'No such thread.');
    return json({ me: user, thread }, 200, { 'cache-control': 'no-store' });
}

async function createThread(env: Env, say: Say, user: string, input: Input): Promise<Response> {
    const url = short(input.url, 2000);
    if (!url) throw new HttpError(400, "Give the page's URL.");
    const body = bodyOf(input);
    const point = (v: unknown) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new HttpError(400, 'Give the point on the page as numbers.');
        return Math.round(Math.max(n, 0) * 10) / 10;
    };
    const x = point(input.x);
    const y = point(input.y);
    // an area dragged out on the page: from x, y, at least 4 px each way; it has no element
    const area = input.w != null || input.h != null;
    const w = area ? Math.max(4, point(input.w) ?? 0) : null;
    const h = area ? Math.max(4, point(input.h) ?? 0) : null;
    if (area && (x == null || y == null)) throw new HttpError(400, "Give an area's top left, x and y.");
    const id = newId();
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO threads (id, url, selector, words, component, source, branch, commit_sha, viewport, x, y, w, h, status, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'open', ?14, ${NOW}, ${NOW})`,
        ).bind(
            id,
            url,
            area ? null : short(input.selector, 1000),
            area ? null : short(input.words, 200),
            area ? null : short(input.component, 300),
            area ? null : short(input.source, 300),
            short(input.branch, 200),
            short(input.commit, 64),
            short(input.viewport, 40),
            x,
            y,
            w,
            h,
            user,
        ),
        env.DB.prepare(`INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?1, ?2, ?3, ?4, ${NOW})`).bind(newId(), id, user, body),
    ]);
    const thread = await threadOf(env, id);
    say(thread, 'new');
    return json({ thread }, 201);
}

async function addComment(env: Env, say: Say, user: string, id: string, input: Input): Promise<Response> {
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
    say(thread, 'reply');
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

async function editComment(env: Env, say: Say, user: string, id: string, input: Input): Promise<Response> {
    const body = bodyOf(input);
    const c = await ownComment(env, user, id);
    await env.DB.batch([
        env.DB.prepare(`UPDATE comments SET body = ?1, edited_at = ${NOW} WHERE id = ?2`).bind(body, id),
        env.DB.prepare(`UPDATE threads SET updated_at = ${NOW} WHERE id = ?1`).bind(c.thread_id),
    ]);
    const thread = await threadOf(env, c.thread_id);
    say(thread, 'edit');
    return json({ thread });
}

// a thread's first comment is the thread: deleting it deletes the thread and its replies
async function deleteComment(env: Env, say: Say, user: string, id: string): Promise<Response> {
    const c = await ownComment(env, user, id);
    const before = await threadOf(env, c.thread_id);
    if (c.first === id) {
        await env.DB.batch([
            env.DB.prepare('DELETE FROM comments WHERE thread_id = ?1').bind(c.thread_id),
            env.DB.prepare('DELETE FROM threads WHERE id = ?1').bind(c.thread_id),
        ]);
        say(before, 'delete-thread');
        return json({ deleted: true });
    }
    await env.DB.batch([
        env.DB.prepare('DELETE FROM comments WHERE id = ?1').bind(id),
        env.DB.prepare(`UPDATE threads SET updated_at = ${NOW} WHERE id = ?1`).bind(c.thread_id),
    ]);
    say(before, 'delete');
    return json({ thread: await threadOf(env, c.thread_id) });
}

async function setStatus(env: Env, say: Say, user: string, id: string, action: 'resolve' | 'reopen'): Promise<Response> {
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
    if (res.meta.changes && action === 'reopen') say(thread, 'reopen');
    return json({ thread });
}

async function threadOf(env: Env, id: string): Promise<Thread | null> {
    const [t, c] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM threads WHERE id = ?1').bind(id),
        env.DB.prepare('SELECT * FROM comments WHERE thread_id = ?1 ORDER BY created_at, rowid').bind(id),
    ]);
    const row = t.results[0] as Omit<Thread, 'comments'> | undefined;
    return row ? { ...row, comments: c.results as Comment[] } : null;
}

function bodyOf(input: Input): string {
    const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : '';
    if (!body) throw new HttpError(400, 'Write a comment.');
    if (body.length > MAX_BODY) throw new HttpError(400, 'Keep a comment under ' + MAX_BODY + ' characters.');
    return body;
}

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

// The GitHub inbox. The message is a pointer: Claude runs `canvas show <code>` for the rest. It's posted with the
// GITHUB_TOKEN secret, a fine-grained personal access token for this repository alone that can write pull requests and
// nothing else, so it shows under the owner's GitHub name. Without one it's posted by a GitHub App installed on this
// repository alone: GITHUB_APP_ID is the app's ID and the GITHUB_APP_KEY secret its private key, as GitHub downloads it.
async function inbox(env: Env, url: URL, thread: Thread, event: Event): Promise<void> {
    const repo = env.GITHUB_REPO || '';
    const pr = String(env.INBOX_PR || '');
    const signedIn = env.GITHUB_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_KEY);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(pr) || !signedIn) {
        if (!inboxOffLogged)
            console.info('GitHub inbox off: set GITHUB_REPO, INBOX_PR, and the GITHUB_TOKEN secret (or GITHUB_APP_ID and the GITHUB_APP_KEY secret) to post comments to a pull request.');
        inboxOffLogged = true;
        return;
    }
    try {
        const token = env.GITHUB_TOKEN ? env.GITHUB_TOKEN.trim() : await installationToken(env, repo);
        const body = inboxMessage(thread, event, { link: url.origin + basePath(env) + '/', project: env.PROJECT || '' });
        await github('POST', '/repos/' + repo + '/issues/' + pr + '/comments', token, { body });
    } catch (e) {
        installation = null;
        console.error('GitHub inbox: ' + (e instanceof Error ? e.message : String(e)));
    }
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
    if (!res.ok) throw new Error(method + ' ' + path + ': ' + res.status + ' ' + (await res.text()).slice(0, 300));
    return res.json();
}

// What GitHub sees of a thread (PLAN.md, "Privacy"): what happened, the thread's code, the project, and the element's
// component and source file, which are facts about the code. Never the comment's text (it can name a person), the
// page's URL (it can carry an ID), the element's words or selector, or who wrote it: the pull request may be public.
// event: new, reply, reopen, edit or delete (a comment of the thread), or delete-thread.
export function inboxMessage(thread: Thread, event: Event, { link, project }: { link: string; project: string }): string {
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
