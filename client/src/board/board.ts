// The board: the app's screens, live, in same-origin frames on an infinite canvas, each at each of its sizes, with
// their comment pins. Pan (drag empty space, two fingers, the wheel), zoom (ctrl-wheel, pinch), Fit. Drag a screen to
// move it. Comment mode hands picking to the overlay in each frame (BoardMessage `mode`); its `picked` opens the
// comment box here. Lifted from Whipsheet's review canvas (workers/canvas/app/app.js), without its boards and publish.
import type { BoardMessage, Capture, OverlayMessage, Screen, Size, Thread } from '../../../shared/contract.ts';
import { SIZES } from '../../../shared/contract.ts';
import { ApiError, post } from './api.ts';
import { bounds, type Box, type Cam, center, clamp, fitBox, FIT_PAD, fromCenter, MAX_Z, MIN_Z, panBy, toScreen, wheelFactor, zoomAt } from './camera.ts';
import { byId, closeOnBackdrop, confirmDialog, h, isTyping } from './dom.ts';
import { type FrameBox, framesOf, nextSpot, pinIn, screenBox, storedRect, threadOnScreen } from './layout.ts';
import { emit, on, select, store, threadById, upsert } from './store.ts';

interface FrameView {
    box: FrameBox;
    el: HTMLDivElement;
    iframe: HTMLIFrameElement;
    label: HTMLDivElement;
    fail: HTMLSpanElement;
    ready: boolean;
    loaded: boolean;
    src: string;
    steps: string;
    /** where each thread's pin is, in the frame's own pixels */
    pins: Map<string, { x: number; y: number }>;
}

interface Draft {
    frame: string;
    capture: Capture;
    box: Box | null; // what was picked, in the frame's pixels
    form: HTMLFormElement;
    outline: HTMLDivElement;
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const phone = matchMedia('(max-width: 767px)');

let viewport: HTMLElement;
let world: HTMLElement;
let labels: HTMLElement;
let pinLayer: HTMLElement;
let float: HTMLElement;
let zoomLevel: HTMLElement;
let commentBtn: HTMLButtonElement;

let cam: Cam = { x: 0, y: 0, z: 1 };
let vw = 0, vh = 0, vx = 0, vy = 0;
const frames = new Map<string, FrameView>();
const pinEls = new Map<string, HTMLButtonElement>(); // frame key + ' ' + thread id
let commenting = false;
let active: string | null = null; // the frame that takes the pointer
let draft: Draft | null = null;
let raf = 0;
let anim = 0;
let fitted = false;
let wantFocus: string | null = null; // a thread to bring into view once its frame has drawn its pin
let projectFound: ((name: string) => void) | null = null;

export function initBoard(opts: { onProject: (name: string) => void }): void {
    projectFound = opts.onProject;
    viewport = byId('viewport');
    world = byId('world');
    labels = byId('labels');
    pinLayer = byId('pins');
    float = byId('float');
    zoomLevel = byId('zoom-level');
    commentBtn = byId<HTMLButtonElement>('comment');
    measure();
    new ResizeObserver(onResize).observe(viewport);
    wireInput();
    wireAddScreen();
    commentBtn.addEventListener('click', () => setCommenting(!commenting));
    addEventListener('message', onMessage);
    on('screens', syncFrames);
    on('threads', () => {
        syncPins();
        for (const f of frames.values()) sendPins(f);
    });
    on('selected', () => {
        drawPins();
        if (store.selected) focusThread(store.selected);
    });
    // the frames' pages change under us (they're live apps): follow their elements
    setInterval(() => document.visibilityState === 'visible' && syncPins(), 1500);
    phone.addEventListener('change', changed);
}

// ---- the camera ----

function measure() {
    const r = viewport.getBoundingClientRect();
    vw = r.width;
    vh = r.height;
    vx = r.left;
    vy = r.top;
}

function onResize() {
    const c = center(cam, vw, vh);
    const was = { vw, vh };
    measure();
    if (anim || (was.vw === vw && was.vh === vh) || !was.vw) return changed();
    setCam(fromCenter({ ...c, z: cam.z }, vw, vh));
}

function setCam(c: Cam, fromAnim = false) {
    if (!fromAnim) stopAnim();
    cam = { x: c.x, y: c.y, z: clamp(c.z, MIN_Z, MAX_Z) };
    changed();
}

function changed() {
    if (!raf) raf = requestAnimationFrame(draw);
}

function stopAnim() {
    if (anim) cancelAnimationFrame(anim);
    anim = 0;
}

function animateTo(target: Cam, ms = 300) {
    stopAnim();
    if (reduceMotion.matches) return setCam(target);
    const from = { ...cam };
    const cf = center(from, vw, vh);
    const ct = center(target, vw, vh);
    const t0 = performance.now();
    const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        const z = Math.exp(Math.log(from.z) + (Math.log(target.z) - Math.log(from.z)) * e);
        setCam(fromCenter({ x: cf.x + (ct.x - cf.x) * e, y: cf.y + (ct.y - cf.y) * e, z }, vw, vh), true);
        anim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
}

function zoomStep(dir: 1 | -1) {
    animateTo(fromCenter({ ...center(cam, vw, vh), z: clamp(cam.z * (dir > 0 ? 1.25 : 0.8), MIN_Z, MAX_Z) }, vw, vh), 160);
}

export function fit(animate = true): void {
    const b = bounds(store.screens.map(screenBox));
    if (!b) return;
    const target = fitBox(b, vw, vh, 1);
    if (animate) animateTo(target);
    else setCam(target);
}

/** Bring a thread's pin to the middle, with its frame big enough to read. */
export function focusThread(id: string): void {
    const t = threadById(id);
    if (!t) return;
    const hit = pinFor(t);
    if (!hit) {
        wantFocus = id;
        return;
    }
    wantFocus = null;
    const { f, p } = hit;
    const fitZ = Math.min((vw - 2 * FIT_PAD) / f.box.w, (vh - 2 * FIT_PAD) / f.box.h);
    const z = clamp(Math.max(cam.z, Math.min(1, Math.max(fitZ, 0.5))), MIN_Z, MAX_Z);
    // on a phone the thread opens in the sheet over the lower 70%: the pin goes in the middle of what's left above it
    const dy = phone.matches ? (vh * 0.35) / z : 0;
    animateTo(fromCenter({ x: f.box.x + p.x, y: f.box.y + p.y + dy, z }, vw, vh));
}

/** The frame showing a thread's pin: the one at the width it was written at, else the first. */
function pinFor(t: Thread): { f: FrameView; p: { x: number; y: number } } | null {
    let best: { f: FrameView; p: { x: number; y: number } } | null = null;
    const vwOf = Number(/^(\d+)/.exec(t.viewport || '')?.[1]) || 0;
    for (const f of frames.values()) {
        const p = f.pins.get(t.id);
        if (!p) continue;
        if (!best || Math.abs(f.box.w - vwOf) < Math.abs(best.f.box.w - vwOf)) best = { f, p };
    }
    return best;
}

// ---- drawing ----

function draw() {
    raf = 0;
    const { x, y, z } = cam;
    world.style.transform = `translate(${-x * z}px, ${-y * z}px) scale(${z})`;
    zoomLevel.textContent = Math.round(z * 100) + '%';
    for (const f of frames.values()) {
        const s = toScreen(cam, f.box.x, f.box.y);
        const sw = f.box.w * z;
        const show = sw >= 48 && s.x < vw && s.x + sw > 0 && s.y - 28 < vh && s.y + f.box.h * z > 0;
        f.label.hidden = !show;
        if (show) {
            f.label.style.transform = `translate(${s.x}px, ${s.y}px) translateY(-100%)`;
            f.label.style.maxWidth = Math.max(sw, 48) + 'px';
        }
    }
    drawPins();
    if (draft) placeDraft(draft);
}

function drawPins() {
    const open = store.threads.filter((t) => t.status === 'open');
    for (const [key, el] of pinEls) {
        const [fk, id] = key.split(' ');
        const f = frames.get(fk);
        const p = f?.pins.get(id);
        const t = threadById(id);
        const shown = !!(f && p && t && (t.status === 'open' || t.id === store.selected));
        el.hidden = !shown;
        if (!shown) continue;
        const s = toScreen(cam, f.box.x + p.x, f.box.y + p.y);
        el.style.transform = `translate(${s.x}px, ${s.y}px)`;
        const n = open.indexOf(t);
        el.textContent = n >= 0 ? String(n + 1) : '';
        el.classList.toggle('selected', t.id === store.selected);
        el.classList.toggle('resolved', t.status === 'resolved');
    }
}

// ---- screens and their frames ----

function syncFrames() {
    const want = new Map<string, FrameBox>();
    for (const s of store.screens) for (const b of framesOf(s)) want.set(b.key, b);
    for (const [k, f] of frames) {
        if (want.has(k)) continue;
        f.el.remove();
        f.label.remove();
        frames.delete(k);
        if (active === k) active = null;
        if (draft?.frame === k) cancelDraft();
    }
    store.screens.forEach((s) => {
        framesOf(s).forEach((b, i) => {
            const f = frames.get(b.key) || addFrame(b);
            f.box = b;
            f.el.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
            fillLabel(f, i === 0);
            const steps = JSON.stringify(s.steps || []);
            const src = new URL(s.path, location.origin).toString();
            if (f.src !== src || f.steps !== steps) {
                f.src = src;
                f.steps = steps;
                f.ready = false;
                f.loaded = false;
                f.fail.hidden = true;
                f.pins.clear();
                f.iframe.src = src;
            }
        });
    });
    syncPins();
    if (!fitted && store.screens.length && vw) {
        fitted = true;
        if (!store.selected) fit(false);
    }
    changed();
}

function addFrame(b: FrameBox): FrameView {
    const iframe = h('iframe', { title: b.screen.name + ', ' + b.size });
    const el = h('div', { class: 'frame', 'data-key': b.key }, iframe);
    world.append(el);
    const fail = h('span', { class: 'fail', role: 'status' });
    fail.hidden = true;
    const label = h('div', { class: 'label', 'data-key': b.key });
    labels.append(label);
    const f: FrameView = { box: b, el, iframe, label, fail, ready: false, loaded: false, src: '', steps: '', pins: new Map() };
    frames.set(b.key, f);
    iframe.addEventListener('load', () => hookFrame(f));
    return f;
}

function fillLabel(f: FrameView, first: boolean) {
    const s = f.box.screen;
    const kids: Node[] = [h('b', { text: s.name }), h('span', { class: 'path', text: ' ' + s.path + ' · ' + f.box.size }), f.fail];
    if (first) {
        kids.push(
            h('button', {
                type: 'button',
                class: 'more',
                'aria-label': 'Screen options: ' + s.name,
                'aria-haspopup': 'menu',
                'aria-expanded': 'false',
                text: '⋯',
                onclick: (ev: Event) => screenMenu(s, ev.currentTarget as HTMLButtonElement),
            }),
        );
    }
    f.label.replaceChildren(...kids);
}

function screenMenu(s: Screen, btn: HTMLButtonElement) {
    const wasOpen = btn.getAttribute('aria-expanded') === 'true';
    closeMenus();
    if (wasOpen) return;
    const menu = h(
        'div',
        { class: 'menu', role: 'menu' },
        h('button', {
            type: 'button',
            role: 'menuitem',
            class: 'menu-item danger',
            text: 'Delete screen',
            onclick: async () => {
                closeMenus();
                if (!(await confirmDialog('Delete the screen “' + s.name + '”?'))) return;
                try {
                    await post('screens/' + encodeURIComponent(s.id) + '/delete');
                    store.screens = store.screens.filter((x) => x.id !== s.id);
                    emit('screens');
                } catch (e) {
                    alertError(e);
                }
            },
        }),
    );
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const vr = viewport.getBoundingClientRect();
    menu.style.transform = `translate(${r.right - vr.left - 160}px, ${r.bottom - vr.top + 4}px)`;
    float.append(menu);
    (menu.querySelector('button') as HTMLButtonElement).focus();
}

export function closeMenus(): void {
    for (const m of document.querySelectorAll('#float .menu')) m.remove();
    for (const b of document.querySelectorAll('.label .more[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
}

function alertError(e: unknown) {
    const msg = e instanceof Error ? e.message : 'Something went wrong.';
    const toast = byId('toast');
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => (toast.hidden = true), 4000);
}

/** Same-origin frames: ctrl-wheel and Esc inside one still reach the board; its scrolling moves its pins. */
function hookFrame(f: FrameView) {
    f.loaded = true;
    syncPinsSoon();
    let win: Window | null;
    try {
        win = f.iframe.contentWindow;
        if (!win?.document) return;
    } catch {
        return;
    }
    const w = win as Window & { __CANVAS_BUILD__?: { project?: string } };
    if (w.__CANVAS_BUILD__?.project && projectFound) {
        projectFound(w.__CANVAS_BUILD__.project);
        projectFound = null;
    }
    w.addEventListener(
        'wheel',
        (ev) => {
            if (!ev.ctrlKey && !ev.metaKey) return;
            ev.preventDefault();
            const s = toScreen(cam, f.box.x, f.box.y);
            setCam(zoomAt(cam, s.x + ev.clientX * cam.z, s.y + ev.clientY * cam.z, wheelFactor(ev.deltaY)));
        },
        { passive: false },
    );
    w.addEventListener('keydown', (ev) => ev.key === 'Escape' && escape(), { capture: true });
    w.addEventListener('scroll', () => syncPinsSoon(), { passive: true, capture: true });
    w.addEventListener('resize', () => syncPinsSoon());
}

let pinTimer = 0;
function syncPinsSoon() {
    if (!pinTimer) pinTimer = requestAnimationFrame(() => ((pinTimer = 0), syncPins()));
}

// ---- pins: where each page's threads are in each frame ----

function frameDoc(f: FrameView): Document | null {
    try {
        return f.iframe.contentDocument;
    } catch {
        return null;
    }
}

function syncPins() {
    const seen = new Set<string>();
    for (const [fk, f] of frames) {
        f.pins.clear();
        // until its page has loaded, a frame's pins would sit where nothing is yet
        if (!f.loaded) continue;
        const doc = frameDoc(f);
        const win = f.iframe.contentWindow;
        for (const t of store.threads) {
            if (!threadOnScreen(t, f.box.screen)) continue;
            let r: Box | null = null;
            if (doc && t.selector) {
                try {
                    const el = doc.querySelector(t.selector);
                    if (el) {
                        const b = el.getBoundingClientRect();
                        r = { x: b.left, y: b.top, w: b.width, h: b.height };
                    }
                } catch {
                    /* a selector the page no longer takes */
                }
            }
            if (!r) {
                const st = storedRect(t, f.box.w);
                if (st) r = { ...st, x: st.x - (win?.scrollX || 0), y: st.y - (win?.scrollY || 0) };
            }
            if (!r || r.y + r.h < 0 || r.y > f.box.h || r.x + r.w < 0 || r.x > f.box.w) continue;
            f.pins.set(t.id, pinIn(r, f.box));
            const key = fk + ' ' + t.id;
            seen.add(key);
            if (!pinEls.has(key)) {
                const el = h('button', { type: 'button', class: 'pin', 'data-thread': t.id });
                el.addEventListener('click', () => select(store.selected === t.id ? null : t.id));
                pinEls.set(key, el);
                pinLayer.append(el);
            }
            const words = t.words || t.component || '';
            pinEls.get(key)!.setAttribute('aria-label', 'Comment' + (words ? ' on ' + words : '') + ', ' + f.box.screen.name + ' ' + f.box.size);
        }
    }
    for (const [key, el] of pinEls) {
        if (seen.has(key)) continue;
        el.remove();
        pinEls.delete(key);
    }
    if (wantFocus) {
        const t = threadById(wantFocus);
        if (t && pinFor(t)) focusThread(wantFocus);
    }
    changed();
}

// ---- talking to the overlay in each frame ----

function send(f: FrameView, msg: BoardMessage) {
    if (!f.ready) return;
    f.iframe.contentWindow?.postMessage(msg, location.origin);
}

function sendPins(f: FrameView) {
    send(f, { canvas: 1, type: 'pins', threads: store.threads.filter((t) => t.status === 'open' && threadOnScreen(t, f.box.screen)) });
}

function onMessage(ev: MessageEvent) {
    if (ev.origin !== location.origin) return;
    const d = ev.data as OverlayMessage | null;
    if (!d || typeof d !== 'object' || d.canvas !== 1) return;
    const f = [...frames.values()].find((x) => x.iframe.contentWindow === ev.source);
    if (!f) return;
    if (d.type === 'ready') {
        f.ready = true;
        f.fail.hidden = true;
        const steps = f.box.screen.steps || [];
        if (steps.length) send(f, { canvas: 1, type: 'replay', steps });
        send(f, { canvas: 1, type: 'mode', comment: commenting });
        sendPins(f);
        syncPinsSoon();
    } else if (d.type === 'replayed') {
        f.fail.hidden = d.ok;
        if (!d.ok) {
            const at = typeof d.failedAt === 'number' ? d.failedAt + 1 : null;
            f.fail.textContent = at ? 'Step ' + at + ' failed' : 'Steps failed';
        }
        syncPinsSoon();
    } else if (d.type === 'picked') {
        openDraft(f, d.capture);
    }
}

export function setCommenting(on: boolean): void {
    commenting = on;
    commentBtn.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('commenting', on);
    for (const f of frames.values()) send(f, { canvas: 1, type: 'mode', comment: on });
}

export const isCommenting = (): boolean => commenting;

// ---- the comment box, over the frame at what was picked ----

function openDraft(f: FrameView, capture: Capture) {
    cancelDraft();
    select(null);
    const win = f.iframe.contentWindow;
    const sx = win?.scrollX || 0, sy = win?.scrollY || 0;
    const r = capture.element?.rect || capture.area || (capture.point ? { x: capture.point.x, y: capture.point.y, w: 0, h: 0 } : null);
    const box = r ? { x: r.x - sx, y: r.y - sy, w: r.w, h: r.h } : null;
    const ta = h('textarea', { class: 'field', rows: 3, 'aria-label': 'Comment', placeholder: 'Add a comment' });
    const err = h('p', { class: 'err', role: 'alert' });
    const postBtn = h('button', { type: 'submit', class: 'btn primary', text: 'Post' });
    const about = capture.element?.component || capture.element?.words || '';
    const form = h(
        'form',
        { class: 'composer', 'aria-label': 'New comment' },
        about ? h('div', { class: 'about', text: about }) : null,
        ta,
        err,
        h('div', { class: 'row-end' }, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => cancelDraft() }), postBtn),
    );
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            form.requestSubmit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancelDraft();
        }
    });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (!body || postBtn.disabled) return;
        postBtn.disabled = true;
        err.textContent = '';
        try {
            const { thread } = await post<{ thread: Thread }>('threads', { body, capture });
            cancelDraft();
            upsert(thread);
            select(thread.id);
        } catch (x) {
            err.textContent = x instanceof ApiError ? x.message : 'Couldn’t post. Try again.';
            postBtn.disabled = false;
        }
    });
    const outline = h('div', { class: 'pick' });
    pinLayer.append(outline);
    float.append(form);
    draft = { frame: f.box.key, capture, box, form, outline };
    placeDraft(draft);
    ta.focus({ preventScroll: true });
}

function placeDraft(d: Draft) {
    const f = frames.get(d.frame);
    if (!f) return;
    const b = d.box || { x: f.box.w / 2, y: 40, w: 0, h: 0 };
    const s = toScreen(cam, f.box.x + b.x, f.box.y + b.y);
    const at = { left: s.x, top: s.y, width: b.w * cam.z, height: b.h * cam.z };
    d.outline.hidden = !d.box;
    d.outline.style.transform = `translate(${at.left}px, ${at.top}px)`;
    d.outline.style.width = at.width + 'px';
    d.outline.style.height = at.height + 'px';
    if (phone.matches) {
        d.form.style.transform = '';
        return;
    }
    const fw = d.form.offsetWidth || 300;
    const fh = d.form.offsetHeight || 150;
    const below = at.top + at.height + 10;
    const above = at.top - 10 - fh;
    const y = below + fh <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - fh - 8);
    const x = clamp(at.left, 8, Math.max(8, vw - fw - 8));
    d.form.style.transform = `translate(${x}px, ${y}px)`;
}

function cancelDraft() {
    if (!draft) return;
    draft.form.remove();
    draft.outline.remove();
    draft = null;
}

/** Esc puts away one thing at a time: the comment being written, the open thread, comment mode, the frame in use. */
export function escape(): boolean {
    if (document.querySelector('#float .menu')) closeMenus();
    else if (draft) cancelDraft();
    else if (store.selected) select(null);
    else if (commenting) setCommenting(false);
    else if (active) setActive(null);
    else return false;
    return true;
}

// ---- input ----

function setActive(key: string | null) {
    if (active === key) return;
    if (active) frames.get(active)?.el.classList.remove('active');
    active = key && frames.has(key) ? key : null;
    if (active) frames.get(active)!.el.classList.add('active');
}

function wireInput() {
    viewport.addEventListener('scroll', () => viewport.scrollTo(0, 0));
    viewport.addEventListener(
        'wheel',
        (ev) => {
            if ((ev.target as Element).closest('.composer, .menu, .zoom')) return;
            ev.preventDefault();
            const k = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? vh : 1;
            if (ev.ctrlKey || ev.metaKey) {
                setCam(zoomAt(cam, ev.clientX - vx, ev.clientY - vy, wheelFactor(ev.deltaY * k)));
            } else {
                let dx = ev.deltaX * k, dy = ev.deltaY * k;
                if (ev.shiftKey && !dx) [dx, dy] = [dy, 0];
                setCam(panBy(cam, dx, dy));
            }
        },
        { passive: false },
    );
    // Safari's trackpad pinch
    let g = 0;
    viewport.addEventListener('gesturestart', (ev) => {
        ev.preventDefault();
        g = cam.z;
    });
    viewport.addEventListener('gesturechange', (ev) => {
        ev.preventDefault();
        const e = ev as Event & { scale: number; clientX: number; clientY: number };
        if (g) setCam(zoomAt(cam, e.clientX - vx, e.clientY - vy, (g * e.scale) / cam.z));
    });
    for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });

    // one finger or the mouse: pan from empty space, move a screen from its frame or label; two fingers: pinch
    const ptrs = new Map<number, { x: number; y: number }>();
    type Drag = { x0: number; y0: number; x: number; y: number; moved: boolean; key: string | null; pinch?: { x: number; y: number; d: number } };
    let drag: Drag | null = null;
    let moving: { screen: Screen; x: number; y: number } | null = null;
    const pinchOf = () => {
        const [a, b] = [...ptrs.values()];
        return { x: (a.x + b.x) / 2 - vx, y: (a.y + b.y) / 2 - vy, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    };
    viewport.addEventListener('pointerdown', (ev) => {
        const t = ev.target as Element;
        if (t.closest('button, textarea, input, select, form, .menu, .zoom')) return;
        if (ev.button !== 0 && ev.button !== 1) return;
        closeMenus();
        ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (ptrs.size === 1) {
            const key = (t.closest('.frame, .label') as HTMLElement | null)?.dataset.key || null;
            drag = { x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, moved: false, key };
        } else if (ptrs.size === 2) {
            moving = null;
            drag = { x0: 0, y0: 0, x: 0, y: 0, moved: true, key: null, pinch: pinchOf() };
            for (const id of ptrs.keys()) viewport.setPointerCapture(id);
        }
    });
    viewport.addEventListener('pointermove', (ev) => {
        if (!drag || !ptrs.has(ev.pointerId)) return;
        ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (drag.pinch) {
            if (ptrs.size < 2) return;
            const p = pinchOf();
            setCam(panBy(zoomAt(cam, p.x, p.y, p.d / drag.pinch.d), drag.pinch.x - p.x, drag.pinch.y - p.y));
            drag.pinch = p;
            return;
        }
        if (!drag.moved) {
            if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 4) return;
            drag.moved = true;
            viewport.setPointerCapture(ev.pointerId);
            viewport.classList.add('dragging');
            const f = drag.key ? frames.get(drag.key) : null;
            if (f) moving = { screen: f.box.screen, x: f.box.screen.x, y: f.box.screen.y };
        }
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        if (moving) {
            moving.screen.x += dx / cam.z;
            moving.screen.y += dy / cam.z;
            syncFrames();
        } else setCam(panBy(cam, -dx, -dy));
    });
    const end = (ev: PointerEvent) => {
        if (!ptrs.delete(ev.pointerId)) return;
        if (ptrs.size === 1 && drag?.pinch) {
            const [p] = [...ptrs.values()];
            drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, moved: true, key: null };
            return;
        }
        if (ptrs.size) return;
        viewport.classList.remove('dragging');
        if (moving) {
            const m = moving;
            moving = null;
            m.screen.x = Math.round(m.screen.x);
            m.screen.y = Math.round(m.screen.y);
            if (m.screen.x !== m.x || m.screen.y !== m.y) {
                post<{ screen: Screen }>('screens/' + encodeURIComponent(m.screen.id) + '/edit', { x: m.screen.x, y: m.screen.y }).catch((e) => {
                    m.screen.x = m.x;
                    m.screen.y = m.y;
                    syncFrames();
                    alertError(e);
                });
            }
            syncFrames();
        } else if (drag && !drag.moved && ev.type === 'pointerup') {
            // a click on a frame lets it take the pointer; a click on empty space takes it back
            const onFrame = (ev.target as Element).closest('.frame') as HTMLElement | null;
            setActive(onFrame?.dataset.key || null);
        }
        drag = null;
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    viewport.addEventListener('dblclick', (ev) => {
        const el = (ev.target as Element).closest('.label') as HTMLElement | null;
        const f = el?.dataset.key ? frames.get(el.dataset.key) : null;
        if (f) animateTo(fitBox({ x: f.box.x, y: f.box.y - 28, w: f.box.w, h: f.box.h + 28 }, vw, vh, 2));
    });

    byId('zoom-in').addEventListener('click', () => zoomStep(1));
    byId('zoom-out').addEventListener('click', () => zoomStep(-1));
    byId('zoom-fit').addEventListener('click', () => fit());
    zoomLevel.addEventListener('click', () => animateTo(fromCenter({ ...center(cam, vw, vh), z: 1 }, vw, vh), 200));

    document.addEventListener('pointerdown', (ev) => {
        if (!(ev.target as Element).closest?.('.menu, .more')) closeMenus();
    });
}

/** Keys while the board tab shows. */
export function boardKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
        if (escape()) ev.preventDefault();
        return;
    }
    if (isTyping(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'c' || ev.key === 'C') {
        ev.preventDefault();
        setCommenting(!commenting);
    } else if (ev.key === '!' || (ev.code === 'Digit1' && ev.shiftKey)) fit();
    else if (ev.key === '=' || ev.key === '+') zoomStep(1);
    else if (ev.key === '-') zoomStep(-1);
}

// ---- adding a screen ----

function wireAddScreen() {
    const dlg = byId<HTMLDialogElement>('add-screen');
    const form = dlg.querySelector('form') as HTMLFormElement;
    const err = byId('add-err');
    closeOnBackdrop(dlg);
    byId('add-open').addEventListener('click', () => {
        form.reset();
        err.textContent = '';
        dlg.showModal();
        (form.elements.namedItem('name') as HTMLInputElement).focus();
    });
    byId('add-cancel').addEventListener('click', () => dlg.close());
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const data = new FormData(form);
        const name = String(data.get('name') || '').trim();
        let path = String(data.get('path') || '').trim();
        const sizes = (data.getAll('size') as string[]).filter((s): s is Size => s in SIZES);
        if (!path.startsWith('/')) path = '/' + path;
        if (!name) return void (err.textContent = 'Give it a name.');
        if (!sizes.length) return void (err.textContent = 'Pick at least one size.');
        const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
        submit.disabled = true;
        try {
            const spot = nextSpot(store.screens);
            const { screen } = await post<{ screen: Screen }>('screens', { name, path, sizes, steps: [], x: spot.x, y: spot.y });
            store.screens = [...store.screens.filter((s) => s.id !== screen.id), screen];
            emit('screens');
            dlg.close();
            const b = screenBox(screen);
            animateTo(fitBox(b, vw, vh, 1));
        } catch (e) {
            err.textContent = e instanceof Error ? e.message : 'Couldn’t add it.';
        } finally {
            submit.disabled = false;
        }
    });
}
