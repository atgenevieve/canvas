// The canvas Worker on Miniflare: who may ask (Cloudflare Access, a service token, or localhost under wrangler dev),
// the threads API on a real local D1 under the base path, and the GitHub inbox against a mocked GitHub, signed in as
// the GitHub App. The inbox is a pointer only: these tests check what it leaves out as closely as what it says.
import { createPrivateKey, createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { Miniflare, Request as MfRequest, Response, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appJwt } from '../src/github-app.ts';

interface CommentJson {
    id: string;
    author: string;
    body: string;
    edited_at: string | null;
}
interface ThreadJson {
    id: string;
    status: string;
    comments: CommentJson[];
    [column: string]: unknown;
}
interface Posted {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: { body: string };
}

// the app's key, in the PKCS #1 form GitHub downloads
const KEYS = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const jwtPayload = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const jwtSigned = (jwt: string) => {
    const [head, payload, signature] = jwt.split('.');
    return createVerify('RSA-SHA256')
        .update(head + '.' + payload)
        .verify(KEYS.publicKey, Buffer.from(signature, 'base64url'));
};
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '../migrations');
const ORIGIN = 'https://preview.example.org';
const BASE = '/__canvas';
const OWNER = 'owner@example.org';
// what Access forwards for a service token: a JWT naming the token, and no email
const SERVICE_JWT = ['e30', Buffer.from(JSON.stringify({ common_name: '1a2b3c.access', type: 'app' })).toString('base64url'), 'sig'].join('.');
// what the overlay sends for an element, with fictional values that must never reach GitHub
const ELEMENT = {
    url: ORIGIN + '/people/4821?tab=notes',
    selector: 'main > ul.people > li:nth-of-type(3) > button.chip',
    words: 'Jordan Alvarez',
    component: 'PersonRow › Chip',
    source: 'src/client/people/person-row.tsx:42',
    branch: 'claude/people-chips',
    commit: '0123456789abcdef0123456789abcdef01234567',
    viewport: '390x844',
    x: 120.26,
    y: 340,
};
const BODY = 'Make "Jordan" bold, and call jordan@example.org';

// the Worker as wrangler would bundle it. It's written inside the checkout: workerd won't load a module from outside
// the directory it starts in.
const SCRIPT = path.join(HERE, '../.wrangler/test-build/worker.js');
buildSync({ entryPoints: [path.join(HERE, '../src/worker.ts')], bundle: true, format: 'esm', target: 'es2023', outfile: SCRIPT, logLevel: 'silent' });

// the canvas page, deployed with the Worker
function assets(request: MfRequest) {
    const { pathname } = new URL(request.url);
    if (pathname === '/index.html') return new Response('<!doctype html><title>Canvas</title>', { headers: { 'content-type': 'text/html' } });
    return new Response('Not found', { status: 404 });
}

async function start(bindings: Record<string, string>, outbound: (request: MfRequest) => Promise<Response>) {
    const mf = new Miniflare(
        convertV4MiniflareOptions({
        modules: true,
        scriptPath: SCRIPT,
        compatibilityDate: '2026-08-15',
        d1Databases: { DB: 'canvas-test' },
        r2Buckets: { FILES: 'canvas-files-test' },
        bindings,
        serviceBindings: { ASSETS: assets },
        outboundService: outbound,
        }),
    );
    const db = await mf.getD1Database('DB');
    for (const f of fs.readdirSync(MIGRATIONS).sort()) {
        const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/^--.*$/gm, '');
        for (const stmt of sql
            .split(/;\s*$/m)
            .map((s) => s.trim())
            .filter(Boolean))
            await db.prepare(stmt).run();
    }
    return { mf, db };
}

type Call = { method?: string; body?: unknown; headers?: Record<string, string>; user?: string | null; origin?: string };

describe('the canvas Worker', () => {
    const github: Posted[] = [];
    // the app signing in: finding its installation, then a token for it
    const app: { call: string; auth: string | null; body?: unknown }[] = [];
    let mf: Miniflare;
    let db: Awaited<ReturnType<Miniflare['getD1Database']>>;

    beforeAll(async () => {
        // the key as pasted into a one-line field, with its line breaks gone
        const bindings = {
            PROJECT: 'my-app',
            GITHUB_REPO: 'owner/repo',
            INBOX_PR: '7',
            GITHUB_APP_ID: '12345',
            GITHUB_APP_KEY: KEYS.privateKey.replace(/\n/g, ''),
        };
        ({ mf, db } = await start(bindings, async (request) => {
            const { pathname } = new URL(request.url);
            const auth = request.headers.get('authorization');
            if (pathname === '/repos/owner/repo/installation') {
                app.push({ call: request.method + ' ' + pathname, auth });
                return jsonResponse({ id: 42 });
            }
            if (pathname === '/app/installations/42/access_tokens') {
                app.push({ call: request.method + ' ' + pathname, auth, body: await request.json() });
                return jsonResponse({ token: 'installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
            }
            github.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: (await request.json()) as Posted['body'] });
            return jsonResponse({ id: github.length }, 201);
        }));
    });
    afterAll(() => mf?.dispose());

    const call = (p: string, { method = 'GET', body, headers = {}, user = OWNER, origin = ORIGIN }: Call = {}) => {
        const h: Record<string, string> = { ...(user ? { 'cf-access-authenticated-user-email': user } : {}), ...headers };
        if (body !== undefined) Object.assign(h, { 'content-type': 'application/json', origin }, headers);
        return mf.dispatchFetch(ORIGIN + BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    };
    const post = async (p: string, body: unknown = {}, opts: Call = {}) => call(p, { method: 'POST', body, ...opts });
    const inboxCount = async (n: number) => {
        for (let i = 0; i < 50 && github.length < n; i++) await wait(40);
        return github.length;
    };
    // every message on its way has arrived: nothing new for 150 ms
    const settle = async () => {
        for (let n = -1; n !== github.length; ) {
            n = github.length;
            await wait(150);
        }
        return github.length;
    };
    const newThread = async (extra: Record<string, unknown> = {}, opts: Call = {}): Promise<ThreadJson> => {
        const res = await post('/api/threads', { ...ELEMENT, body: BODY, ...extra }, opts);
        expect(res.status).toBe(201);
        return ((await res.json()) as { thread: ThreadJson }).thread;
    };
    // a pointer message: none of what the comment says, where it was made, or who made it
    const expectPointerOnly = (body: string) => {
        for (const secret of [BODY, 'Jordan', 'jordan@example.org', OWNER, ELEMENT.url, '/people/4821', ELEMENT.selector, ELEMENT.words]) expect(body).not.toContain(secret);
    };

    it('turns away anyone Cloudflare Access did not let through', async () => {
        expect((await call('/', { user: null })).status).toBe(403);
        expect((await call('/api/threads', { user: null })).status).toBe(403);
        // a JWT that names no service token is no one
        expect((await call('/api/threads', { user: null, headers: { 'cf-access-jwt-assertion': 'e30.e30.sig' } })).status).toBe(403);
    });

    it('serves the canvas under its base path only, to an Access user and to localhost without Access', async () => {
        const page = await call('/');
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('<title>Canvas</title>');
        const bare = await mf.dispatchFetch(ORIGIN + BASE + '?thread=abc', { headers: { 'cf-access-authenticated-user-email': OWNER }, redirect: 'manual' });
        expect(bare.status).toBe(308);
        expect(bare.headers.get('location')).toBe(ORIGIN + BASE + '/?thread=abc');
        expect((await mf.dispatchFetch(ORIGIN + '/api/threads', { headers: { 'cf-access-authenticated-user-email': OWNER } })).status).toBe(404);
        const local = await mf.dispatchFetch('http://localhost:8787' + BASE + '/api/threads');
        expect(((await local.json()) as { me: string }).me).toBe('you@localhost');
    });

    it('starts a thread as the Access user, whatever the request body claims, with the element and the build', async () => {
        const t = await newThread({ author: 'claude', created_by: 'claude', user: 'someone@example.org' });
        expect(t.created_by).toBe(OWNER);
        expect(t.comments).toHaveLength(1);
        expect(t.comments[0]).toMatchObject({ author: OWNER, body: BODY });
        expect(t).toMatchObject({
            url: ELEMENT.url,
            selector: ELEMENT.selector,
            words: 'Jordan Alvarez',
            component: 'PersonRow › Chip',
            source: 'src/client/people/person-row.tsx:42',
            branch: 'claude/people-chips',
            commit_sha: ELEMENT.commit,
            viewport: '390x844',
            status: 'open',
            x: 120.3,
            y: 340,
            w: null,
        });
        const list = (await (await call('/api/threads')).json()) as { me: string; threads: ThreadJson[] };
        expect(list.me).toBe(OWNER);
        expect(list.threads.map((x) => x.id)).toContain(t.id);
        const one = (await (await call('/api/threads/' + t.id)).json()) as { thread: ThreadJson };
        expect(one.thread.comments[0].body).toBe(BODY);
        expect((await call('/api/threads/zzzzzzzz')).status).toBe(404);
    });

    it('announces a new comment on the inbox pull request as a pointer: its code, project, component and source, a link', async () => {
        const before = await settle();
        const t = await newThread();
        expect(await inboxCount(before + 1)).toBe(before + 1);
        const sent = github[before];
        expect(sent.url).toBe('https://api.github.com/repos/owner/repo/issues/7/comments');
        expect(sent.method).toBe('POST');
        expect(sent.headers.authorization).toBe('Bearer installation-token');
        expect(sent.headers['user-agent']).toBe('canvas');
        expect(sent.body.body).toBe(
            [
                '**New canvas comment** · `' + t.id + '` · my-app',
                '- Element: `PersonRow › Chip` at `src/client/people/person-row.tsx:42`',
                'Run `canvas show ' + t.id + '` for the comment and where it was made. [Open the thread](' + ORIGIN + BASE + '/?thread=' + t.id + ')',
                '<!-- canvas {"thread":"' + t.id + '","event":"new"} -->',
            ].join('\n'),
        );
        expectPointerOnly(sent.body.body);
    });

    it('leaves out the element line when the thread has no component or source', async () => {
        const before = await settle();
        await newThread({ component: undefined, source: undefined });
        await inboxCount(before + 1);
        expect(github[before].body.body).not.toContain('Element:');
        expectPointerOnly(github[before].body.body);
    });

    it("signs in as the GitHub App once, for this repository's pull requests only, and keeps the token", async () => {
        const before = await settle();
        await newThread();
        await newThread();
        expect(await inboxCount(before + 2)).toBe(before + 2);
        expect(app.map((a) => a.call)).toEqual(['GET /repos/owner/repo/installation', 'POST /app/installations/42/access_tokens']);
        expect(app[1].body).toEqual({ repositories: ['repo'], permissions: { pull_requests: 'write' } });
        for (const { auth } of app) {
            const jwt = (auth || '').replace(/^Bearer /, '');
            expect(jwtSigned(jwt)).toBe(true);
            const { iss, iat, exp } = jwtPayload(jwt);
            expect(iss).toBe('12345');
            expect(exp - iat).toBeLessThanOrEqual(600);
        }
    });

    it('records a reply, and the inbox hears of it without its text', async () => {
        const t = await newThread();
        const before = await settle();
        const res = await post('/api/threads/' + t.id + '/comments', { body: 'Also Ruth Adeyemi, the row under it', author: 'claude' });
        expect(res.status).toBe(201);
        const { thread } = (await res.json()) as { thread: ThreadJson };
        expect(thread.comments.map((c) => [c.author, c.body])).toEqual([
            [OWNER, BODY],
            [OWNER, 'Also Ruth Adeyemi, the row under it'],
        ]);
        expect(await inboxCount(before + 1)).toBe(before + 1);
        const body = github[before].body.body;
        expect(body).toContain('**Canvas reply** · `' + t.id + '`');
        expect(body).toContain('<!-- canvas {"thread":"' + t.id + '","event":"reply"} -->');
        expect(body).not.toContain('Ruth');
        expectPointerOnly(body);
    });

    it('resolves without a message to the inbox, and tells it about a reopen', async () => {
        const t = await newThread();
        const before = await settle();
        const r1 = await post('/api/threads/' + t.id + '/resolve');
        expect(((await r1.json()) as { thread: ThreadJson }).thread).toMatchObject({ status: 'resolved', resolved_by: OWNER });
        await wait(200);
        expect(github.length).toBe(before);
        const r2 = await post('/api/threads/' + t.id + '/reopen');
        expect(((await r2.json()) as { thread: ThreadJson }).thread).toMatchObject({ status: 'open', resolved_by: null });
        expect(await inboxCount(before + 1)).toBe(before + 1);
        expect(github[before].body.body).toContain('**Canvas thread reopened**');
        expectPointerOnly(github[before].body.body);
    });

    it("takes an Access service token's requests as Claude's, and keeps Claude's writes off GitHub", async () => {
        const t = await newThread();
        const before = await settle();
        const claude = { user: null, headers: { 'cf-access-jwt-assertion': SERVICE_JWT } };
        expect(((await (await call('/api/threads', claude)).json()) as { me: string }).me).toBe('claude');
        const res = await post('/api/threads/' + t.id + '/comments', { body: 'Done: bold now.' }, claude);
        expect(res.status).toBe(201);
        expect(((await res.json()) as { thread: ThreadJson }).thread.comments.at(-1)).toMatchObject({ author: 'claude', body: 'Done: bold now.' });
        const resolved = await post('/api/threads/' + t.id + '/resolve', {}, claude);
        expect(((await resolved.json()) as { thread: ThreadJson }).thread).toMatchObject({ status: 'resolved', resolved_by: 'claude' });
        await wait(200);
        expect(github.length).toBe(before);
        // a person's email wins over a JWT that came with it
        expect(((await (await call('/api/threads', { headers: { 'cf-access-jwt-assertion': SERVICE_JWT } })).json()) as { me: string }).me).toBe(OWNER);
    });

    it('keeps code facts inert on GitHub: no formatting, links or mentions', async () => {
        const before = await settle();
        await newThread({ component: 'a `tick` @someone' });
        expect(await inboxCount(before + 1)).toBe(before + 1);
        expect(github[before].body.body).toContain('`` a `tick` @someone ``');
    });

    it('refuses cross-site and non-JSON writes', async () => {
        const send = (headers: Record<string, string>) => post('/api/threads', { url: ORIGIN + '/', body: 'x' }, { headers });
        expect((await send({ origin: 'https://evil.example.org' })).status).toBe(403);
        expect((await send({ 'content-type': 'text/plain' })).status).toBe(415);
        const noOrigin = await mf.dispatchFetch(ORIGIN + BASE + '/api/threads', {
            method: 'POST',
            headers: { 'cf-access-authenticated-user-email': OWNER, 'content-type': 'application/json' },
            body: '{}',
        });
        expect(noOrigin.status).toBe(403);
    });

    it('rejects a thread without a URL, an empty comment, a bad point, and an unknown thread', async () => {
        expect((await post('/api/threads', { body: 'x' })).status).toBe(400);
        expect((await post('/api/threads', null)).status).toBe(400);
        expect((await post('/api/threads', { url: ORIGIN + '/', body: '   ' })).status).toBe(400);
        expect((await post('/api/threads', { url: ORIGIN + '/', x: 'a', y: 1, body: 'x' })).status).toBe(400);
        expect((await post('/api/threads', { url: ORIGIN + '/', w: 10, h: 10, body: 'x' })).status).toBe(400);
        expect((await post('/api/threads/zzzzzzzz/comments', { body: 'x' })).status).toBe(404);
        expect((await post('/api/threads/zzzzzzzz/resolve')).status).toBe(404);
        expect((await call('/api/threads', { method: 'DELETE' })).status).toBe(405);
    });

    it('keeps a pin on the page, and a thread needs no point at all', async () => {
        const t = await newThread({ x: -50, y: 99999 });
        expect([t.x, t.y]).toEqual([0, 99999]);
        const bare = await newThread({ x: undefined, y: undefined });
        expect([bare.x, bare.y]).toEqual([null, null]);
    });

    it('pins a thread to an area dragged out, with no element', async () => {
        const t = await newThread({ x: 300, y: 800, w: 500, h: 2 });
        expect([t.x, t.y, t.w, t.h]).toEqual([300, 800, 500, 4]);
        expect([t.selector, t.words, t.component, t.source]).toEqual([null, null, null, null]);
        expect(t.url).toBe(ELEMENT.url);
    });

    it('lets the author edit and delete their own comments, tells the inbox, and deletes a thread with its first', async () => {
        const t = await newThread({ body: 'First words' });
        const first = t.comments[0].id;
        const replied = (await (await post('/api/threads/' + t.id + '/comments', { body: 'A reply' })).json()) as { thread: ThreadJson };
        const reply = replied.thread.comments[1].id;
        await db
            .prepare("INSERT INTO comments (id, thread_id, author, body, created_at) VALUES ('claude01', ?1, 'claude', 'Done', '2999-01-01T00:00:00.000Z')")
            .bind(t.id)
            .run();
        const before = await settle();
        const edited = await post('/api/comments/' + first + '/edit', { body: 'Better words' });
        expect(edited.status).toBe(200);
        const et = ((await edited.json()) as { thread: ThreadJson }).thread;
        expect(et.comments[0].body).toBe('Better words');
        expect(et.comments[0].edited_at).toBeTruthy();
        await inboxCount(before + 1);
        expect(github[before].body.body).toContain('**Canvas comment edited**');
        expect(github[before].body.body).not.toContain('Better words');
        // not someone else's
        expect((await post('/api/comments/claude01/edit', { body: 'x' })).status).toBe(403);
        expect((await post('/api/comments/claude01/delete')).status).toBe(403);
        expect((await post('/api/comments/nothere1/edit', { body: 'x' })).status).toBe(404);
        expect((await post('/api/comments/' + first + '/edit', { body: 'x' }, { origin: 'https://evil.example.org' })).status).toBe(403);
        // a reply goes alone
        const dr = (await (await post('/api/comments/' + reply + '/delete')).json()) as { thread: ThreadJson };
        expect(dr.thread.comments.map((c) => c.id)).toEqual([first, 'claude01']);
        // the first takes the thread
        const dt = (await (await post('/api/comments/' + first + '/delete')).json()) as { deleted: boolean };
        expect(dt.deleted).toBe(true);
        const all = (await (await call('/api/threads')).json()) as { threads: ThreadJson[] };
        expect(all.threads.some((x) => x.id === t.id)).toBe(false);
        expect(await db.prepare('SELECT count(*) AS n FROM comments WHERE thread_id = ?1').bind(t.id).first('n')).toBe(0);
        await inboxCount(before + 3);
        const gone = github[before + 2].body.body;
        expect(gone).toContain('**Canvas thread deleted: nothing more to do for it**');
        expect(gone).not.toContain('Open the thread');
        expect(gone).not.toContain('First words');
    });

    it("answers polling with 304 until something changes, Claude's writes included", async () => {
        const first = await call('/api/threads');
        const etag = first.headers.get('etag') || '';
        expect(etag).toBeTruthy();
        expect((await call('/api/threads', { headers: { 'if-none-match': etag } })).status).toBe(304);
        const { id } = ((await first.json()) as { threads: ThreadJson[] }).threads[0];
        await post('/api/threads/' + id + '/comments', { body: 'Done' }, { user: null, headers: { 'cf-access-jwt-assertion': SERVICE_JWT } });
        const after = await call('/api/threads', { headers: { 'if-none-match': etag } });
        expect(after.status).toBe(200);
        const t = ((await after.json()) as { threads: ThreadJson[] }).threads.find((x) => x.id === id);
        expect(t?.comments.at(-1)).toMatchObject({ author: 'claude', body: 'Done' });
    });
});

describe("the GitHub App's own token", () => {
    it('is signed with the key as GitHub downloads it, as PKCS #8, or pasted without line breaks', async () => {
        const now = Date.parse('2026-10-08T20:00:00Z');
        const pkcs8 = createPrivateKey(KEYS.privateKey).export({ type: 'pkcs8', format: 'pem' }).toString();
        for (const pem of [KEYS.privateKey, pkcs8, KEYS.privateKey.replace(/\n/g, ' '), KEYS.privateKey.replace(/\n/g, '\\n')]) {
            const jwt = await appJwt('12345', pem, now);
            expect(jwtSigned(jwt)).toBe(true);
            expect(jwtPayload(jwt)).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '12345' });
        }
    });
});

describe('the canvas Worker with a personal access token', () => {
    let mf: Miniflare;
    const outbound: { call: string; auth: string | null; body: { body: string } }[] = [];
    beforeAll(async () => {
        // the token wins over the app's settings, and a pasted line break doesn't matter
        const bindings = { GITHUB_REPO: 'owner/repo', INBOX_PR: '7', GITHUB_TOKEN: 'github_pat_test\n', GITHUB_APP_ID: '12345', GITHUB_APP_KEY: KEYS.privateKey };
        ({ mf } = await start(bindings, async (request) => {
            outbound.push({ call: request.method + ' ' + new URL(request.url).pathname, auth: request.headers.get('authorization'), body: (await request.json()) as { body: string } });
            return jsonResponse({ id: outbound.length }, 201);
        }));
    });
    afterAll(() => mf?.dispose());

    it('posts each comment with the token, and never signs in as the app', async () => {
        const res = await mf.dispatchFetch(ORIGIN + BASE + '/api/threads', {
            method: 'POST',
            headers: { 'cf-access-authenticated-user-email': OWNER, 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify({ url: ORIGIN + '/', body: 'Bigger, please' }),
        });
        expect(res.status).toBe(201);
        for (let i = 0; i < 50 && !outbound.length; i++) await wait(40);
        expect(outbound).toHaveLength(1);
        expect(outbound[0]).toMatchObject({ call: 'POST /repos/owner/repo/issues/7/comments', auth: 'Bearer github_pat_test' });
        expect(outbound[0].body.body).toContain('**New canvas comment**');
        expect(outbound[0].body.body).not.toContain('Bigger, please');
    });
});

describe('the canvas Worker at another base path, without the inbox settings', () => {
    let mf: Miniflare;
    const outbound: string[] = [];
    beforeAll(async () => {
        ({ mf } = await start({ INBOX_PR: '', BASE_PATH: '/review/' }, async (request) => {
            outbound.push(request.url);
            return new Response('{}', { status: 201 });
        }));
    });
    afterAll(() => mf?.dispose());

    it('serves its base path, saves comments and posts nothing', async () => {
        const headers = { 'cf-access-authenticated-user-email': OWNER, 'content-type': 'application/json', origin: ORIGIN };
        expect((await mf.dispatchFetch(ORIGIN + '/__canvas/api/threads', { headers })).status).toBe(404);
        for (const body of ['first', 'second']) {
            const res = await mf.dispatchFetch(ORIGIN + '/review/api/threads', { method: 'POST', headers, body: JSON.stringify({ url: ORIGIN + '/', body }) });
            expect(res.status).toBe(201);
        }
        await wait(300);
        expect(outbound).toEqual([]);
    });
});
