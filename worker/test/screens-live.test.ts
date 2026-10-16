// The board's screens and the Live WebSocket, on Miniflare: screens kept in D1, and every open page told when a
// thread or the screens change, with only what changed (an id), never what a thread says.
import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, ORIGIN, OWNER, SERVICE_JWT, capture, client, jsonResponse, png, start, wait } from './miniflare.ts';

interface ScreenJson {
    id: string;
    name: string;
    path: string;
    sizes: string[];
    steps: unknown[];
    x: number;
    y: number;
    created_at: string;
    updated_at: string;
}

const STEPS = [
    { t: 1, kind: 'click', selector: '[data-testid="add-person"]', words: 'Add', x: 20, y: 30 },
    { t: 2, kind: 'input', selector: '#name', label: 'Name', value: 'Ruth Adeyemi' },
];

describe("the board's screens", () => {
    let mf: Miniflare;
    let call: ReturnType<typeof client>['call'];
    let post: ReturnType<typeof client>['post'];
    beforeAll(async () => {
        ({ mf } = await start({ INBOX_PR: '' }, async () => jsonResponse({})));
        ({ call, post } = client(mf));
    });
    afterAll(() => mf?.dispose());

    const create = async (body: Record<string, unknown>) => {
        const res = await post('/api/screens', body);
        expect(res.status).toBe(201);
        return ((await res.json()) as { screen: ScreenJson }).screen;
    };

    it('adds a screen with its sizes and steps, and lists them oldest first', async () => {
        const a = await create({ name: 'People', path: '/people?tab=open', sizes: ['phone', 'desktop', 'phone'], steps: [], x: 10, y: 20 });
        expect(a).toMatchObject({ name: 'People', path: '/people?tab=open', sizes: ['phone', 'desktop'], steps: [], x: 10, y: 20 });
        expect(a.id).toMatch(/^[a-z0-9]{8}$/);
        const b = await create({ name: 'Add a person, half filled', path: '/people', sizes: ['tablet'], steps: STEPS });
        expect(b).toMatchObject({ steps: STEPS, x: 0, y: 0 });
        const { screens } = (await (await call('/api/screens')).json()) as { screens: ScreenJson[] };
        expect(screens.map((s) => s.id)).toEqual([a.id, b.id]);
        expect(screens[1].steps).toEqual(STEPS);
    });

    it('edits only the fields given, moves a screen, and deletes one by hand', async () => {
        const s = await create({ name: 'Settings', path: '/settings', sizes: ['desktop'], steps: STEPS });
        const moved = await post('/api/screens/' + s.id + '/edit', { x: 400.04, y: -80 });
        expect(moved.status).toBe(200);
        const m = ((await moved.json()) as { screen: ScreenJson }).screen;
        expect(m).toMatchObject({ name: 'Settings', path: '/settings', sizes: ['desktop'], steps: STEPS, x: 400, y: -80 });
        const renamed = ((await (await post('/api/screens/' + s.id + '/edit', { name: 'Settings, dark', sizes: ['phone'], steps: [] })).json()) as { screen: ScreenJson }).screen;
        expect(renamed).toMatchObject({ name: 'Settings, dark', sizes: ['phone'], steps: [], x: 400 });
        expect(renamed.updated_at >= s.updated_at).toBe(true);
        expect(await (await post('/api/screens/' + s.id + '/delete')).json()).toEqual({ deleted: true });
        const { screens } = (await (await call('/api/screens')).json()) as { screens: ScreenJson[] };
        expect(screens.some((x) => x.id === s.id)).toBe(false);
        expect((await post('/api/screens/' + s.id + '/delete')).status).toBe(404);
        expect((await post('/api/screens/' + s.id + '/edit', { name: 'x' })).status).toBe(404);
    });

    it('refuses a screen without a name, a path on this host or a known size, and bad steps or places', async () => {
        const ok = { name: 'People', path: '/people', sizes: ['phone'] };
        const status = async (body: Record<string, unknown>) => (await post('/api/screens', { ...ok, ...body })).status;
        expect(await status({ name: '  ' })).toBe(400);
        expect(await status({ path: 'https://elsewhere.example.org/' })).toBe(400);
        expect(await status({ path: '//elsewhere.example.org/' })).toBe(400);
        expect(await status({ sizes: [] })).toBe(400);
        expect(await status({ sizes: ['watch'] })).toBe(400);
        expect(await status({ sizes: ['toString'] })).toBe(400);
        expect(await status({ steps: 'click it' })).toBe(400);
        expect(await status({ steps: [1, 2] })).toBe(400);
        expect(await status({ x: 'left' })).toBe(400);
        expect(await status({ steps: [{ kind: 'input', value: 'x'.repeat(300 * 1024) }] })).toBe(413);
        const s = await create(ok);
        expect((await post('/api/screens/' + s.id + '/edit', { sizes: ['watch'] })).status).toBe(400);
        expect((await post('/api/screens', ok, { origin: 'https://evil.example.org' })).status).toBe(403);
        expect((await post('/api/screens/zz/edit', { name: 'x' })).status).toBe(404);
    });
});

describe('Live', () => {
    let mf: Miniflare;
    let post: ReturnType<typeof client>['post'];
    beforeAll(async () => {
        ({ mf } = await start({ INBOX_PR: '' }, async () => jsonResponse({})));
        ({ post } = client(mf));
    });
    afterAll(() => mf?.dispose());

    // a page's socket, and every message it has heard
    const open = async (headers: Record<string, string> = { 'cf-access-authenticated-user-email': OWNER, origin: ORIGIN }) => {
        const res = await mf.dispatchFetch(ORIGIN + BASE + '/live', { headers: { upgrade: 'websocket', ...headers } });
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        if (!ws) throw new Error('no socket');
        ws.accept();
        const heard: unknown[] = [];
        ws.addEventListener('message', (e) => heard.push(JSON.parse(String(e.data))));
        return { ws, heard };
    };
    const hear = async (heard: unknown[], n: number) => {
        for (let i = 0; i < 50 && heard.length < n; i++) await wait(40);
        return heard;
    };

    it('tells every open page which thread changed, and when the screens did, and nothing more', async () => {
        const a = await open();
        const b = await open({ 'cf-access-jwt-assertion': SERVICE_JWT });
        const res = await post('/api/threads', { body: 'Ruth Adeyemi is listed twice', capture: capture() });
        const { thread } = (await res.json()) as { thread: { id: string } };
        expect(await hear(a.heard, 1)).toEqual([{ type: 'thread', id: thread.id }]);
        expect(await hear(b.heard, 1)).toEqual([{ type: 'thread', id: thread.id }]);
        await post('/api/threads/' + thread.id + '/comments', { body: 'Still there' });
        await post('/api/threads/' + thread.id + '/resolve');
        await post('/api/threads/' + thread.id + '/capture/delete');
        await hear(a.heard, 4);
        await post('/api/screens', { name: 'People', path: '/people', sizes: ['phone'] });
        await hear(a.heard, 5);
        await post('/api/threads/' + thread.id + '/delete');
        expect(await hear(a.heard, 6)).toEqual([
            { type: 'thread', id: thread.id },
            { type: 'thread', id: thread.id },
            { type: 'thread', id: thread.id },
            { type: 'thread', id: thread.id },
            { type: 'screens' },
            { type: 'thread', id: thread.id },
        ]);
        a.ws.close();
        b.ws.close();
    });

    it("tells the pages when a thread's screenshot is deleted from the storage view", async () => {
        const up = await mf.dispatchFetch(ORIGIN + BASE + '/api/uploads', {
            method: 'POST',
            headers: { 'cf-access-authenticated-user-email': OWNER, origin: ORIGIN, 'content-type': 'image/png' },
            body: png(),
        });
        const { id } = (await up.json()) as { id: string };
        const res = await post('/api/threads', { body: 'Cut off', capture: capture({ shots: { element: id } }) });
        const { thread } = (await res.json()) as { thread: { id: string } };
        const page = await open();
        await post('/api/uploads/delete', { ids: [id] });
        expect(await hear(page.heard, 1)).toEqual([{ type: 'thread', id: thread.id }]);
        page.ws.close();
    });

    it('is a WebSocket for this site only, behind Access', async () => {
        expect((await mf.dispatchFetch(ORIGIN + BASE + '/live', { headers: { 'cf-access-authenticated-user-email': OWNER } })).status).toBe(426);
        const elsewhere = await mf.dispatchFetch(ORIGIN + BASE + '/live', {
            headers: { upgrade: 'websocket', 'cf-access-authenticated-user-email': OWNER, origin: 'https://evil.example.org' },
        });
        expect(elsewhere.status).toBe(403);
        expect((await mf.dispatchFetch(ORIGIN + BASE + '/live', { headers: { upgrade: 'websocket' } })).status).toBe(403);
    });
});
