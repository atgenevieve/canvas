// The Vite plugin apps add (`@atgenevieve/canvas/vite`). In `vite dev`, and in builds with CANVAS=1, it injects the
// overlay, tags host JSX elements with their source file and line, bakes in the git branch and commit, and in dev
// proxies the canvas base to the project's deployed canvas. Otherwise it removes itself. docs/CONTRACT.md "The Vite
// plugin" is the spec.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { transformJsx } from './transform.mjs';

export { transformJsx };

export const DEFAULT_BASE = '/__canvas';
export const CORNERS = /** @type {const} */ (['bottom-right', 'bottom-left', 'top-right', 'top-left']);

const BRANCH_ENV = ['CANVAS_BRANCH', 'CF_PAGES_BRANCH', 'WORKERS_CI_BRANCH', 'GITHUB_HEAD_REF', 'GITHUB_REF_NAME'];
const COMMIT_ENV = ['CANVAS_COMMIT', 'CF_PAGES_COMMIT_SHA', 'WORKERS_CI_COMMIT_SHA', 'GITHUB_SHA'];

/**
 * @typedef {(typeof CORNERS)[number]} Corner
 * @typedef {{ project: string; base?: string; target?: string; corner?: Corner }} CanvasOptions
 * @typedef {{ project: string; branch: string | null; commit: string | null; base: string; corner: Corner }} BuildInfo
 * @typedef {import('vite').Plugin} Plugin
 */

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} names
 */
function fromEnv(env, names) {
    for (const name of names) if (env[name]) return env[name];
    return null;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
    try {
        const out = execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
        return out || null;
    } catch (_) {
        return null;
    }
}

/**
 * The build's branch and commit: CI's variables first (a CI checkout is often a detached HEAD), then git.
 * @param {string} cwd
 * @param {Record<string, string | undefined>} [env]
 */
export function gitInfo(cwd, env = process.env) {
    let branch = fromEnv(env, BRANCH_ENV);
    if (!branch) {
        const head = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        branch = head && head !== 'HEAD' ? head : null;
    }
    const commit = fromEnv(env, COMMIT_ENV) ?? git(cwd, ['rev-parse', 'HEAD']);
    return { branch, commit };
}

/** @param {CanvasOptions} options */
function check(options) {
    if (!options || typeof options.project !== 'string' || !options.project.trim()) {
        throw new Error('canvas(): `project` is required, e.g. canvas({ project: "my-app" })');
    }
    const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, '');
    if (!base.startsWith('/')) throw new Error(`canvas(): \`base\` must start with "/", got ${JSON.stringify(options.base)}`);
    const corner = options.corner ?? 'bottom-right';
    if (!CORNERS.includes(corner)) {
        throw new Error(`canvas(): \`corner\` must be one of ${CORNERS.join(', ')}, got ${JSON.stringify(options.corner)}`);
    }
    return { project: options.project, base, corner, target: options.target };
}

/** JSON safe to put inside a <script> element. @param {unknown} value */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * @param {CanvasOptions} options
 * @returns {Plugin}
 */
export default function canvas(options) {
    const { project, base, corner, target } = check(options);
    let root = process.cwd();
    /** @type {BuildInfo} */
    let build = { project, branch: null, commit: null, base, corner };

    return {
        name: 'canvas',
        enforce: 'pre',
        // On in dev and in CANVAS=1 builds; gone from production builds and from vitest runs (mode "test"), so app tests
        // and snapshots don't see it.
        apply(_config, { command, mode }) {
            if (process.env.CANVAS === '1') return true;
            return command === 'serve' && mode !== 'test';
        },
        config(config, { command }) {
            root = path.resolve(config.root ?? process.cwd());
            build = { project, ...gitInfo(root), base, corner };
            /** @type {import('vite').UserConfig} */
            const extra = {
                define: {
                    __CANVAS_BRANCH__: JSON.stringify(build.branch),
                    __CANVAS_COMMIT__: JSON.stringify(build.commit),
                    __CANVAS_PROJECT__: JSON.stringify(project),
                    __CANVAS_BASE__: JSON.stringify(base),
                },
            };
            if (command === 'serve' && target) {
                /** @type {Record<string, string>} */
                const headers = {};
                if (process.env.CANVAS_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = process.env.CANVAS_ACCESS_CLIENT_ID;
                if (process.env.CANVAS_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = process.env.CANVAS_ACCESS_CLIENT_SECRET;
                const key = `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`;
                extra.server = { proxy: { [key]: { target, changeOrigin: true, ws: true, secure: true, headers } } };
            }
            return extra;
        },
        configResolved(config) {
            root = config.root;
        },
        transform(code, id) {
            return transformJsx(code, id, root);
        },
        transformIndexHtml: {
            // After Vite's own HTML build, so it doesn't try to bundle the overlay (the Worker serves it).
            order: 'post',
            handler() {
                return [
                    { tag: 'script', children: `window.__CANVAS_BUILD__=${scriptJson(build)}`, injectTo: 'head-prepend' },
                    { tag: 'script', attrs: { type: 'module', src: `${base}/overlay.js` }, injectTo: 'head' },
                ];
            },
        },
    };
}
