// @vitest-environment happy-dom
// The overlay's pure parts on happy-dom: the component chain (from a real React render), corner snapping and its
// storage, capture assembly with a stubbed recorder, shots and fetch, pin matching, and the board messages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, memo, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Step, Thread } from '../../../shared/contract.ts';
import { componentChain, labelFor, nameOf, sourceOf } from '../../src/overlay/chain.ts';
import { assemble, baseOf, elementFacts, takeShots, uploadShots } from '../../src/overlay/capture.ts';
import { CORNER_KEY, nearestCorner, readCorner, saveCorner } from '../../src/overlay/corner.ts';
import { connectBoard, isFramed } from '../../src/overlay/messages.ts';
import { stepsSinceLoad } from '../../src/overlay/overlay.ts';
import { anchorOf, openHere, pinAt } from '../../src/overlay/pins.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
async function render(node: ReactNode): Promise<HTMLElement> {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(node));
    return container;
}

beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState(null, '', '/people');
});
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe('component chain', () => {
    function Button({ children }: { children: ReactNode }) {
        return createElement('button', { type: 'button', 'data-canvas-src': 'src/ui/button.tsx:4' }, children);
    }
    function SaveBar() {
        return createElement('div', { 'data-canvas-src': 'src/save-bar.tsx:10' }, createElement(Button, null, createElement('span', null, 'Save')));
    }

    it('reads names from the fiber, outermost first, and the nearest source', async () => {
        function App() {
            return createElement('main', { 'data-canvas-src': 'src/app.tsx:3' }, createElement(SaveBar));
        }
        const page = await render(createElement(App));
        const span = page.querySelector('span')!;
        expect(componentChain(span)).toEqual(['App', 'SaveBar', 'Button']);
        expect(sourceOf(span)).toBe('src/ui/button.tsx:4');
        expect(labelFor(span)).toBe('App › SaveBar › Button · button.tsx:4');
    });

    it('keeps the innermost three, skips anonymous components and counts a memo once', async () => {
        const Row = memo(function Row() {
            return createElement('li', { 'data-canvas-src': 'src/row.tsx:2' }, 'Jordan Alvarez');
        });
        const Anon = [() => createElement('ul', null, createElement(Row))][0];
        const Fancy = forwardRef<HTMLDivElement, { children: ReactNode }>(function Fancy(props, ref) {
            return createElement('div', { ref }, props.children);
        });
        function Page() {
            return createElement(Fancy, null, createElement(Anon));
        }
        function Shell() {
            return createElement(Page);
        }
        const page = await render(createElement(Shell));
        expect(componentChain(page.querySelector('li'))).toEqual(['Page', 'Fancy', 'Row']);
    });

    it('skips library components (node_modules in their host source)', async () => {
        function LibIcon() {
            return createElement('i', { 'data-canvas-src': 'node_modules/icons/icon.js:1' }, '*');
        }
        function Toolbar() {
            return createElement('nav', { 'data-canvas-src': 'src/toolbar.tsx:1' }, createElement(LibIcon));
        }
        const page = await render(createElement(Toolbar));
        expect(componentChain(page.querySelector('i'))).toEqual(['Toolbar']);
    });

    it('is empty off React, and the label falls back to the tag', () => {
        document.body.innerHTML = '<p>Plain</p>';
        const p = document.querySelector('p')!;
        expect(componentChain(p)).toEqual([]);
        expect(labelFor(p)).toBe('p');
    });

    it('names through displayName, forwardRef and memo', () => {
        expect(nameOf({ displayName: 'Shown' })).toBe('Shown');
        expect(nameOf({ render: function Inner() {} })).toBe('Inner');
        expect(nameOf({ type: { render: { displayName: 'Deep' } } })).toBe('Deep');
        expect(nameOf(() => null)).toBe('');
        expect(nameOf(function g() {})).toBe('');
        expect(nameOf({ name: 'Ce' })).toBe('');
        expect(nameOf('div')).toBe('');
    });
});

describe('corner', () => {
    it('snaps to the nearest corner', () => {
        expect(nearestCorner(10, 10, 390, 844)).toBe('top-left');
        expect(nearestCorner(380, 10, 390, 844)).toBe('top-right');
        expect(nearestCorner(10, 800, 390, 844)).toBe('bottom-left');
        expect(nearestCorner(300, 500, 390, 844)).toBe('bottom-right');
    });

    it('prefers the kept corner, then the plugin’s, then bottom right', () => {
        expect(readCorner(undefined)).toBe('bottom-right');
        expect(readCorner('top-left')).toBe('top-left');
        expect(readCorner('middle')).toBe('bottom-right');
        saveCorner('bottom-left');
        expect(localStorage.getItem(CORNER_KEY)).toBe('bottom-left');
        expect(readCorner('top-left')).toBe('bottom-left');
        localStorage.setItem(CORNER_KEY, 'nonsense');
        expect(readCorner('top-right')).toBe('top-right');
    });

    it('survives storage that throws', () => {
        const blocked = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        expect(readCorner('top-right', blocked)).toBe('top-right');
        expect(() => saveCorner('top-left', blocked)).not.toThrow();
    });
});

describe('capture', () => {
    const steps: Step[] = [
        { kind: 'nav', t: 1, url: 'http://localhost/people', how: 'load' },
        { kind: 'click', t: 2, selector: '#save', words: 'Save', x: 5, y: 6 },
    ];
    const recorder = {
        steps: () => steps,
        errors: () => [{ t: 3, message: 'TypeError: boom' }],
        failed: () => [{ t: 4, method: 'POST', url: 'http://localhost/api/save', status: 422, ms: 30 }],
    };
    const build = { project: 'canvas-example', branch: 'claude/fix-save', commit: 'abc1234', base: '/__canvas/', corner: 'bottom-right' };

    it('assembles element facts, env, steps, errors and failed requests', () => {
        document.body.innerHTML = '<main data-canvas-src="src/app.tsx:3"><button id="save" role="button">Save</button></main>';
        const capture = assemble({ el: document.getElementById('save')! }, build, recorder, { screen: 'u1' });
        expect(capture.version).toBe(1);
        expect(capture.element).toMatchObject({ selector: '#save', words: 'Save', tag: 'button', role: 'button', source: 'src/app.tsx:3' });
        expect(capture.element!.rect).toEqual({ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });
        expect(capture.env).toMatchObject({ url: 'http://localhost:3000/people', branch: 'claude/fix-save', commit: 'abc1234', scheme: 'light' });
        expect(capture.env.viewport.w).toBeGreaterThan(0);
        expect(capture.steps).toEqual(steps);
        expect(capture.errors).toHaveLength(1);
        expect(capture.failed[0].status).toBe(422);
        expect(capture.shots).toEqual({ screen: 'u1' });
        expect(capture.area).toBeUndefined();
    });

    it('an area or a point has no element', () => {
        const area = assemble({ area: { x: 1, y: 2, w: 30, h: 40 } }, undefined, recorder);
        expect(area.element).toBeNull();
        expect(area.area).toEqual({ x: 1, y: 2, w: 30, h: 40 });
        expect(area.env.branch).toBeUndefined();
        const point = assemble({ point: { x: 5, y: 6 } }, undefined, recorder);
        expect(point.point).toEqual({ x: 5, y: 6 });
    });

    it('private elements give no words', () => {
        document.body.innerHTML = '<div data-canvas-private><b id="who">Ruth Adeyemi</b></div>';
        expect(elementFacts(document.getElementById('who')!).words).toBe('');
    });

    it('draws and uploads shots, leaving out any that fail', async () => {
        document.body.innerHTML = '<button id="save">Save</button>';
        const blob = (s: string) => new Blob([s], { type: 'image/webp' });
        const shots = await takeShots(
            { el: document.getElementById('save')! },
            { shootElement: async () => blob('el'), shootScreen: async () => Promise.reject(new Error('no canvas')) },
        );
        expect(Object.keys(shots)).toEqual(['element']);
        const areaShots = await takeShots({ area: { x: 0, y: 0, w: 1, h: 1 } }, { shootElement: vi.fn(), shootScreen: async () => blob('s') });
        expect(Object.keys(areaShots)).toEqual(['screen']);

        const upload = vi.fn(async (b: Blob) => {
            if ((await b.text()) === 's') throw new Error('500');
            return { id: 'up-el' };
        });
        expect(await uploadShots({ element: blob('el'), screen: blob('s') }, upload, '/__canvas')).toEqual({ element: 'up-el' });
        expect(upload).toHaveBeenCalledWith(expect.any(Blob), '/__canvas');
    });

    it('the base loses its trailing slash', () => {
        expect(baseOf(build)).toBe('/__canvas');
        expect(baseOf(undefined)).toBe('/__canvas');
    });

    it('"Add to board" replays only the steps since the page loaded', () => {
        const all: Step[] = [
            { kind: 'click', t: 0, selector: '#a', words: '', x: 0, y: 0 },
            ...steps,
        ];
        expect(stepsSinceLoad(all)).toEqual([steps[1]]);
        expect(stepsSinceLoad([steps[1]])).toEqual([steps[1]]);
    });
});

describe('pins', () => {
    const thread = (over: Partial<Thread>): Thread => ({
        id: 't1', url: 'http://localhost:3000/people', selector: null, words: null, component: null, source: null, branch: null,
        commit_sha: null, viewport: null, x: null, y: null, w: null, h: null, status: 'open', has_capture: true,
        created_by: 'jordan@example.org', created_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z',
        resolved_by: null, resolved_at: null, comments: [], ...over,
    });

    it('keeps open threads on this path, oldest first', () => {
        const list = [
            thread({ id: 'b', created_at: '2026-10-16T11:00:00Z', url: 'http://localhost:3000/people?tab=open' }),
            thread({ id: 'a' }),
            thread({ id: 'r', status: 'resolved' }),
            thread({ id: 'x', url: 'http://localhost:3000/settings' }),
        ];
        expect(openHere(list, 'http://localhost:3000/people#top').map((t) => t.id)).toEqual(['a', 'b']);
    });

    it('finds the element by selector, else uses the saved box', () => {
        document.body.innerHTML = '<button id="save">Save</button>';
        const el = document.getElementById('save')!;
        vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 50, height: 30 } as DOMRect);
        expect(anchorOf(thread({ selector: '#save' }))).toEqual({ left: 10, top: 20, width: 50, height: 30 });
        expect(anchorOf(thread({ selector: '#gone', x: 5, y: 6, w: 7, h: 8 }))).toEqual({ left: 5, top: 6, width: 7, height: 8 });
        expect(anchorOf(thread({ selector: '[[bad' }))).toBeNull();
    });

    it('puts a pin on the top-right corner, inside the viewport', () => {
        expect(pinAt({ left: 10, top: 100, width: 100, height: 20 }, 0, 390)).toEqual({ x: 98, y: 84 });
        expect(pinAt({ left: 300, top: 100, width: 100, height: 20 }, 0, 390).x).toBe(362);
        expect(pinAt({ left: 10, top: 100, width: 100, height: 20 }, 1, 390).x).toBe(70);
    });
});

describe('board messages', () => {
    function framedWindow() {
        const posted: unknown[] = [];
        const parent = { postMessage: (m: unknown, origin: string) => posted.push({ m, origin }), location: { origin: location.origin } };
        const listeners: ((e: MessageEvent) => void)[] = [];
        const win = {
            parent,
            location: { origin: location.origin, href: location.href },
            addEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.push(fn),
            removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.splice(listeners.indexOf(fn), 1),
        } as unknown as Window;
        const send = (data: unknown, origin = location.origin, source: unknown = parent) =>
            listeners.forEach((fn) => fn({ data, origin, source } as MessageEvent));
        return { win, posted, send, listeners };
    }

    it('says ready, then answers replay with replayed', async () => {
        const { win, posted, send } = framedWindow();
        const replay = vi.fn(async () => ({ ok: false, failedAt: 2 }));
        connectBoard({ replay, mode: vi.fn(), pins: vi.fn() }, win);
        expect(posted[0]).toEqual({ m: { canvas: 1, type: 'ready', url: location.href }, origin: location.origin });
        const steps: Step[] = [{ kind: 'click', t: 1, selector: '#save', words: 'Save', x: 0, y: 0 }];
        send({ canvas: 1, type: 'replay', steps });
        await vi.waitFor(() => expect(posted).toHaveLength(2));
        expect(replay).toHaveBeenCalledWith(steps);
        expect(posted[1]).toEqual({ m: { canvas: 1, type: 'replayed', ok: false, failedAt: 2 }, origin: location.origin });
    });

    it('passes mode and pins on, sends picked, and ignores other origins and junk', () => {
        const { win, posted, send, listeners } = framedWindow();
        const mode = vi.fn();
        const pins = vi.fn();
        const link = connectBoard({ replay: vi.fn(), mode, pins }, win);
        send({ canvas: 1, type: 'mode', comment: true });
        send({ canvas: 1, type: 'pins', threads: [] });
        send({ canvas: 1, type: 'mode', comment: false }, 'https://evil.example.org');
        send({ canvas: 1, type: 'mode', comment: false }, location.origin, {});
        send({ type: 'mode', comment: false });
        send({ canvas: 1, type: 'mode', comment: 'yes' });
        expect(mode.mock.calls).toEqual([[true]]);
        expect(pins).toHaveBeenCalledWith([]);
        const capture = assemble({ point: { x: 1, y: 2 } }, undefined, { steps: () => [], errors: () => [], failed: () => [] });
        link.picked(capture);
        expect(posted[1]).toEqual({ m: { canvas: 1, type: 'picked', capture }, origin: location.origin });
        link.stop();
        expect(listeners).toHaveLength(0);
    });

    it('knows when it is framed by a same-origin board', () => {
        expect(isFramed(window)).toBe(false);
        expect(isFramed({ parent: { location: { origin: location.origin } }, location } as unknown as Window)).toBe(true);
        const crossOrigin = {
            parent: {
                get location(): Location {
                    throw new Error('SecurityError');
                },
            },
            location,
        } as unknown as Window;
        expect(isFramed(crossOrigin)).toBe(false);
    });
});
