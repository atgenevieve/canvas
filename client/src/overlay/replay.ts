// Replays recorded steps on the current page, to bring a board's screen to a state. Each step's element is waited for
// (up to 3s by default); the first one that never shows stops the replay and is reported as `failedAt`.
import type { Step, Value } from '../../../shared/contract.ts';

export interface ReplayOptions {
    /** How long to wait for each step's element, in ms. Default 3000. */
    timeout?: number;
    /** A pause after each step so the app can react, in ms. Default 50. */
    pause?: number;
    signal?: AbortSignal;
}

export interface ReplayResult {
    ok: boolean;
    failedAt?: number;
}

const POLL_MS = 50;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(selector: string, timeout: number, signal?: AbortSignal): Promise<Element | null> {
    const end = Date.now() + timeout;
    for (;;) {
        if (signal?.aborted) return null;
        let el: Element | null;
        try {
            el = document.querySelector(selector);
        } catch (_e) {
            return null; // not a valid selector
        }
        if (el) return el;
        if (Date.now() >= end) return null;
        await sleep(POLL_MS);
    }
}

function text(value: Value): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return String(value);
    return ''; // masked values replay as empty
}

// Sets a value the way typing does, through the prototype's setter, so React's value tracking sees the change.
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
    const proto = Object.getPrototypeOf(el) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
}

function fire(el: Element, type: string): void {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: type !== 'input' }));
}

function click(el: Element): void {
    const init = { bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new MouseEvent('mousedown', init));
    if (el instanceof HTMLElement) el.focus();
    el.dispatchEvent(new MouseEvent('mouseup', init));
    if (el instanceof HTMLElement) el.click();
    else el.dispatchEvent(new MouseEvent('click', init));
}

function type(el: Element, value: string): void {
    if (el instanceof HTMLElement) el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        setValue(el, value);
    } else {
        el.textContent = value;
    }
    fire(el, 'input');
    fire(el, 'change');
}

function choose(el: Element, value: Value): void {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = value === true || value === 'true';
        if (el.checked !== want) click(el);
        return;
    }
    if (el instanceof HTMLSelectElement && el.multiple) {
        const want = new Set(text(value).split(','));
        for (const option of el.options) option.selected = want.has(option.value);
        fire(el, 'input');
        fire(el, 'change');
        return;
    }
    type(el, text(value));
}

function navigate(url: string, how: 'load' | 'push' | 'replace' | 'pop'): 'done' | 'left' | 'failed' {
    let target: URL;
    try {
        target = new URL(url, location.href);
    } catch (_e) {
        return 'failed';
    }
    if (target.href === location.href) return 'done';
    if (target.origin !== location.origin) return 'failed';
    if (how === 'load') {
        location.assign(target.href);
        return 'left';
    }
    if (how === 'replace') history.replaceState(history.state, '', target.href);
    else history.pushState(null, '', target.href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return 'done';
}

/** Replays steps on this page. Resizes are skipped: a page cannot resize its own window. */
export async function replay(steps: Step[], opts: ReplayOptions = {}): Promise<ReplayResult> {
    const timeout = opts.timeout ?? 3000;
    const pause = opts.pause ?? 50;
    for (let i = 0; i < steps.length; i++) {
        if (opts.signal?.aborted) return { ok: false, failedAt: i };
        const step = steps[i];
        const find = async (selector: string) => waitFor(selector, timeout, opts.signal);
        switch (step.kind) {
            case 'click': {
                const el = await find(step.selector);
                if (!el) return { ok: false, failedAt: i };
                click(el);
                break;
            }
            case 'input': {
                const el = await find(step.selector);
                if (!el) return { ok: false, failedAt: i };
                type(el, text(step.value));
                if (el instanceof HTMLElement) el.blur();
                break;
            }
            case 'change': {
                const el = await find(step.selector);
                if (!el) return { ok: false, failedAt: i };
                choose(el, step.value);
                break;
            }
            case 'key': {
                const el = step.selector ? await find(step.selector) : (document.activeElement ?? document.body);
                if (!el) return { ok: false, failedAt: i };
                const init = { key: step.key, bubbles: true, cancelable: true, composed: true };
                el.dispatchEvent(new KeyboardEvent('keydown', init));
                el.dispatchEvent(new KeyboardEvent('keyup', init));
                break;
            }
            case 'scroll': {
                if (step.selector === 'window') {
                    window.scrollTo(step.x, step.y);
                } else {
                    const el = await find(step.selector);
                    if (!el) return { ok: false, failedAt: i };
                    el.scrollLeft = step.x;
                    el.scrollTop = step.y;
                }
                break;
            }
            case 'nav': {
                const result = navigate(step.url, step.how);
                if (result === 'failed') return { ok: false, failedAt: i };
                if (result === 'left') return { ok: true }; // the page is loading; the rest cannot run here
                break;
            }
            case 'resize':
                continue;
        }
        if (pause > 0) await sleep(pause);
    }
    return { ok: true };
}
