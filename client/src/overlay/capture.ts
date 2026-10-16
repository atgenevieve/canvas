// A capture: what was picked, where you were and how you got there (docs/CONTRACT.md, "A capture"). The screenshots
// are drawn when you pick, so they show what you saw, and uploaded only when you post.
import { CONTRACT_VERSION, DEFAULT_BASE } from '../../../shared/contract.ts';
import type { Capture, ElementFacts, Env, Rect } from '../../../shared/contract.ts';
import { componentChain, sourceOf } from './chain.ts';
import { selectorFor, wordsOf } from './dom.ts';
import type { Recorder } from './recorder.ts';

/** What the Vite plugin puts in `window.__CANVAS_BUILD__`. */
export interface BuildInfo {
    project?: string;
    branch?: string | null;
    commit?: string | null;
    base?: string;
    corner?: string;
}

/** What was picked: an element, an area dragged out, or a point. Coordinates are in page CSS pixels. */
export type Target = { el: Element } | { area: Rect } | { point: { x: number; y: number } };

export interface Shots {
    element?: Blob;
    screen?: Blob;
}

export interface Shooters {
    shootElement(el: Element): Promise<Blob>;
    shootScreen(): Promise<Blob>;
}

export type Upload = (blob: Blob, base: string) => Promise<{ id: string }>;

export function baseOf(build: BuildInfo | undefined): string {
    return (build?.base || DEFAULT_BASE).replace(/\/+$/, '');
}

/** An element's box in page CSS pixels, rounded. */
export function pageRect(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
}

export function elementFacts(el: Element): ElementFacts {
    const facts: ElementFacts = { selector: selectorFor(el), words: wordsOf(el), tag: el.tagName.toLowerCase(), rect: pageRect(el) };
    const role = el.getAttribute('role');
    if (role) facts.role = role;
    const chain = componentChain(el);
    if (chain.length) facts.component = chain.join(' › ');
    const source = sourceOf(el);
    if (source) facts.source = source;
    return facts;
}

export function envOf(build: BuildInfo | undefined, now: () => Date = () => new Date()): Env {
    const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const env: Env = {
        url: location.href,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        scheme: dark ? 'dark' : 'light',
        userAgent: navigator.userAgent,
        at: now().toISOString(),
    };
    if (build?.branch) env.branch = build.branch;
    if (build?.commit) env.commit = build.commit;
    return env;
}

/** Draws the screenshots for a target; a shot that fails is left out. */
export async function takeShots(target: Target, shooters: Shooters): Promise<Shots> {
    const [element, screen] = await Promise.all([
        'el' in target ? shooters.shootElement(target.el).catch(() => undefined) : Promise.resolve(undefined),
        shooters.shootScreen().catch(() => undefined),
    ]);
    const shots: Shots = {};
    if (element) shots.element = element;
    if (screen) shots.screen = screen;
    return shots;
}

/** Uploads the shots; one that fails is left out, so the comment still posts. */
export async function uploadShots(shots: Shots, upload: Upload, base: string): Promise<Capture['shots']> {
    const ids: Capture['shots'] = {};
    await Promise.all(
        (['element', 'screen'] as const).map(async (kind) => {
            const blob = shots[kind];
            if (!blob) return;
            try {
                ids[kind] = (await upload(blob, base)).id;
            } catch (_e) {
                // posted without it
            }
        }),
    );
    return ids;
}

export function assemble(
    target: Target,
    build: BuildInfo | undefined,
    recorder: Pick<Recorder, 'steps' | 'errors' | 'failed'>,
    shots: Capture['shots'] = {},
): Capture {
    const capture: Capture = {
        version: CONTRACT_VERSION,
        element: 'el' in target ? elementFacts(target.el) : null,
        env: envOf(build),
        steps: recorder.steps(),
        errors: recorder.errors(),
        failed: recorder.failed(),
        shots,
    };
    if ('area' in target) capture.area = target.area;
    if ('point' in target) capture.point = target.point;
    return capture;
}
