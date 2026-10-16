// End to end: builds examples/basic (Vite + React 19 with the plugin from its vite.config.ts) and checks what an app
// really gets: the overlay in CANVAS=1 builds, nothing in production builds, and tagged elements in dev.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, createServer } from 'vite';

const EXAMPLE = path.resolve(import.meta.dirname, '../../examples/basic');
const REPO = path.resolve(EXAMPLE, '../..');
let out: string;

beforeAll(() => {
    // What `npm install` does for the example's "file:../.." dependency, so its config imports the plugin as an app would.
    const link = path.join(EXAMPLE, 'node_modules/@atgenevieve/canvas');
    if (!fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(link), REPO), link, 'dir');
    }
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-example-'));
});

afterAll(() => {
    fs.rmSync(out, { recursive: true, force: true });
});

async function buildExample(canvasFlag: boolean, minify = false) {
    const dir = path.join(out, (canvasFlag ? 'canvas' : 'prod') + (minify ? '-min' : ''));
    const before = process.env.CANVAS;
    if (canvasFlag) process.env.CANVAS = '1';
    else delete process.env.CANVAS;
    try {
        await build({ root: EXAMPLE, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, minify } });
    } finally {
        if (before === undefined) delete process.env.CANVAS;
        else process.env.CANVAS = before;
    }
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const assets = path.join(dir, 'assets');
    const js = fs
        .readdirSync(assets)
        .filter((f) => f.endsWith('.js'))
        .map((f) => fs.readFileSync(path.join(assets, f), 'utf8'))
        .join('\n');
    return { html, js };
}

describe('examples/basic', () => {
    it('with CANVAS=1, the page loads the overlay and host elements carry their source', async () => {
        const { html, js } = await buildExample(true);
        expect(html).toContain('<script type="module" src="/__canvas/overlay.js"></script>');
        expect(html).toMatch(/window\.__CANVAS_BUILD__=\{"project":"canvas-example",.*"base":"\/__canvas","corner":"bottom-right"\}/);
        // li, strong, span (PersonRow); main, h1, ul, button, p (App). <PersonRow>, <App> and <StrictMode> get none.
        const sources = [...js.matchAll(/"data-canvas-src": "([^"]+)"/g)].map((m) => m[1]);
        expect(sources).toEqual([10, 11, 11, 19, 20, 21, 26, 29].map((line) => `src/app.tsx:${line}`));
        expect(js.includes('Jordan Alvarez')).toBe(true);
    });

    it('a minified CANVAS=1 build keeps component names, so the overlay can name what was picked', async () => {
        const { js } = await buildExample(true, true);
        expect(js).toMatch(/function App\(|["'`]App["'`]/);
        expect(js).toMatch(/function PersonRow\(|["'`]PersonRow["'`]/);
    });

    it('in a production build, nothing is added', async () => {
        const { html, js } = await buildExample(false);
        expect(html).not.toContain('__canvas');
        expect(html).not.toContain('__CANVAS_BUILD__');
        expect(js.includes('data-canvas-src')).toBe(false);
    });

    it('in dev, a module comes back tagged, with a source map', async () => {
        delete process.env.CANVAS;
        const server = await createServer({ root: EXAMPLE, logLevel: 'silent', server: { middlewareMode: true, ws: false } });
        try {
            const result = await server.transformRequest('/src/app.tsx');
            expect(result?.code).toContain('"data-canvas-src": "src/app.tsx:26"');
            expect(result?.map).toBeTruthy();
            const html = await server.transformIndexHtml('/', fs.readFileSync(path.join(EXAMPLE, 'index.html'), 'utf8'));
            expect(html).toContain('<script type="module" src="/__canvas/overlay.js"></script>');
        } finally {
            await server.close();
        }
    });
});
