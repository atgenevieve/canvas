// The recorder: what you did before commenting, kept in memory as a ring buffer (the last MAX_STEPS steps or
// MAX_STEP_AGE_MS, whichever is shorter), plus console errors and failed requests. Nothing leaves the page from here.
// docs/CONTRACT.md ("A capture", "Masking") says what each step holds.
import { DEFAULT_BASE, MAX_STEP_AGE_MS, MAX_STEPS } from '../../../shared/contract.ts';
import type { ConsoleError, FailedRequest, Step, Value } from '../../../shared/contract.ts';
import { isPrivate, isTextField, labelOf, selectorFor, valueOf, wordsOf } from './dom.ts';

export interface RecorderOptions {
    /** Leave out events on these elements (the overlay's own UI). */
    ignore?: (el: Element) => boolean;
    /** The canvas's own path; requests under it are not recorded as failed. Default `/__canvas`. */
    base?: string;
    /** The clock, for tests. */
    now?: () => number;
}

export interface Recorder {
    steps(): Step[];
    errors(): ConsoleError[];
    failed(): FailedRequest[];
    stop(): void;
}

export const SCROLL_SETTLE_MS = 300;
export const SCROLL_MIN_PX = 100;
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']);
const MAX_MESSAGE = 2000;

type Timed = { t: number };

class Ring<T extends Timed> {
    items: T[] = [];
    constructor(private now: () => number) {}
    push(item: T): void {
        this.items.push(item);
        this.prune();
    }
    prune(): void {
        const oldest = this.now() - MAX_STEP_AGE_MS;
        let drop = 0;
        while (drop < this.items.length && this.items[drop].t < oldest) drop++;
        drop = Math.max(drop, this.items.length - MAX_STEPS);
        if (drop > 0) this.items.splice(0, drop);
    }
    list(): T[] {
        this.prune();
        return this.items.slice();
    }
}

interface PendingInput {
    el: Element;
    t: number;
    selector: string;
    label?: string;
    value: Value;
}

interface PendingScroll {
    timer: ReturnType<typeof setTimeout>;
    fire: () => void;
}

function targetOf(event: Event): Element | null {
    const t = event.composedPath?.()[0] ?? event.target;
    if (t instanceof Element) return t;
    if (t instanceof Node) return t.parentElement;
    return null;
}

function messageOf(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch (_e) {
        return String(value);
    }
}

function clip(s: string): string {
    return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s;
}

export function startRecorder(opts: RecorderOptions = {}): Recorder {
    const now = opts.now ?? (() => Date.now());
    const ignore = opts.ignore ?? (() => false);
    const base = opts.base ?? DEFAULT_BASE;
    const win = window;
    const doc = document;

    const steps = new Ring<Step>(now);
    const errors = new Ring<ConsoleError>(now);
    const failed = new Ring<FailedRequest>(now);
    const undo: (() => void)[] = [];
    let pending: PendingInput | null = null;
    const scrolls = new Map<Element | 'window', PendingScroll>();
    const settled = new WeakMap<object, { x: number; y: number }>();
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSize = { w: win.innerWidth, h: win.innerHeight };

    function flushInput(): void {
        if (!pending) return;
        const { el: _el, ...step } = pending;
        pending = null;
        steps.push({ kind: 'input', ...step });
    }

    function flushScrolls(): void {
        for (const [key, s] of [...scrolls]) {
            clearTimeout(s.timer);
            scrolls.delete(key);
            s.fire();
        }
    }

    // Every step but a pending input's own update goes through here, so an input step is written before the next step.
    function record(step: Step): void {
        flushInput();
        if (step.kind !== 'scroll') flushScrolls();
        steps.push(step);
    }

    function on<K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void): void {
        doc.addEventListener(type, fn, true);
        undo.push(() => doc.removeEventListener(type, fn, true));
    }
    function onWindow<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void {
        win.addEventListener(type, fn, true);
        undo.push(() => win.removeEventListener(type, fn, true));
    }

    // Clicks
    on('click', (e) => {
        const el = targetOf(e);
        if (!el || ignore(el)) return;
        record({
            kind: 'click',
            t: now(),
            selector: selectorFor(el),
            words: isPrivate(el) ? '' : wordsOf(el),
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
        });
    });

    // Typing: one step per field per focus, written on blur or when another step comes
    on('input', (e) => {
        const el = targetOf(e);
        if (!el || ignore(el) || !isTextField(el)) return;
        if (el instanceof HTMLInputElement && el.type === 'file') return;
        if (pending && pending.el !== el) flushInput();
        if (!pending) {
            flushScrolls();
            pending = { el, t: now(), selector: selectorFor(el), label: labelOf(el), value: valueOf(el) };
            if (pending.label === undefined) delete pending.label;
        } else {
            pending.value = valueOf(el);
        }
    });
    on('focusout', (e) => {
        if (pending && targetOf(e) === pending.el) flushInput();
    });

    // Choices: selects, checkboxes, radios
    on('change', (e) => {
        const el = targetOf(e);
        if (!el || ignore(el)) return;
        const choice =
            el instanceof HTMLSelectElement ||
            (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'));
        if (!choice) return;
        const label = labelOf(el);
        record({ kind: 'change', t: now(), selector: selectorFor(el), ...(label !== undefined && { label }), value: valueOf(el) });
    });

    // Keys that do something outside a text field
    on('keydown', (e) => {
        if (!KEYS.has(e.key) || e.repeat) return;
        const el = targetOf(e);
        if (el && (ignore(el) || isTextField(el))) return;
        const onPage = el && el !== doc.body && el !== doc.documentElement;
        record({ kind: 'key', t: now(), key: e.key, ...(onPage && { selector: selectorFor(el) }) });
    });

    // Navigation: the load, history.pushState/replaceState, back and forward
    record({ kind: 'nav', t: now(), url: win.location.href, how: 'load' });
    const history = win.history;
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    const patchedPush: History['pushState'] = function (this: History, ...args) {
        origPush.apply(this, args);
        record({ kind: 'nav', t: now(), url: win.location.href, how: 'push' });
    };
    const patchedReplace: History['replaceState'] = function (this: History, ...args) {
        origReplace.apply(this, args);
        record({ kind: 'nav', t: now(), url: win.location.href, how: 'replace' });
    };
    history.pushState = patchedPush;
    history.replaceState = patchedReplace;
    undo.push(() => {
        if (history.pushState === patchedPush) history.pushState = origPush;
        if (history.replaceState === patchedReplace) history.replaceState = origReplace;
    });
    onWindow('popstate', () => record({ kind: 'nav', t: now(), url: win.location.href, how: 'pop' }));

    // Scrolls: written once a scroller rests for 300ms, if it moved more than 100px since the last one written
    const scrollOf = (key: Element | 'window') =>
        key === 'window'
            ? { x: Math.round(win.scrollX), y: Math.round(win.scrollY) }
            : { x: Math.round(key.scrollLeft), y: Math.round(key.scrollTop) };
    settled.set(win, scrollOf('window'));
    on('scroll', (e) => {
        const t = e.target;
        const key: Element | 'window' = t === doc || t === win || t === doc.documentElement || t === doc.body ? 'window' : (t as Element);
        if (key !== 'window' && (!(key instanceof Element) || ignore(key))) return;
        const existing = scrolls.get(key);
        if (existing) clearTimeout(existing.timer);
        const fire = () => {
            scrolls.delete(key);
            const at = scrollOf(key);
            const from = settled.get(key === 'window' ? win : key) ?? { x: 0, y: 0 };
            if (Math.abs(at.x - from.x) <= SCROLL_MIN_PX && Math.abs(at.y - from.y) <= SCROLL_MIN_PX) return;
            settled.set(key === 'window' ? win : key, at);
            flushInput();
            steps.push({ kind: 'scroll', t: now(), selector: key === 'window' ? 'window' : selectorFor(key), ...at });
        };
        scrolls.set(key, { fire, timer: setTimeout(fire, SCROLL_SETTLE_MS) });
    });

    // Resizes, settled the same way
    onWindow('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            const size = { w: win.innerWidth, h: win.innerHeight };
            if (size.w === lastSize.w && size.h === lastSize.h) return;
            lastSize = size;
            record({ kind: 'resize', t: now(), ...size });
        }, SCROLL_SETTLE_MS);
    });

    // Console errors, uncaught errors and unhandled rejections
    const origError = console.error;
    const patchedError = function (this: Console, ...args: unknown[]) {
        try {
            const err = args.find((a): a is Error => a instanceof Error);
            errors.push({ t: now(), message: clip(args.map(messageOf).join(' ')), ...(err?.stack && { stack: clip(err.stack) }) });
        } catch (_e) {
            // never let recording break the app's logging
        }
        return origError.apply(this, args);
    };
    console.error = patchedError;
    undo.push(() => {
        if (console.error === patchedError) console.error = origError;
    });
    onWindow('error', (e) => {
        if (!(e instanceof ErrorEvent)) return; // a resource that failed to load, not a script error
        const err = e.error instanceof Error ? e.error : null;
        errors.push({ t: now(), message: clip(err ? messageOf(err) : e.message), ...(err?.stack && { stack: clip(err.stack) }) });
    });
    onWindow('unhandledrejection', (e) => {
        const reason: unknown = e.reason;
        const stack = reason instanceof Error ? reason.stack : undefined;
        errors.push({ t: now(), message: clip(`Unhandled rejection: ${messageOf(reason)}`), ...(stack && { stack: clip(stack) }) });
    });

    // Failed requests: method, URL, status, duration; never bodies
    const ours = (url: string) => {
        try {
            const u = new URL(url, win.location.href);
            return u.origin === win.location.origin && (u.pathname === base || u.pathname.startsWith(`${base}/`));
        } catch (_e) {
            return false;
        }
    };
    const absolute = (url: string) => {
        try {
            return new URL(url, win.location.href).href;
        } catch (_e) {
            return url;
        }
    };
    const fail = (method: string, url: string, status: number, start: number) => {
        if (ours(url)) return;
        failed.push({ t: now(), method: method.toUpperCase(), url: absolute(url), status, ms: Math.round(performance.now() - start) });
    };

    const origFetch = win.fetch;
    if (origFetch) {
        const patchedFetch: typeof fetch = async function (this: unknown, input, init) {
            const start = performance.now();
            const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
            const url = req ? req.url : input instanceof URL ? input.href : String(input);
            const method = init?.method ?? req?.method ?? 'GET';
            try {
                const res = await origFetch.call(this === win ? win : this ?? win, input, init);
                if (res.status >= 400) fail(method, url, res.status, start);
                return res;
            } catch (err) {
                if (!(err instanceof Error && err.name === 'AbortError')) fail(method, url, 0, start);
                throw err;
            }
        };
        win.fetch = patchedFetch;
        undo.push(() => {
            if (win.fetch === patchedFetch) win.fetch = origFetch;
        });
    }

    const XHR = win.XMLHttpRequest;
    if (XHR) {
        const proto = XHR.prototype;
        const origOpen = proto.open;
        const origSend = proto.send;
        const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
        const patchedOpen = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
            meta.set(this, { method, url: String(url) });
            return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
        } as XMLHttpRequest['open'];
        const patchedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
            const info = meta.get(this);
            if (info) {
                const start = performance.now();
                let aborted = false;
                this.addEventListener('abort', () => (aborted = true));
                this.addEventListener('loadend', () => {
                    if (aborted) return;
                    if (this.status === 0 || this.status >= 400) fail(info.method, info.url, this.status, start);
                });
            }
            return origSend.call(this, body);
        };
        proto.open = patchedOpen;
        proto.send = patchedSend;
        undo.push(() => {
            if (proto.open === patchedOpen) proto.open = origOpen;
            if (proto.send === patchedSend) proto.send = origSend;
        });
    }

    return {
        steps() {
            const list = steps.list();
            if (pending) {
                const { el: _el, ...step } = pending;
                list.push({ kind: 'input', ...step });
                return list.slice(-MAX_STEPS);
            }
            return list;
        },
        errors: () => errors.list(),
        failed: () => failed.list(),
        stop() {
            flushInput();
            for (const s of scrolls.values()) clearTimeout(s.timer);
            scrolls.clear();
            if (resizeTimer) clearTimeout(resizeTimer);
            while (undo.length) undo.pop()!();
        },
    };
}
