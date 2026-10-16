// The overlay on a page: the toolbar pill, comment mode (hover, pick an element or drag out an area), the comment box,
// pins for this page's open threads and their thread popovers, and, inside a board's frame, the board's messages.
// docs/CONTRACT.md, "The overlay on its own" and "Board ↔ overlay messages". All of it lives in one shadow root on a
// host marked `data-canvas-ui`, which screenshots and the recorder leave out.
import type { Capture, Step, Thread } from '../../../shared/contract.ts';
import { Api } from './api.ts';
import { labelFor } from './chain.ts';
import { assemble, baseOf, takeShots, uploadShots, type BuildInfo, type Shooters, type Shots, type Target, type Upload } from './capture.ts';
import { nearestCorner, readCorner, saveCorner, type Corner } from './corner.ts';
import { isTextField } from './dom.ts';
import { connectBoard, isFramed, type BoardLink } from './messages.ts';
import { anchorOf, openHere, pinAt, type Box } from './pins.ts';
import { startRecorder, type Recorder } from './recorder.ts';
import { replay } from './replay.ts';
import { CSS, ICON_BOARD, ICON_COMMENT } from './styles.ts';

export const HOST_TAG = 'canvas-overlay';
const DRAG_PX = 6;
const LONG_PRESS_MS = 500;
const LAYOUT_THROTTLE_MS = 100;
const TOAST_MS = 2200;

export interface OverlayDeps {
    shooters: Shooters;
    upload: Upload;
    framed?: boolean;
}

export interface CanvasHandle {
    steps(): Step[];
    capture(el: Element): Capture;
    mode(on: boolean): void;
}

interface Draft {
    target: Target;
    capture: Capture;
    shots: Promise<Shots>;
    box: () => Box | null;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = v;
        else el.setAttribute(k, v);
    }
    if (text !== undefined) el.textContent = text;
    return el;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
function when(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : `${dayFmt.format(d)}, ${timeFmt.format(d)}`;
}

/** Steps since the page loaded: what "Add to board" replays after loading the path. */
export function stepsSinceLoad(steps: Step[]): Step[] {
    let from = 0;
    for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s.kind === 'nav' && s.how === 'load') {
            from = i + 1;
            break;
        }
    }
    return steps.slice(from);
}

function boxOfRect(r: DOMRect | Box): Box {
    return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function startOverlay(build: BuildInfo | undefined, deps: OverlayDeps): CanvasHandle {
    const base = baseOf(build);
    const api = new Api(base);
    const framed = deps.framed ?? isFramed();

    // ---- the host and its shadow root ----
    const host = document.createElement(HOST_TAG);
    host.setAttribute('data-canvas-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = CSS;
    const ui = h('div', { class: 'root' });
    shadow.append(style, ui);

    const inUi = (el: Element) => el === host || el.getRootNode() === shadow;
    const recorder: Recorder = startRecorder({ ignore: inUi, base });

    const layer = h('div', { class: 'layer', hidden: '' });
    const hover = h('div', { class: 'hl', hidden: '' });
    const picked = h('div', { class: 'hl', hidden: '' });
    const areaBox = h('div', { class: 'area', hidden: '' });
    const tag = h('div', { class: 'tag', hidden: '', 'aria-hidden': 'true' });
    const pinLayer = h('div');
    const pop = h('div', { class: 'pop', role: 'dialog', hidden: '' });
    const live = h('div', { class: 'sr', 'aria-live': 'polite' });
    ui.append(layer, hover, picked, areaBox, tag, pinLayer, pop, live);

    // ---- state ----
    let mode = false;
    let hoverEl: Element | null = null;
    let draft: Draft | null = null;
    let threads: Thread[] = [];
    let me = '';
    let openId: string | null = null;
    let returnFocus: HTMLElement | null = null;
    let lastPath = location.pathname;
    const replyDrafts = new Map<string, string>();
    let pill: HTMLDivElement | null = null;
    let modeBtn: HTMLButtonElement | null = null;
    let count: HTMLSpanElement | null = null;
    let menu: HTMLDivElement | null = null;
    let link: BoardLink | null = null;
    let corner: Corner = readCorner(build?.corner);
    let pinned: Thread[] = [];

    // ---- placing things ----
    function outline(el: HTMLElement, box: Box | null): void {
        if (!box) {
            el.hidden = true;
            return;
        }
        el.hidden = false;
        Object.assign(el.style, {
            left: `${box.left - 4}px`,
            top: `${box.top - 4}px`,
            width: `${box.width + 8}px`,
            height: `${box.height + 8}px`,
        });
    }

    function placeTag(box: Box | null, text: string): void {
        if (!box) {
            tag.hidden = true;
            return;
        }
        tag.textContent = text;
        tag.hidden = false;
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const vh = window.innerHeight;
        const th = tag.offsetHeight || 18;
        const tw = tag.offsetWidth || 120;
        let y = box.top + box.height + 6;
        if (y + th > vh - 4) y = Math.max(4, box.top - th - 6);
        const x = Math.min(Math.max(4, box.left + box.width - tw + 4), vw - tw - 4);
        Object.assign(tag.style, { left: `${Math.max(4, x)}px`, top: `${y}px` });
    }

    // A floating box goes below what it's about, else above, else as low as it fits.
    function placePop(box: Box | null): void {
        if (pop.hidden) return;
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const vh = window.innerHeight;
        const pw = pop.offsetWidth || 300;
        const ph = pop.offsetHeight || 140;
        const at = box ?? { left: (vw - pw) / 2, top: vh / 3, width: 0, height: 0 };
        const gap = tag.hidden ? 10 : 30;
        const below = at.top + at.height + gap;
        const above = at.top - 10 - ph;
        const y = below + ph <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - ph - 8);
        const x = Math.min(Math.max(8, at.left + at.width / 2 - pw / 2), vw - pw - 8);
        Object.assign(pop.style, { left: `${x}px`, top: `${y}px` });
    }

    // ---- comment mode ----
    function setMode(on: boolean): void {
        if (mode === on) return;
        mode = on;
        layer.hidden = !on;
        modeBtn?.setAttribute('aria-pressed', String(on));
        if (!on) {
            hoverEl = null;
            outline(hover, null);
            outline(areaBox, null);
            if (draft) closeDraft();
            else if (!openId) outline(picked, null);
            tag.hidden = true;
        }
    }

    function hit(x: number, y: number): Element | null {
        for (const el of document.elementsFromPoint(x, y)) if (!inUi(el)) return el;
        return null;
    }

    function showHover(el: Element | null): void {
        hoverEl = el;
        if (!el || el === document.documentElement || el === document.body) {
            outline(hover, null);
            if (!draft) tag.hidden = true;
            return;
        }
        const box = boxOfRect(el.getBoundingClientRect());
        outline(hover, box);
        placeTag(box, labelFor(el));
    }

    let press: { id: number; x: number; y: number; touch: boolean; area: boolean } | null = null;
    layer.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        press = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', area: false };
        if (!press.touch) layer.setPointerCapture?.(e.pointerId);
    });
    layer.addEventListener('pointermove', (e) => {
        if (press && press.id === e.pointerId && !press.touch) {
            if (!press.area && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) {
                press.area = true;
                outline(hover, null);
                tag.hidden = true;
            }
            if (press.area) {
                const box = {
                    left: Math.min(press.x, e.clientX),
                    top: Math.min(press.y, e.clientY),
                    width: Math.abs(e.clientX - press.x),
                    height: Math.abs(e.clientY - press.y),
                };
                areaBox.hidden = false;
                Object.assign(areaBox.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
            }
            return;
        }
        if (!press && e.pointerType !== 'touch') showHover(hit(e.clientX, e.clientY));
    });
    layer.addEventListener('pointerup', (e) => {
        const p = press;
        press = null;
        if (!p || p.id !== e.pointerId) return;
        e.preventDefault();
        if (p.area) {
            areaBox.hidden = true;
            const x = Math.min(p.x, e.clientX);
            const y = Math.min(p.y, e.clientY);
            const area = {
                x: Math.round(x + window.scrollX),
                y: Math.round(y + window.scrollY),
                w: Math.round(Math.abs(e.clientX - p.x)),
                h: Math.round(Math.abs(e.clientY - p.y)),
            };
            void pick({ area });
            return;
        }
        const el = hit(e.clientX, e.clientY);
        if (!el || el === document.documentElement || el === document.body) {
            void pick({ point: { x: Math.round(e.clientX + window.scrollX), y: Math.round(e.clientY + window.scrollY) } });
        } else {
            void pick({ el });
        }
    });
    layer.addEventListener('pointercancel', () => {
        press = null;
        areaBox.hidden = true;
    });
    layer.addEventListener('click', (e) => e.preventDefault());

    function boxFor(target: Target): () => Box | null {
        if ('el' in target) {
            const el = target.el;
            return () => (el.isConnected ? boxOfRect(el.getBoundingClientRect()) : null);
        }
        const r = 'area' in target ? target.area : { ...target.point, w: 0, h: 0 };
        return () => ({ left: r.x - window.scrollX, top: r.y - window.scrollY, width: r.w, height: r.h });
    }

    async function pick(target: Target): Promise<void> {
        outline(hover, null);
        const capture = assemble(target, build, recorder);
        const box = boxFor(target);
        const label = 'el' in target ? labelFor(target.el) : '';
        outline(picked, 'point' in target ? null : box());
        if (label) placeTag(box(), label);
        else tag.hidden = true;
        const shots = takeShots(target, deps.shooters);
        if (link) {
            // In a board's frame the board writes the comment; the shots go up now so the capture is whole.
            const ids = await uploadShots(await shots, deps.upload, base);
            link.picked({ ...capture, shots: ids });
            return;
        }
        if (openId) closeThread(false);
        const text = draft ? (pop.querySelector('textarea')?.value ?? '') : '';
        draft = { target, capture, shots, box };
        openComposer(text);
    }

    // ---- the popover: a new comment, or a thread ----
    function focusables(): HTMLElement[] {
        return [...pop.querySelectorAll<HTMLElement>('button, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(
            (el) => !(el as HTMLButtonElement).disabled && !el.hidden,
        );
    }
    pop.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = shadow.activeElement;
        if (e.shiftKey && (active === first || !pop.contains(active))) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (active === last || !pop.contains(active))) {
            e.preventDefault();
            first.focus();
        }
    });

    function rememberFocus(): void {
        if (!pop.hidden) return;
        const active = shadow.activeElement ?? document.activeElement;
        returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    function restoreFocus(): void {
        const el = returnFocus;
        returnFocus = null;
        if (el?.isConnected) el.focus({ preventScroll: true });
    }

    interface ComposerOpts {
        label: string;
        submit: string;
        value: string;
        onSubmit(text: string): Promise<void>;
        onCancel?: () => void;
        onInput?: (text: string) => void;
        extra?: HTMLElement;
        className?: string;
    }
    function composer(o: ComposerOpts): { form: HTMLFormElement; textarea: HTMLTextAreaElement } {
        const form = h('form', { class: o.className ?? '' });
        const textarea = h('textarea', { 'aria-label': o.label, rows: '3' });
        textarea.value = o.value;
        const err = h('p', { class: 'err', role: 'alert' });
        const act = h('div', { class: 'act' });
        if (o.extra) act.append(o.extra);
        if (o.onCancel) {
            const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
            cancel.addEventListener('click', o.onCancel);
            act.append(cancel);
        }
        const send = h('button', { type: 'submit', class: 'btn p' }, o.submit);
        act.append(send);
        form.append(textarea, err, act);
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                form.requestSubmit();
            }
        });
        if (o.onInput) textarea.addEventListener('input', () => o.onInput!(textarea.value));
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = textarea.value.trim();
            if (!text || send.disabled) return;
            send.disabled = true;
            err.textContent = '';
            try {
                await o.onSubmit(text);
            } catch (x) {
                err.textContent = x instanceof Error && x.message ? x.message : 'Couldn’t save. Try again.';
                send.disabled = false;
            }
        });
        return { form, textarea };
    }

    function openComposer(text: string): void {
        rememberFocus();
        const { form, textarea } = composer({
            label: 'Comment',
            submit: 'Post',
            value: text,
            onCancel: () => closeDraft(),
            onSubmit: post,
        });
        pop.setAttribute('aria-label', 'New comment');
        pop.replaceChildren(form);
        pop.hidden = false;
        placePop(draft?.box() ?? null);
        textarea.focus({ preventScroll: true });
    }

    async function post(body: string): Promise<void> {
        const d = draft;
        if (!d) return;
        const ids = await uploadShots(await d.shots, deps.upload, base);
        const { thread } = await api.newThread({ body, capture: { ...d.capture, shots: ids } });
        if (draft !== d) return;
        upsert(thread);
        closeDraft();
        setMode(false);
        say('Comment posted');
    }

    function closeDraft(): void {
        draft = null;
        pop.hidden = true;
        pop.replaceChildren();
        outline(picked, null);
        tag.hidden = true;
        restoreFocus();
    }

    const who = (author: string) => (author === me ? 'You' : author === 'claude' ? 'Claude' : author.split('@')[0]);

    function renderThread(): void {
        const t = threads.find((x) => x.id === openId);
        if (!t) {
            closeThread(true);
            return;
        }
        // keep what's being typed in the reply box across re-renders
        const active = shadow.activeElement;
        const typing = active instanceof HTMLTextAreaElement && pop.contains(active) ? { s: active.selectionStart, e: active.selectionEnd } : null;

        const head = h('div', { class: 'head' });
        const what = t.component || (t.words ? `“${t.words}”` : t.w ? 'An area' : '');
        head.append(h('span', { class: 'what' }, what));
        const resolve = h('button', { type: 'button', class: 'btn' }, t.status === 'open' ? 'Resolve' : 'Reopen');
        resolve.addEventListener('click', async () => {
            resolve.disabled = true;
            try {
                const { thread } = await api.setStatus(t.id, t.status === 'open');
                upsert(thread);
                if (thread.status === 'resolved') {
                    closeThread(true);
                    say('Resolved');
                }
            } catch (x) {
                resolve.disabled = false;
                say(x instanceof Error ? x.message : 'Couldn’t save. Try again.');
            }
        });
        const close = h('button', { type: 'button', class: 'x', 'aria-label': 'Close' }, '×');
        close.addEventListener('click', () => closeThread(true));
        head.append(resolve, close);

        const msgs = h('ol', { class: 'msgs' });
        for (const c of t.comments) {
            const li = h('li');
            const meta = h('div', { class: 'who' });
            meta.append(h('b', {}, who(c.author)), ` · ${when(c.created_at)}${c.edited_at ? ' · edited' : ''}`);
            li.append(meta, h('p', { class: 'body' }, c.body));
            msgs.append(li);
        }
        const { form, textarea } = composer({
            label: 'Reply',
            submit: 'Reply',
            value: replyDrafts.get(t.id) ?? '',
            className: 'reply',
            onInput: (v) => replyDrafts.set(t.id, v),
            onSubmit: async (text) => {
                const { thread } = await api.reply(t.id, text);
                replyDrafts.delete(t.id);
                upsert(thread);
                pop.querySelector('textarea')?.focus({ preventScroll: true });
            },
        });
        pop.setAttribute('aria-label', 'Comment thread');
        pop.replaceChildren(head, msgs, form);
        if (typing) {
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(typing.s, typing.e);
        }
    }

    function openThread(id: string): void {
        if (draft) closeDraft();
        rememberFocus();
        openId = id;
        pop.hidden = false;
        renderThread();
        renderPins();
        pop.querySelector<HTMLElement>('textarea')?.focus({ preventScroll: true });
    }

    function closeThread(focusBack: boolean): void {
        openId = null;
        pop.hidden = true;
        pop.replaceChildren();
        outline(picked, null);
        renderPins();
        if (focusBack) restoreFocus();
        else returnFocus = null;
    }

    // ---- pins ----
    function renderPins(): void {
        pinned = openHere(threads);
        const buttons: HTMLButtonElement[] = [];
        for (const t of pinned) {
            const b = h('button', {
                type: 'button',
                class: 'pin',
                'aria-label': `Comment thread, ${t.comments.length} ${t.comments.length === 1 ? 'comment' : 'comments'}`,
                'aria-expanded': String(t.id === openId),
            }, String(t.comments.length || 1));
            b.dataset.id = t.id;
            b.addEventListener('click', () => (openId === t.id ? closeThread(true) : openThread(t.id)));
            buttons.push(b);
        }
        pinLayer.replaceChildren(...buttons);
        if (count) {
            count.textContent = String(pinned.length);
            count.hidden = pinned.length === 0;
            count.setAttribute('aria-label', `${pinned.length} open on this page`);
        }
        layout();
    }

    function layout(): void {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            renderPins();
            return;
        }
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const vh = window.innerHeight;
        const seen = new Map<string, number>();
        let openBox: Box | null = null;
        for (const b of pinLayer.children as HTMLCollectionOf<HTMLElement>) {
            const t = pinned.find((x) => x.id === b.dataset.id);
            const box = t ? anchorOf(t) : null;
            if (!t || !box) {
                b.hidden = true;
                continue;
            }
            const key = `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)}`;
            const index = seen.get(key) ?? 0;
            seen.set(key, index + 1);
            const at = pinAt(box, index, vw);
            b.hidden = at.y + 24 < 0 || at.y > vh;
            b.style.left = `${at.x}px`;
            b.style.top = `${at.y}px`;
            if (t.id === openId) openBox = box;
        }
        if (openId) {
            const t = threads.find((x) => x.id === openId);
            if (!openBox && t) openBox = anchorOf(t);
            outline(picked, openBox);
            placePop(openBox);
        } else if (draft) {
            const box = draft.box();
            if (!('point' in draft.target)) outline(picked, box);
            if (!tag.hidden && box) placeTag(box, tag.textContent ?? '');
            placePop(box);
        }
        if (hoverEl && mode && !press) showHover(hoverEl.isConnected ? hoverEl : null);
    }

    let frame = 0;
    let lastLayout = 0;
    let soon: ReturnType<typeof setTimeout> | null = null;
    function schedule(): void {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            lastLayout = performance.now();
            layout();
        });
    }
    // DOM changes come in bursts; lay out at most every 100ms for them.
    function scheduleSoon(): void {
        if (soon) return;
        const wait = Math.max(0, LAYOUT_THROTTLE_MS - (performance.now() - lastLayout));
        soon = setTimeout(() => {
            soon = null;
            schedule();
        }, wait);
    }
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    new MutationObserver(scheduleSoon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

    function upsert(thread: Thread): void {
        const i = threads.findIndex((t) => t.id === thread.id);
        if (i >= 0) threads[i] = thread;
        else threads.unshift(thread);
        renderPins();
        if (openId === thread.id) renderThread();
    }

    async function refresh(): Promise<void> {
        try {
            const data = await api.threads();
            me = data.me;
            threads = data.threads;
        } catch (_e) {
            return; // the canvas isn't reachable; try again on the next change
        }
        renderPins();
        if (openId) renderThread();
    }

    // ---- the toolbar ----
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    function say(text: string, visible = false): void {
        live.textContent = text;
        if (!visible || !pill) return;
        let toast = ui.querySelector<HTMLElement>('.toast');
        if (!toast) {
            toast = h('div', { class: 'toast', 'aria-hidden': 'true' });
            ui.append(toast);
        }
        toast.textContent = text;
        toast.hidden = false;
        placeNear(toast);
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast!.remove(), TOAST_MS);
    }

    // the menu and toast sit above the pill, or below it when the pill is at the top
    function placeNear(el: HTMLElement): void {
        if (!pill) return;
        const r = pill.getBoundingClientRect();
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const w = el.offsetWidth || 140;
        const hgt = el.offsetHeight || 40;
        const y = corner.startsWith('top') ? r.bottom + 8 : r.top - hgt - 8;
        const x = corner.endsWith('left') ? r.left : r.right - w;
        Object.assign(el.style, { left: `${Math.min(Math.max(8, x), vw - w - 8)}px`, top: `${y}px` });
    }

    function closeMenu(focusBack = true): void {
        if (!menu) return;
        menu.remove();
        menu = null;
        modeBtn?.setAttribute('aria-expanded', 'false');
        if (focusBack) modeBtn?.focus({ preventScroll: true });
    }

    function openMenu(): void {
        if (menu) return;
        menu = h('div', { class: 'menu', role: 'menu', 'aria-label': 'Canvas' });
        const add = h('button', { type: 'button', role: 'menuitem' }, 'Add to board');
        add.addEventListener('click', async () => {
            closeMenu();
            try {
                await api.newScreen({
                    name: document.title || location.pathname,
                    path: location.pathname + location.search + location.hash,
                    sizes: ['phone', 'desktop'],
                    steps: stepsSinceLoad(recorder.steps()),
                    x: 0,
                    y: 0,
                });
                say('Added to board', true);
            } catch (x) {
                say(x instanceof Error ? x.message : 'Couldn’t save. Try again.', true);
            }
        });
        menu.append(add);
        ui.append(menu);
        modeBtn?.setAttribute('aria-expanded', 'true');
        placeNear(menu);
        add.focus({ preventScroll: true });
    }

    function buildPill(): void {
        pill = h('div', { class: `pill ${corner}`, role: 'toolbar', 'aria-label': 'Canvas' });
        modeBtn = h('button', {
            type: 'button',
            'aria-label': 'Comment',
            'aria-pressed': 'false',
            'aria-keyshortcuts': 'C',
            'aria-haspopup': 'menu',
            'aria-expanded': 'false',
        });
        modeBtn.innerHTML = ICON_COMMENT;
        count = h('span', { hidden: '' });
        const board = h('a', { href: `${base}/`, 'aria-label': 'Board' });
        board.innerHTML = ICON_BOARD;
        pill.append(modeBtn, count, board);
        ui.append(pill);

        let suppressClick = false;
        let drag: { id: number; x: number; y: number; dx: number; dy: number; moved: boolean } | null = null;
        let longPress: ReturnType<typeof setTimeout> | null = null;
        const stopLongPress = () => {
            if (longPress) clearTimeout(longPress);
            longPress = null;
        };

        pill.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !pill) return;
            const r = pill.getBoundingClientRect();
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
            pill.setPointerCapture?.(e.pointerId);
            if (modeBtn && e.composedPath().includes(modeBtn)) {
                longPress = setTimeout(() => {
                    longPress = null;
                    if (drag && !drag.moved) {
                        suppressClick = true;
                        drag = null;
                        openMenu();
                    }
                }, LONG_PRESS_MS);
            }
        });
        pill.addEventListener('pointermove', (e) => {
            if (!drag || drag.id !== e.pointerId || !pill) return;
            if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= DRAG_PX) return;
            if (!drag.moved) {
                drag.moved = true;
                stopLongPress();
                closeMenu(false);
                pill.classList.remove(corner);
                pill.classList.add('dragging');
            }
            pill.style.left = `${e.clientX - drag.dx}px`;
            pill.style.top = `${e.clientY - drag.dy}px`;
        });
        const endDrag = (e: PointerEvent) => {
            stopLongPress();
            const d = drag;
            drag = null;
            if (!d || d.id !== e.pointerId || !d.moved || !pill) return;
            suppressClick = true;
            const r = pill.getBoundingClientRect();
            const vw = document.documentElement.clientWidth || window.innerWidth;
            setCorner(nearestCorner(r.left + r.width / 2, r.top + r.height / 2, vw, window.innerHeight));
            saveCorner(corner);
        };
        pill.addEventListener('pointerup', endDrag);
        pill.addEventListener('pointercancel', endDrag);
        pill.addEventListener(
            'click',
            (e) => {
                if (!suppressClick) return;
                suppressClick = false;
                e.preventDefault();
                e.stopPropagation();
            },
            true,
        );
        modeBtn.addEventListener('click', () => setMode(!mode));
        modeBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            stopLongPress();
            openMenu();
        });
    }

    function setCorner(c: Corner): void {
        if (!pill) return;
        pill.classList.remove('dragging', 'bottom-right', 'bottom-left', 'top-right', 'top-left');
        pill.style.left = '';
        pill.style.top = '';
        corner = c;
        pill.classList.add(c);
    }

    // ---- keys ----
    window.addEventListener(
        'keydown',
        (e) => {
            const target = (e.composedPath()[0] ?? e.target) as Element | null;
            if (e.key === 'Escape') {
                let handled = true;
                if (menu) closeMenu();
                else if (draft) closeDraft();
                else if (openId) closeThread(true);
                else if (mode) setMode(false);
                else handled = false;
                if (handled) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                return;
            }
            if (framed || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'c' && e.key !== 'C')) return;
            if (target instanceof Element && (isTextField(target) || target instanceof HTMLSelectElement)) return;
            e.preventDefault();
            e.stopPropagation();
            setMode(!mode);
        },
        true,
    );
    document.addEventListener(
        'pointerdown',
        (e) => {
            if (menu && !e.composedPath().includes(menu) && !(modeBtn && e.composedPath().includes(modeBtn))) closeMenu(false);
        },
        true,
    );

    // ---- live updates ----
    function connectLive(): void {
        let delay = 1000;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const open = () => {
            let ws: WebSocket;
            try {
                ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${base}/live`);
            } catch (_e) {
                return;
            }
            ws.addEventListener('open', () => (delay = 1000));
            ws.addEventListener('message', (event) => {
                let data: unknown;
                try {
                    data = JSON.parse(String(event.data));
                } catch (_e) {
                    return;
                }
                if (data && typeof data === 'object' && (data as { type?: unknown }).type === 'thread') {
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => void refresh(), 150);
                }
            });
            ws.addEventListener('close', () => {
                setTimeout(open, delay);
                delay = Math.min(delay * 2, 30000);
            });
        };
        open();
    }

    // ---- start ----
    (document.body ?? document.documentElement).append(host);
    if (framed) {
        link = connectBoard({
            replay: (steps) => replay(steps),
            mode: setMode,
            pins: (list) => {
                threads = list;
                renderPins();
                if (openId) renderThread();
            },
        });
    } else {
        buildPill();
        void refresh();
        connectLive();
    }

    return {
        steps: () => recorder.steps(),
        capture: (el: Element) => assemble({ el }, build, recorder),
        mode: setMode,
    };
}
