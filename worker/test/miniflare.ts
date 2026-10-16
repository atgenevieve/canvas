// The canvas Worker on Miniflare, for every test file: bundled as wrangler would, with a real local D1 migrated from
// worker/migrations, an R2 bucket, the Live Durable Object, the public/ files as its assets, and every request to the
// outside world (GitHub) sent to a mock the test gives. Fictional values only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { Miniflare, Request as MfRequest, Response, convertV4MiniflareOptions } from 'miniflare';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '../migrations');
const PUBLIC = path.join(HERE, '../public');

export const ORIGIN = 'https://preview.example.org';
export const BASE = '/__canvas';
export const OWNER = 'owner@example.org';
// what Access forwards for a service token: a JWT naming the token, and no email
export const SERVICE_JWT = ['e30', Buffer.from(JSON.stringify({ common_name: '1a2b3c.access', type: 'app' })).toString('base64url'), 'sig'].join('.');

export const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// the Worker as wrangler would bundle it. It's written inside the checkout: workerd won't load a module from outside
// the directory it starts in.
const SCRIPT = path.join(HERE, '../.wrangler/test-build/worker.js');
buildSync({ entryPoints: [path.join(HERE, '../src/worker.ts')], bundle: true, format: 'esm', target: 'es2023', outfile: SCRIPT, logLevel: 'silent' });

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };

// the board and the overlay, deployed with the Worker from public/
function assets(request: MfRequest) {
    const { pathname } = new URL(request.url);
    const file = path.join(PUBLIC, pathname);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
}

export type Outbound = (request: MfRequest) => Promise<Response>;

export async function start(bindings: Record<string, string>, outbound: Outbound) {
    const mf = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            scriptPath: SCRIPT,
            compatibilityDate: '2026-08-15',
            d1Databases: { DB: 'canvas-test' },
            r2Buckets: { FILES: 'canvas-files-test' },
            durableObjects: { LIVE: { className: 'Live', useSQLite: true } },
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

export type Call = { method?: string; body?: unknown; headers?: Record<string, string>; user?: string | null; origin?: string };

// requests as the overlay, the board or the CLI make them: signed in through Access as OWNER unless told otherwise
export function client(mf: Miniflare) {
    const call = (p: string, { method = 'GET', body, headers = {}, user = OWNER, origin = ORIGIN }: Call = {}) => {
        const h: Record<string, string> = { ...(user ? { 'cf-access-authenticated-user-email': user } : {}), ...headers };
        if (body !== undefined) Object.assign(h, { 'content-type': 'application/json', origin }, headers);
        return mf.dispatchFetch(ORIGIN + BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    };
    const post = async (p: string, body: unknown = {}, opts: Call = {}) => call(p, { method: 'POST', body, ...opts });
    return { call, post };
}

// What the overlay sends for an element, with fictional values that must never reach GitHub. A test changes what it
// needs: el() for the element, capture() for the rest.
export const PAGE = ORIGIN + '/people/4821?tab=notes';
export const TYPED = 'Call Jordan at 555-0142';
export const el = (over: Record<string, unknown> = {}) => ({
    selector: 'main > ul.people > li:nth-of-type(3) > button.chip',
    words: 'Jordan Alvarez',
    tag: 'button',
    component: 'PersonRow › Chip',
    source: 'src/client/people/person-row.tsx:42',
    rect: { x: 120.26, y: 340, w: 80, h: 24 },
    ...over,
});
export const capture = (over: Record<string, unknown> = {}) => ({
    version: 1,
    element: el(),
    env: {
        url: PAGE,
        viewport: { w: 390, h: 844, dpr: 3 },
        scheme: 'light',
        userAgent: 'Mozilla/5.0 (test)',
        branch: 'claude/people-chips',
        commit: '0123456789abcdef0123456789abcdef01234567',
        at: '2026-10-15T12:00:00.000Z',
    },
    steps: [
        { t: 1, kind: 'click', selector: '#note', words: '', x: 10, y: 20 },
        { t: 2, kind: 'input', selector: '#note', label: 'Note', value: TYPED },
    ],
    errors: [{ t: 3, message: 'TypeError: x is undefined' }],
    failed: [{ t: 4, method: 'GET', url: ORIGIN + '/api/people/4821', status: 500, ms: 31 }],
    shots: {},
    ...over,
});
export const envWith = (over: Record<string, unknown>) => ({ ...capture().env, ...over });

// a tiny PNG and WebP: the right first bytes, then filler
export const png = (size = 64) => {
    const b = new Uint8Array(size);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let i = 8; i < size; i++) b[i] = i % 251;
    return b;
};
export const webp = (size = 64) => {
    const b = new Uint8Array(size);
    b.set(new TextEncoder().encode('RIFF'));
    b.set(new TextEncoder().encode('WEBP'), 8);
    return b;
};
