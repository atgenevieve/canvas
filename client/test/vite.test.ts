// The Vite plugin's parts on their own: the JSX transform (which elements get data-canvas-src, the lines, the source
// map), when the plugin switches itself on, the HTML it injects, the defines and the dev proxy.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigEnv, IndexHtmlTransformHook, Plugin, UserConfig } from 'vite';
import canvas, { gitInfo, transformJsx } from '../src/vite/index.mjs';

const ROOT = '/work/app';
const FILE = `${ROOT}/src/people/person-row.tsx`;

const SAMPLE = `import { Fragment } from 'react';
import * as UI from './ui';

type Props = { name: string; email: string };

export function PersonRow({ name, email }: Props) {
    const ref = useRef<HTMLLIElement>(null);
    return (
        <li ref={ref} className="row">
            <UI.Chip label={name} />
            <Avatar name={name}><img src="/a.png" alt="" /></Avatar>
            <>
                <span data-canvas-src="keep:1">{email}</span>
            </>
            <Fragment><br/></Fragment>
            <svg:rect />
        </li>
    );
}
`;

// A source map "mappings" decoder, enough to check where a generated position points.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(mappings: string) {
    const lines: number[][][] = [];
    let srcLine = 0;
    let srcCol = 0;
    let src = 0;
    for (const line of mappings.split(';')) {
        const segs: number[][] = [];
        let genCol = 0;
        for (const seg of line.split(',').filter(Boolean)) {
            const nums: number[] = [];
            let value = 0;
            let shift = 0;
            for (const ch of seg) {
                const digit = B64.indexOf(ch);
                value += (digit & 31) << shift;
                if (digit & 32) shift += 5;
                else {
                    nums.push(value & 1 ? -(value >>> 1) : value >>> 1);
                    value = 0;
                    shift = 0;
                }
            }
            genCol += nums[0];
            if (nums.length >= 4) {
                src += nums[1];
                srcLine += nums[2];
                srcCol += nums[3];
                segs.push([genCol, src, srcLine, srcCol]);
            }
        }
        lines.push(segs);
    }
    return lines;
}

/** The original line and column (0-based) of a generated position, from the last segment at or before it. */
function original(mappings: string, line: number, col: number) {
    const segs = decode(mappings)[line];
    const seg = [...segs].reverse().find((s) => s[0] <= col)!;
    return { line: seg[2], col: seg[3] + (col - seg[0]) };
}

function lineOf(text: string, needle: string) {
    const i = text.indexOf(needle);
    expect(i).toBeGreaterThanOrEqual(0);
    const before = text.slice(0, i).split('\n');
    return { line: before.length - 1, col: before[before.length - 1].length };
}

describe('transformJsx', () => {
    const out = transformJsx(SAMPLE, FILE, ROOT)!;

    it('tags host elements with the relative path and their line', () => {
        expect(out.code).toContain('<li data-canvas-src="src/people/person-row.tsx:9" ref={ref} className="row">');
        expect(out.code).toContain('<img data-canvas-src="src/people/person-row.tsx:11" src="/a.png" alt="" />');
        expect(out.code).toContain('<br data-canvas-src="src/people/person-row.tsx:15"/>');
        expect(out.code.match(/data-canvas-src=/g)).toHaveLength(4); // li, img, br, and the span's own
    });

    it('leaves components, member names, namespaced names, fragments, type arguments and existing attributes alone', () => {
        expect(out.code).toContain('<UI.Chip label={name} />');
        expect(out.code).toContain('<Avatar name={name}>');
        expect(out.code).toContain('<Fragment>');
        expect(out.code).toContain('            <>\n');
        expect(out.code).toContain('<span data-canvas-src="keep:1">');
        expect(out.code).toContain('<svg:rect />');
        expect(out.code).toContain('useRef<HTMLLIElement>(null)');
    });

    it('changes nothing but the inserted attributes', () => {
        expect(out.code.replace(/ data-canvas-src="src\/[^"]*"/g, '')).toBe(SAMPLE);
    });

    it('returns a source map that points back at the original text', () => {
        expect(out.map.sources).toEqual([FILE]);
        expect(out.map.sourcesContent).toEqual([SAMPLE]);
        expect(out.map.mappings.length).toBeGreaterThan(0);
        for (const needle of ['className="row"', 'src="/a.png"', '{email}', 'export function']) {
            const gen = lineOf(out.code, needle);
            expect(original(out.map.mappings, gen.line, gen.col)).toEqual(lineOf(SAMPLE, needle));
        }
    });

    it('works on .jsx and ignores queries', () => {
        const jsx = transformJsx('export const A = () => <div>hi</div>;\n', `${ROOT}/src/a.jsx?v=123`, ROOT)!;
        expect(jsx.code).toBe('export const A = () => <div data-canvas-src="src/a.jsx:1">hi</div>;\n');
    });

    it('skips other files, node_modules, virtual modules, files with no host elements and bad syntax', () => {
        expect(transformJsx('const a = <div />;', `${ROOT}/src/a.ts`, ROOT)).toBeNull();
        expect(transformJsx('const a = <div />;', `${ROOT}/src/a.js`, ROOT)).toBeNull();
        expect(transformJsx('const a = <div />;', `${ROOT}/node_modules/lib/a.jsx`, ROOT)).toBeNull();
        expect(transformJsx('const a = <div />;', `\0virtual:a.jsx`, ROOT)).toBeNull();
        expect(transformJsx('const a = <Card><Row /></Card>;', `${ROOT}/src/a.tsx`, ROOT)).toBeNull();
        expect(transformJsx('const a = <div;', `${ROOT}/src/a.tsx`, ROOT)).toBeNull();
    });
});

// Calls a plugin hook the way Vite does, whether it's a function or { handler }.
function hook<T extends (...args: never[]) => unknown>(h: unknown): T {
    return (typeof h === 'function' ? h : (h as { handler: T }).handler) as T;
}

function applies(plugin: Plugin, env: ConfigEnv) {
    return (plugin.apply as (c: UserConfig, e: ConfigEnv) => boolean)({}, env);
}

function configOf(plugin: Plugin, env: ConfigEnv, root = path.resolve(import.meta.dirname, '..')) {
    return hook<(c: UserConfig, e: ConfigEnv) => UserConfig>(plugin.config).call({} as never, { root }, env);
}

const SERVE: ConfigEnv = { command: 'serve', mode: 'development' };
const BUILD: ConfigEnv = { command: 'build', mode: 'production' };

describe('canvas()', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it('is on in dev and in CANVAS=1 builds, and off in production builds and vitest', () => {
        delete process.env.CANVAS;
        const plugin = canvas({ project: 'my-app' });
        expect(plugin.enforce).toBe('pre');
        expect(applies(plugin, SERVE)).toBe(true);
        expect(applies(plugin, BUILD)).toBe(false);
        expect(applies(plugin, { command: 'serve', mode: 'test' })).toBe(false);
        process.env.CANVAS = '1';
        expect(applies(plugin, BUILD)).toBe(true);
        process.env.CANVAS = 'true';
        expect(applies(plugin, BUILD)).toBe(false);
    });

    it('checks its options', () => {
        expect(() => canvas({} as never)).toThrow(/project/);
        expect(() => canvas({ project: 'a', base: 'canvas' })).toThrow(/base/);
        expect(() => canvas({ project: 'a', corner: 'middle' as never })).toThrow(/corner/);
        for (const corner of ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const) {
            expect(() => canvas({ project: 'a', corner })).not.toThrow();
        }
    });

    it('injects the build info and the overlay tag after Vite has built the page', async () => {
        process.env.CANVAS_BRANCH = 'claude/people-chips';
        process.env.CANVAS_COMMIT = '0123456789abcdef0123456789abcdef01234567';
        const plugin = canvas({ project: 'my-app', base: '/canvas/', corner: 'top-left' });
        configOf(plugin, SERVE);
        const html = plugin.transformIndexHtml as { order: string; handler: IndexHtmlTransformHook };
        expect(html.order).toBe('post');
        const tags = await html.handler.call({} as never, '<html></html>', {} as never);
        expect(tags).toEqual([
            {
                tag: 'script',
                children:
                    'window.__CANVAS_BUILD__={"project":"my-app","branch":"claude/people-chips","commit":"0123456789abcdef0123456789abcdef01234567","base":"/canvas","corner":"top-left"}',
                injectTo: 'head-prepend',
            },
            { tag: 'script', attrs: { type: 'module', src: '/canvas/overlay.js' }, injectTo: 'head' },
        ]);
    });

    it('defaults the corner to bottom-right and escapes the build info for a script element', async () => {
        const plugin = canvas({ project: '</script><b>' });
        configOf(plugin, SERVE);
        const html = plugin.transformIndexHtml as { handler: IndexHtmlTransformHook };
        const [info] = (await html.handler.call({} as never, '', {} as never)) as { children: string }[];
        expect(info.children).not.toContain('</script>');
        expect(info.children).toContain('"corner":"bottom-right"');
    });

    it('defines the branch, commit, project and base', () => {
        process.env.CANVAS_BRANCH = 'claude/people-chips';
        process.env.CANVAS_COMMIT = 'abc123';
        const config = configOf(canvas({ project: 'my-app' }), SERVE);
        expect(config.define).toEqual({
            __CANVAS_BRANCH__: '"claude/people-chips"',
            __CANVAS_COMMIT__: '"abc123"',
            __CANVAS_PROJECT__: '"my-app"',
            __CANVAS_BASE__: '"/__canvas"',
        });
    });

    it('proxies the base, its WebSocket included, to the target in dev, with the Access service token', () => {
        process.env.CANVAS_ACCESS_CLIENT_ID = 'id.access';
        process.env.CANVAS_ACCESS_CLIENT_SECRET = 'secret';
        const plugin = canvas({ project: 'my-app', target: 'https://preview.example.org' });
        expect(configOf(plugin, SERVE).server?.proxy).toEqual({
            '^/__canvas(/|$)': {
                target: 'https://preview.example.org',
                changeOrigin: true,
                ws: true,
                secure: true,
                headers: { 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'secret' },
            },
        });
        expect(configOf(plugin, BUILD).server).toBeUndefined();
        expect(configOf(canvas({ project: 'my-app' }), SERVE).server).toBeUndefined();
    });
});

describe('gitInfo', () => {
    it('prefers CI variables, then git', () => {
        expect(gitInfo('/', { CF_PAGES_BRANCH: 'preview-x', CF_PAGES_COMMIT_SHA: 'aaa' })).toEqual({ branch: 'preview-x', commit: 'aaa' });
        expect(gitInfo('/', { WORKERS_CI_BRANCH: 'w', WORKERS_CI_COMMIT_SHA: 'b' })).toEqual({ branch: 'w', commit: 'b' });
        expect(gitInfo('/', { GITHUB_HEAD_REF: 'feature', GITHUB_SHA: 'c' })).toEqual({ branch: 'feature', commit: 'c' });
        const here = gitInfo(import.meta.dirname, {});
        expect(here.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it('gives nulls outside a git checkout', () => {
        expect(gitInfo('/', {})).toEqual({ branch: null, commit: null });
    });
});
