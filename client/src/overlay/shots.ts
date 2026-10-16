// Screenshots in the browser, for a capture's `shots` (CONTRACT.md, "A capture"): the element picked and the visible
// screen, as WebP (PNG where the browser can't encode WebP), uploaded to the canvas before the thread that uses them.
//
// Elements marked `data-canvas-private` render as a solid block: nothing inside them is cloned, so their text and
// images never reach the image. Password and payment fields render empty. The canvas's own UI (`[data-canvas-ui]`)
// is left out.
import { domToCanvas, type Options } from 'modern-screenshot';
import { DEFAULT_BASE, MAX_UPLOAD_BYTES } from '../../../shared/contract.ts';
import { isPrivate, PRIVATE_ATTR } from './private.ts';

export const UI_SELECTOR = '[data-canvas-ui]';
/** What a private element shows as. */
export const PRIVATE_FILL = '#9ca3af';
export const MAX_DPR = 2;
export const MAX_SIDE = 2000;
const WEBP_QUALITY = 0.9;

/** The pixel ratio to draw at: the screen's, at most 2, and small enough that the longest side is at most 2000px. */
export function scaleFor(w: number, h: number, dpr = globalThis.devicePixelRatio || 1): number {
    const longest = Math.max(w, h, 1);
    return Math.min(dpr, MAX_DPR, MAX_SIDE / longest);
}

/** Fields whose value never shows: the same list the recorder masks. */
export function isSecretField(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const auto = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    return (
        type === 'password' ||
        type === 'hidden' ||
        /(^|\s)cc-/.test(auto) ||
        /(^|\s)(new|current)-password/.test(auto)
    );
}

function inUi(el: Element): boolean {
    return el.closest(UI_SELECTOR) !== null;
}

function parentOf(node: Node): Element | null {
    if (node.parentElement) return node.parentElement;
    const root = node.parentNode;
    return root && 'host' in root ? (root as ShadowRoot).host : null;
}

/**
 * The hooks that mask a shot. `filter` sees each original node just before it is cloned (and never again for anything
 * inside a node it refused); `onCloneEachNode` sees each clone once its children are in. Private elements are kept
 * as an empty box of their own size; everything inside them is refused.
 */
export function maskHooks(): Pick<Options, 'filter' | 'onCloneEachNode'> {
    // The box of each private element accepted, waiting for its clone. Nothing inside a private element is
    // accepted, so the next private clone to finish is always the last one recorded.
    const pending: Box[] = [];
    return {
        filter(node: Node): boolean {
            const parent = parentOf(node);
            if (parent && isPrivate(parent)) return false;
            if (node.nodeType !== 1) return true;
            const el = node as Element;
            if (inUi(el)) return false;
            if (el.hasAttribute(PRIVATE_ATTR)) {
                const r = el.getBoundingClientRect();
                pending.push({ w: r.width, h: r.height, display: getComputedStyle(el).display });
            }
            return true;
        },
        onCloneEachNode(cloned: Node): void {
            if (cloned.nodeType !== 1) return;
            const el = cloned as HTMLElement;
            if (el.hasAttribute(PRIVATE_ATTR)) {
                blank(el, pending.pop() ?? { w: 0, h: 0, display: 'block' });
            } else if (isSecretField(el)) {
                el.removeAttribute('value');
                if ('value' in el) (el as HTMLInputElement).value = '';
                el.textContent = '';
            }
        },
    };
}

const DROP_ATTRS = ['src', 'srcset', 'value', 'placeholder', 'poster', 'href', 'xlink:href', 'title', 'alt', 'class'];

interface Box {
    w: number;
    h: number;
    display: string;
}

/** Turn a clone into a solid block the size of the original, with nothing of the original's content. */
function blank(el: Element, { w, h, display }: Box): void {
    el.replaceChildren();
    for (const name of DROP_ATTRS) el.removeAttribute(name);
    const s = (el as HTMLElement).style;
    if (!s) return;
    const shown = !display || display === 'inline' || display === 'contents' ? 'inline-block' : display;
    for (const [name, value] of [
        ['display', shown],
        ['width', `${w}px`],
        ['height', `${h}px`],
        ['min-width', '0'],
        ['min-height', '0'],
        ['box-sizing', 'border-box'],
        ['overflow', 'hidden'],
        ['background', PRIVATE_FILL],
        ['color', 'transparent'],
        ['fill', PRIVATE_FILL],
        ['text-shadow', 'none'],
        ['filter', 'none'],
        ['opacity', '1'],
        ['vertical-align', 'top'],
    ]) {
        s.setProperty(name, value, 'important');
    }
}

function solid(w: number, h: number, scale: number, fill: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas: could not encode the screenshot'))), type, quality);
    });
}

/**
 * WebP, or PNG where the browser can't encode WebP (`toBlob` falls back to PNG on its own). Halves the image until it
 * fits the upload limit.
 */
export async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
    let current = canvas;
    for (let i = 0; ; i++) {
        const blob = await toBlob(current, 'image/webp', WEBP_QUALITY);
        if (blob.size <= MAX_UPLOAD_BYTES || i >= 4) return blob;
        const half = document.createElement('canvas');
        half.width = Math.max(1, Math.floor(current.width / 2));
        half.height = Math.max(1, Math.floor(current.height / 2));
        half.getContext('2d')?.drawImage(current, 0, 0, half.width, half.height);
        current = half;
    }
}

function pageBackground(): string {
    for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return '#ffffff';
}

/** A screenshot of one element, at its own size. */
export async function shootElement(el: Element): Promise<Blob> {
    const r = el.getBoundingClientRect();
    const scale = scaleFor(r.width, r.height);
    if (isPrivate(el)) return encode(solid(r.width, r.height, scale, PRIVATE_FILL));
    const canvas = await domToCanvas(el, { scale, ...maskHooks() });
    return encode(canvas);
}

/** A screenshot of what's on screen: the viewport at its current scroll position. */
export async function shootScreen(): Promise<Blob> {
    const root = document.documentElement;
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const scale = scaleFor(w, h);
    const hooks = maskHooks();
    const page = await domToCanvas(root, {
        scale,
        width: w,
        height: h,
        // Move the page so the visible part sits at the top left; fixed elements move back (below), since the
        // shifted root becomes their containing block.
        style: { transform: `translate(${-sx}px, ${-sy}px)`, transformOrigin: '0 0', overflow: 'visible' },
        filter: hooks.filter,
        onCloneEachNode(cloned) {
            hooks.onCloneEachNode?.(cloned);
            if (cloned.nodeType === 1 && (sx || sy)) {
                const s = (cloned as HTMLElement).style;
                if (s?.position === 'fixed') {
                    const own = s.transform && s.transform !== 'none' ? ` ${s.transform}` : '';
                    s.setProperty('transform', `translate(${sx}px, ${sy}px)${own}`);
                }
            }
        },
    });
    // The shifted root only paints its own box, so lay the shot over the page's background colour.
    const out = document.createElement('canvas');
    out.width = page.width;
    out.height = page.height;
    const ctx = out.getContext('2d');
    if (!ctx) return encode(page);
    ctx.fillStyle = pageBackground();
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(page, 0, 0);
    return encode(out);
}

/** Upload a screenshot (`POST api/uploads`); its id goes in the capture's `shots`. */
export async function upload(blob: Blob, base: string = DEFAULT_BASE): Promise<{ id: string; bytes: number }> {
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`canvas: screenshot is ${blob.size} bytes, over the upload limit`);
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'image/png' },
        body: blob,
        credentials: 'same-origin',
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; bytes?: number; error?: string };
    if (!res.ok || typeof data.id !== 'string') {
        throw new Error(`canvas: upload failed (${res.status}${data.error ? `: ${data.error}` : ''})`);
    }
    return { id: data.id, bytes: typeof data.bytes === 'number' ? data.bytes : blob.size };
}
