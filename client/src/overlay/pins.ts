// Which threads get a pin on this page, and where: matched by the URL's path, then found again by selector, else at
// the box the thread was saved with (page CSS pixels).
import type { Thread } from '../../../shared/contract.ts';

export interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function pathOf(url: string, here: string = location.href): string | null {
    try {
        return new URL(url, here).pathname;
    } catch (_e) {
        return null;
    }
}

/** Open threads made on this page (same path), oldest first so pins keep their order. */
export function openHere(threads: Thread[], here: string = location.href): Thread[] {
    const path = pathOf(here, here);
    return threads
        .filter((t) => t.status === 'open' && pathOf(t.url, here) === path)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** Where a thread's element is now, in viewport pixels; null when it can't be found. */
export function anchorOf(thread: Pick<Thread, 'selector' | 'x' | 'y' | 'w' | 'h'>, doc: Document = document): Box | null {
    if (thread.selector) {
        let el: Element | null = null;
        try {
            el = doc.querySelector(thread.selector);
        } catch (_e) {
            // a selector this page no longer parses
        }
        if (el) {
            const r = el.getBoundingClientRect();
            if (r.width || r.height) return { left: r.left, top: r.top, width: r.width, height: r.height };
        }
    }
    if (thread.x === null || thread.y === null) return null;
    const win = doc.defaultView ?? window;
    return { left: thread.x - win.scrollX, top: thread.y - win.scrollY, width: thread.w ?? 0, height: thread.h ?? 0 };
}

export const PIN = 24;

/** A pin's top-left: its point sits on the box's top-right corner, nudged inside so it stays on the element. */
export function pinAt(box: Box, index: number, vw: number): { x: number; y: number } {
    const x = Math.min(Math.max(box.left + box.width - PIN / 2 - index * (PIN + 4), 4), vw - PIN - 4);
    return { x, y: box.top - PIN + 8 };
}
