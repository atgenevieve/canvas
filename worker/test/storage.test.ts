// Screenshots, captures and deleting them, on Miniflare with a real local D1 and R2: uploads go up before the thread
// that names them, the thread claims them, the storage view lists what everything takes up, and nothing goes except
// by one of the delete calls.
import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, ORIGIN, OWNER, capture, client, jsonResponse, png, start, webp } from './miniflare.ts';

interface ThreadJson {
    id: string;
    has_capture: boolean;
    comments: { body: string }[];
    [column: string]: unknown;
}
interface StorageJson {
    total: { bytes: number; shots: number; captures: number };
    items: { kind: 'shot' | 'capture'; id: string; thread_id: string | null; bytes: number; created_at: string }[];
}

describe('screenshots, captures and the storage view', () => {
    let mf: Miniflare;
    let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
    let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
    let call: ReturnType<typeof client>['call'];
    let post: ReturnType<typeof client>['post'];

    beforeAll(async () => {
        // no inbox: these tests are about what's kept
        ({ mf, db } = await start({ INBOX_PR: '' }, async () => jsonResponse({})));
        bucket = await mf.getR2Bucket('FILES');
        ({ call, post } = client(mf));
    });
    afterAll(() => mf?.dispose());

    const upload = (data: Uint8Array, type: string, headers: Record<string, string> = {}) =>
        mf.dispatchFetch(ORIGIN + BASE + '/api/uploads', {
            method: 'POST',
            headers: { 'cf-access-authenticated-user-email': OWNER, origin: ORIGIN, 'content-type': type, ...headers },
            body: data,
        });
    const uploaded = async (data: Uint8Array, type = 'image/png') => {
        const res = await upload(data, type);
        expect(res.status).toBe(201);
        return (await res.json()) as { id: string; bytes: number };
    };
    const newThread = async (shots: Record<string, string> = {}) => {
        const res = await post('/api/threads', { body: 'The chip is cut off', capture: capture({ shots }) });
        expect(res.status).toBe(201);
        return ((await res.json()) as { thread: ThreadJson }).thread;
    };
    const storage = async () => (await (await call('/api/storage')).json()) as StorageJson;

    it('takes a PNG or WebP screenshot into R2, and gives it back as it went up', async () => {
        const image = png(300);
        const { id, bytes } = await uploaded(image);
        expect(id).toMatch(/^[a-z0-9]{8}$/);
        expect(bytes).toBe(300);
        const stored = await bucket.get('uploads/' + id);
        expect(stored?.httpMetadata?.contentType).toBe('image/png');
        const back = await call('/api/uploads/' + id);
        expect(back.status).toBe(200);
        expect(back.headers.get('content-type')).toBe('image/png');
        expect(back.headers.get('cache-control')).toContain('private');
        expect(new Uint8Array(await back.arrayBuffer())).toEqual(image);
        const w = await uploaded(webp(80), 'image/webp');
        expect((await call('/api/uploads/' + w.id)).headers.get('content-type')).toBe('image/webp');
        expect(await db.prepare('SELECT thread_id, kind, bytes, content_type FROM uploads WHERE id = ?1').bind(w.id).first()).toEqual({
            thread_id: null,
            kind: null,
            bytes: 80,
            content_type: 'image/webp',
        });
    });

    it('turns away anything but a WebP or PNG under 5 MB, and uploads from another site', async () => {
        expect((await upload(png(), 'image/gif')).status).toBe(415);
        expect((await upload(png(), 'image/svg+xml')).status).toBe(415);
        // the type says PNG, the bytes don't
        expect((await upload(webp(), 'image/png')).status).toBe(415);
        expect((await upload(new TextEncoder().encode('<svg onload="alert(1)">'), 'image/webp')).status).toBe(415);
        expect((await upload(new Uint8Array(0), 'image/png')).status).toBe(400);
        expect((await upload(png(5 * 1024 * 1024 + 1), 'image/png')).status).toBe(413);
        expect((await upload(png(), 'image/png', { origin: 'https://evil.example.org' })).status).toBe(403);
        expect((await call('/api/uploads/zzzzzzzz')).status).toBe(404);
        expect((await call('/api/uploads/../../x')).status).toBe(404);
        const before = await storage();
        expect(before.items.every((i) => i.bytes <= 5 * 1024 * 1024)).toBe(true);
    });

    it("links a capture's shots to its thread, and the capture says where to fetch them", async () => {
        const element = await uploaded(png(100));
        const screen = await uploaded(webp(200), 'image/webp');
        const t = await newThread({ element: element.id, screen: screen.id });
        expect(t.has_capture).toBe(true);
        const res = (await (await call('/api/threads/' + t.id + '/capture')).json()) as { capture: { shots: object }; shots: object };
        expect(res.shots).toEqual({ element: BASE + '/api/uploads/' + element.id, screen: BASE + '/api/uploads/' + screen.id });
        expect(res.capture.shots).toEqual({ element: element.id, screen: screen.id });
        const rows = await db.prepare('SELECT id, thread_id, kind FROM uploads WHERE thread_id = ?1 ORDER BY kind').bind(t.id).all();
        expect(rows.results).toEqual([
            { id: element.id, thread_id: t.id, kind: 'element' },
            { id: screen.id, thread_id: t.id, kind: 'screen' },
        ]);
        // a second thread naming the same screenshot doesn't take it
        const other = await newThread({ element: element.id });
        const theirs = (await (await call('/api/threads/' + other.id + '/capture')).json()) as { shots: object };
        expect(theirs.shots).toEqual({});
    });

    it('lists every screenshot and capture with its size, largest first, an unused upload with no thread', async () => {
        const big = await uploaded(png(4000));
        const t = await newThread({ screen: big.id });
        const lonely = await uploaded(png(3000));
        const { total, items } = await storage();
        expect(items.map((i) => i.bytes)).toEqual([...items.map((i) => i.bytes)].sort((a, b) => b - a));
        expect(items.find((i) => i.id === big.id)).toMatchObject({ kind: 'shot', thread_id: t.id, bytes: 4000 });
        expect(items.find((i) => i.id === lonely.id)).toMatchObject({ kind: 'shot', thread_id: null, bytes: 3000 });
        const cap = items.find((i) => i.kind === 'capture' && i.id === t.id);
        expect(cap).toMatchObject({ thread_id: t.id });
        expect(cap?.bytes).toBeGreaterThan(100);
        expect(total).toEqual({
            bytes: items.reduce((n, i) => n + i.bytes, 0),
            shots: items.filter((i) => i.kind === 'shot').length,
            captures: items.filter((i) => i.kind === 'capture').length,
        });
        expect(await db.prepare('SELECT count(*) AS n FROM uploads').first('n')).toBe(total.shots);
    });

    it("deletes a thread's capture and screenshots by hand, and keeps the thread, its comments and its element", async () => {
        const shot = await uploaded(png(500));
        const t = await newThread({ element: shot.id });
        const res = await post('/api/threads/' + t.id + '/capture/delete');
        expect(res.status).toBe(200);
        const { thread } = (await res.json()) as { thread: ThreadJson };
        expect(thread).toMatchObject({ id: t.id, has_capture: false, selector: t.selector, component: t.component, url: t.url });
        expect(thread.comments.map((c) => c.body)).toEqual(['The chip is cut off']);
        expect((await call('/api/threads/' + t.id + '/capture')).status).toBe(404);
        expect((await call('/api/uploads/' + shot.id)).status).toBe(404);
        expect(await bucket.head('uploads/' + shot.id)).toBeNull();
        const { items } = await storage();
        expect(items.some((i) => i.thread_id === t.id)).toBe(false);
        expect((await post('/api/threads/zzzzzzzz/capture/delete')).status).toBe(404);
        expect((await post('/api/threads/' + t.id + '/capture/delete', {}, { origin: 'https://evil.example.org' })).status).toBe(403);
    });

    it('deletes a whole thread by hand: its comments, capture and screenshots', async () => {
        const shot = await uploaded(png(600));
        const t = await newThread({ screen: shot.id });
        await post('/api/threads/' + t.id + '/comments', { body: 'And the row under it' });
        const res = await post('/api/threads/' + t.id + '/delete');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ deleted: true });
        expect((await call('/api/threads/' + t.id)).status).toBe(404);
        for (const table of ['comments', 'captures', 'uploads'])
            expect(await db.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE thread_id = ?1').bind(t.id).first('n')).toBe(0);
        expect(await bucket.head('uploads/' + shot.id)).toBeNull();
        expect((await post('/api/threads/' + t.id + '/delete')).status).toBe(404);
    });

    it('deletes screenshots picked in the storage view, and their threads keep the rest', async () => {
        const a = await uploaded(png(700));
        const b = await uploaded(png(800));
        const keep = await uploaded(png(900));
        const t = await newThread({ element: a.id, screen: keep.id });
        const res = await post('/api/uploads/delete', { ids: [a.id, b.id, a.id, 'nothere1'] });
        expect(await res.json()).toEqual({ deleted: 2 });
        expect(await bucket.head('uploads/' + a.id)).toBeNull();
        expect(await bucket.head('uploads/' + b.id)).toBeNull();
        expect(await bucket.head('uploads/' + keep.id)).not.toBeNull();
        const cap = (await (await call('/api/threads/' + t.id + '/capture')).json()) as { capture: { shots: object }; shots: object };
        expect(cap.shots).toEqual({ screen: BASE + '/api/uploads/' + keep.id });
        expect(cap.capture.shots).toEqual({ screen: keep.id });
        expect(await (await post('/api/uploads/delete', { ids: [] })).json()).toEqual({ deleted: 0 });
        expect((await post('/api/uploads/delete', { ids: ['../x'] })).status).toBe(400);
        expect((await post('/api/uploads/delete', { ids: 'all' })).status).toBe(400);
        expect((await post('/api/uploads/delete', {})).status).toBe(400);
    });

    it('never deletes on its own: reading everything leaves everything where it was', async () => {
        const before = await storage();
        await call('/api/threads');
        for (const item of before.items) if (item.kind === 'shot') await call('/api/uploads/' + item.id);
        expect(await storage()).toEqual(before);
    });
});
