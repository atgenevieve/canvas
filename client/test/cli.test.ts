// The canvas CLI against a mocked canvas API: where it finds the canvas, how it signs in with the service token, and
// what each command asks for and prints.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.mjs';

const CAPTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/capture.json', import.meta.url), 'utf8'));
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

const BASE = 'https://preview.example.org/__canvas';
const THREAD = {
    id: 'ab3k9m2x',
    status: 'open',
    url: 'https://preview.example.org/people/4821?tab=notes',
    selector: 'li:nth-of-type(3) > button.chip',
    words: 'Jordan Alvarez',
    component: 'PersonRow › Chip',
    source: 'src/client/people/person-row.tsx:42',
    branch: 'claude/people-chips',
    commit_sha: '0123456789abcdef0123456789abcdef01234567',
    viewport: '390x844',
    x: 120.3,
    y: 340,
    w: null,
    h: null,
    resolved_by: null,
    updated_at: '2026-10-15T12:00:00.000Z',
    comments: [
        { id: 'c0000001', author: 'owner@example.org', body: 'Make "Jordan" bold', created_at: '2026-10-15T12:00:00.000Z', edited_at: null },
        { id: 'c0000002', author: 'claude', body: 'Done.\nIn the chip.', created_at: '2026-10-15T12:05:00.000Z', edited_at: null },
    ],
};

interface Sent {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
}

let dir: string;
let sent: Sent[];
let lines: string[];
let thread: typeof THREAD;
let tmp: string;
let warned: string[];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// the canvas API, as the Worker answers it
const mockFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    sent.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const p = url.slice(BASE.length);
    if (method === 'GET' && p === '/api/threads') return json({ me: 'claude', threads: [thread, { ...thread, id: 'zz9y8x7w', status: 'resolved', comments: thread.comments.slice(0, 1) }] });
    if (method === 'GET' && p === '/api/threads/' + thread.id) return json({ me: 'claude', thread });
    if (method === 'POST' && p === '/api/threads/' + thread.id + '/comments') return json({ thread }, 201);
    if (method === 'POST' && p === '/api/threads/' + thread.id + '/resolve') return json({ thread: { ...thread, status: 'resolved' } });
    if (method === 'POST' && p === '/api/threads/' + thread.id + '/reopen') return json({ thread });
    if (method === 'GET' && p === '/api/threads/' + thread.id + '/capture')
        return json({ capture: CAPTURE, shots: { element: 'api/uploads/u1111111', screen: 'api/uploads/u2222222' } });
    if (method === 'GET' && p === '/api/uploads/u1111111') return new Response(WEBP, { headers: { 'content-type': 'image/webp' } });
    if (method === 'GET' && p === '/api/uploads/u2222222') return new Response(WEBP, { headers: { 'content-type': 'image/png' } });
    return json({ error: 'No such thread.' }, 404);
}) as typeof fetch;

const run = (argv: string[], { env = {}, stdin = '', fetch = mockFetch, cwd = dir } = {}) =>
    main(argv, {
        fetch,
        env: { CANVAS_ACCESS_CLIENT_ID: 'abc.access', CANVAS_ACCESS_CLIENT_SECRET: 'shh', ...env },
        cwd,
        out: (line) => lines.push(line),
        warn: (line) => warned.push(line),
        readStdin: () => stdin,
        tmpdir: tmp,
    });

// the same canvas, with no capture for any thread (none recorded, or deleted)
const noCapture = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith('/capture') ? json({ error: 'No capture.' }, 404) : mockFetch(input, init)) as typeof fetch;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cli-'));
    fs.writeFileSync(path.join(dir, 'canvas.config.json'), JSON.stringify({ project: 'my-app', url: 'https://preview.example.org/' }));
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-tmp-'));
    sent = [];
    lines = [];
    warned = [];
    thread = structuredClone(THREAD);
});

describe('the canvas CLI', () => {
    it('finds the canvas in canvas.config.json above it, and signs in with the Access service token', async () => {
        expect(await run(['list'], { cwd: path.join(dir, 'src', 'deep') })).toBe(0);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ method: 'GET', url: BASE + '/api/threads' });
        expect(sent[0].headers).toMatchObject({ 'CF-Access-Client-Id': 'abc.access', 'CF-Access-Client-Secret': 'shh' });
    });

    it('sends no Access headers without the token, and CANVAS_URL wins over the config', async () => {
        await run(['list'], { env: { CANVAS_ACCESS_CLIENT_ID: '', CANVAS_ACCESS_CLIENT_SECRET: '' } });
        expect(Object.keys(sent[0].headers)).toEqual(['accept']);
        await expect(run(['list'], { env: { CANVAS_URL: 'http://localhost:8787/__canvas' } })).rejects.toThrow();
        expect(sent[1].url).toBe('http://localhost:8787/__canvas/api/threads');
    });

    it("takes the config's base path", async () => {
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cli-'));
        fs.writeFileSync(path.join(other, 'canvas.config.json'), JSON.stringify({ project: 'my-app', url: 'https://preview.example.org', base: '/review/' }));
        await expect(run(['list'], { cwd: other })).rejects.toThrow();
        expect(sent[0].url).toBe('https://preview.example.org/review/api/threads');
        fs.rmSync(other, { recursive: true, force: true });
    });

    it('says so when there is no canvas.config.json', async () => {
        await expect(run(['list'], { cwd: os.tmpdir() })).rejects.toThrow('No canvas.config.json');
    });

    it('lists threads, latest first, and only the open ones with --open', async () => {
        await run(['list']);
        expect(lines[0]).toBe('ab3k9m2x  open     https://preview.example.org/people/4821?tab=notes · PersonRow › Chip at src/client/people/person-row.tsx:42');
        expect(lines[1]).toContain('Claude: Done. In the chip.  (2 comments)');
        expect(lines[2]).toMatch(/^zz9y8x7w {2}resolved/);
        lines = [];
        await run(['list', '--open']);
        expect(lines.filter((l) => /^[a-z0-9]{8} /.test(l))).toHaveLength(1);
        lines = [];
        await run(['list', '--open', '--json']);
        expect(JSON.parse(lines.join('\n')).map((t: { id: string }) => t.id)).toEqual(['ab3k9m2x']);
    });

    it("shows a thread without a capture: the page, the thread's element facts, the build and every comment", async () => {
        await run(['show', 'ab3k9m2x'], { fetch: noCapture });
        const text = lines.join('\n');
        expect(text).toContain('Thread ab3k9m2x (open)');
        expect(text).toContain('Component: PersonRow › Chip');
        expect(text).toContain('Source:    src/client/people/person-row.tsx:42');
        expect(text).toContain('Element:   "Jordan Alvarez"');
        expect(text).toContain('Build:     claude/people-chips @ 0123456789ab');
        expect(text).toContain('Link:      ' + BASE + '/?thread=ab3k9m2x');
        expect(text).toContain('  Make "Jordan" bold');
        expect(text).toContain('Claude · ');
        expect(text).toContain('  Done.\n  In the chip.');
    });

    it('shows a thread with its capture: element, env, numbered steps, errors, failed requests, and saved screenshots', async () => {
        await run(['show', 'ab3k9m2x']);
        expect(sent.map((s) => s.url.slice(BASE.length))).toEqual(['/api/threads/ab3k9m2x', '/api/threads/ab3k9m2x/capture', '/api/uploads/u1111111', '/api/uploads/u2222222']);
        expect(sent[2].headers).toMatchObject({ 'CF-Access-Client-Id': 'abc.access' });
        const text = lines.join('\n');
        expect(text).toContain('Thread ab3k9m2x (open)');
        expect(text).toContain('  Make "Jordan" bold');
        expect(text).not.toContain('Selector:  li:nth-of-type(3)'); // the capture's element, not the thread's copy
        expect(text).toContain('  Selector:  [data-testid="save-person"]');
        expect(text).toContain('  Component: PersonForm › Button');
        expect(text).toContain('  Viewport:  390x844 @3x, dark');
        expect(text).toContain('   1. +0.0s   load /people');
        expect(text).toContain('   9. +8.0s   type •••• (12 chars) into Password (#password)');
        expect(text).toContain('  21. +20.0s  click (button.icon-back)');
        expect(text).toContain("  +6.5s TypeError: Cannot read properties of undefined (reading 'name')");
        expect(text).toContain('      at PersonForm (src/client/people/person-form.tsx:41:12)');
        expect(text).toContain('  POST https://preview.example.org/api/people/4821 → 500 (231ms)');
        const element = path.join(tmp, 'canvas', 'ab3k9m2x', 'element.webp');
        const screen = path.join(tmp, 'canvas', 'ab3k9m2x', 'screen.png');
        expect(text).toContain('Screenshots\n  element:  ' + element + '\n  screen:   ' + screen);
        expect(new Uint8Array(fs.readFileSync(element))).toEqual(WEBP);
        expect(fs.existsSync(screen)).toBe(true);
    });

    it('shows raw JSON with --json', async () => {
        await run(['show', 'ab3k9m2x', '--json']);
        const data = JSON.parse(lines.join('\n'));
        expect(data.thread.id).toBe('ab3k9m2x');
        expect(data.capture).toEqual(CAPTURE);
        expect(data.shots).toEqual({ element: 'api/uploads/u1111111', screen: 'api/uploads/u2222222' });
        expect(data.files.element).toBe(path.join(tmp, 'canvas', 'ab3k9m2x', 'element.webp'));
        lines = [];
        await run(['show', 'ab3k9m2x', '--json'], { fetch: noCapture });
        expect(JSON.parse(lines.join('\n'))).toMatchObject({ capture: null, files: {} });
    });

    it('writes a repro to the temp dir, never the repo, and warns that typed values may be real', async () => {
        await run(['repro', 'ab3k9m2x']);
        const file = path.join(tmp, 'canvas', 'ab3k9m2x', 'repro.spec.ts');
        expect(lines).toEqual([file]);
        expect(warned).toHaveLength(1);
        expect(warned[0]).toMatch(/may be real data/);
        const source = fs.readFileSync(file, 'utf8');
        expect(source).toContain("const BASE = process.env.BASE_URL ?? 'https://preview.example.org';");
        expect(source).toContain("fill('ruth.adeyemi@example.org')");
        expect(fs.readdirSync(dir).sort()).toEqual(['canvas.config.json', 'src']);
        expect(sent.map((s) => s.url.slice(BASE.length))).toEqual(['/api/threads/ab3k9m2x/capture']);
    });

    it('writes a fictional repro to --out without the warning', async () => {
        await run(['repro', '--fictional', 'ab3k9m2x', '--out', 'e2e/repro.spec.ts']);
        const file = path.join(dir, 'e2e', 'repro.spec.ts');
        expect(lines).toEqual([file]);
        expect(warned).toEqual([]);
        expect(fs.readFileSync(file, 'utf8')).not.toContain('ruth.adeyemi@example.org');
        fs.rmSync(path.join(dir, 'e2e'), { recursive: true });
        await expect(run(['repro', 'ab3k9m2x', '--out'])).rejects.toThrow('--out needs a value');
    });

    it('says when there is no capture to repro', async () => {
        await expect(run(['repro', 'ab3k9m2x'], { fetch: noCapture })).rejects.toThrow('ab3k9m2x has no capture');
        expect(warned).toEqual([]);
    });

    it('replies, from stdin too, and resolves with --resolve, sending the canvas its own origin', async () => {
        await run(['reply', 'ab3k9m2x', '-', '--resolve'], { stdin: "It's done; see the chip.\r\n" });
        expect(sent.map((s) => s.method + ' ' + s.url.slice(BASE.length))).toEqual(['POST /api/threads/ab3k9m2x/comments', 'POST /api/threads/ab3k9m2x/resolve']);
        expect(sent[0].body).toEqual({ body: "It's done; see the chip." });
        expect(sent[0].headers).toMatchObject({ 'content-type': 'application/json', origin: 'https://preview.example.org' });
        expect(lines).toEqual(['Replied to ab3k9m2x and resolved it.']);
        await expect(run(['reply', 'ab3k9m2x', '  '])).rejects.toThrow('Give the reply text');
    });

    it('resolves and reopens, and says when there is nothing to do', async () => {
        await run(['resolve', 'ab3k9m2x']);
        expect(sent.map((s) => s.method)).toEqual(['GET', 'POST']);
        expect(lines).toEqual(['Resolved ab3k9m2x.']);
        sent = [];
        lines = [];
        await run(['reopen', 'ab3k9m2x']);
        expect(sent).toHaveLength(1);
        expect(lines).toEqual(['ab3k9m2x is already open.']);
    });

    it("passes on the canvas's errors, and Access turning it away", async () => {
        await expect(run(['show', 'nothere1'])).rejects.toThrow('No such thread.');
        await expect(run(['show', 'BAD'])).rejects.toThrow('Give a thread code');
        const access = (async () => new Response('<html>Sign in</html>', { status: 403, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
        await expect(run(['list'], { fetch: access })).rejects.toThrow('Cloudflare Access turned the request away (403)');
    });

    it('prints its usage for no command, and fails for an unknown one', async () => {
        expect(await run([])).toBe(0);
        expect(lines.join('\n')).toContain('canvas list [--open]');
        expect(lines.join('\n')).toContain('canvas repro <code> [--fictional] [--out <file>]');
        expect(lines.join('\n')).not.toContain('delete');
        expect(lines.join('\n')).not.toContain('@ts-check');
        expect(await run(['frobnicate'])).toBe(1);
        expect(sent).toEqual([]);
    });
});
