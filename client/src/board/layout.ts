// Where a screen's frames sit on the board, which threads belong to which screen, and where a pin goes. Pure.
import { SIZES, type Screen, type Size, type Thread } from '../../../shared/contract.ts';
import type { Box } from './camera.ts';

/** Between a screen's sizes, side by side. */
export const FRAME_GAP = 40;
/** Room above a frame for its label. */
export const LABEL_H = 28;

export interface FrameBox extends Box {
    screen: Screen;
    size: Size;
    key: string;
}

/** A screen's frames, one per size, left to right from the screen's x, y, in the order phone, tablet, desktop. */
export function framesOf(screen: Screen): FrameBox[] {
    const order: Size[] = ['phone', 'tablet', 'desktop'];
    const sizes = order.filter((s) => screen.sizes.includes(s));
    let x = screen.x;
    return sizes.map((size) => {
        const { w, h } = SIZES[size];
        const f = { screen, size, key: screen.id + ':' + size, x, y: screen.y, w, h };
        x += w + FRAME_GAP;
        return f;
    });
}

/** A screen's whole box on the board, its labels included. */
export function screenBox(screen: Screen): Box {
    const fs = framesOf(screen);
    if (!fs.length) return { x: screen.x, y: screen.y - LABEL_H, w: 0, h: LABEL_H };
    const last = fs[fs.length - 1];
    return { x: screen.x, y: screen.y - LABEL_H, w: last.x + last.w - screen.x, h: Math.max(...fs.map((f) => f.h)) + LABEL_H };
}

/** Where a new screen goes: to the right of everything, top-aligned; at 0, 0 on an empty board. */
export function nextSpot(screens: Screen[]): { x: number; y: number } {
    if (!screens.length) return { x: 0, y: 0 };
    const right = Math.max(...screens.map((s) => screenBox(s)).map((b) => b.x + b.w));
    const top = Math.min(...screens.map((s) => s.y));
    return { x: Math.round(right + 120), y: top };
}

/** A path or URL as the board compares pages: path and query, without the hash or origin. */
export function pageKey(urlOrPath: string, origin = 'http://x'): string {
    try {
        const u = new URL(urlOrPath, origin);
        const q = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const qs = new URLSearchParams(q).toString();
        return u.pathname.replace(/\/+$/, '') + (qs ? '?' + qs : '') || '/';
    } catch {
        return urlOrPath;
    }
}

export function threadOnScreen(t: Pick<Thread, 'url'>, s: Pick<Screen, 'path'>): boolean {
    return pageKey(t.url) === pageKey(s.path);
}

/** The width a thread was written at ("390x844" or "390×844"), or null. */
export function viewportWidth(viewport: string | null): number | null {
    const m = viewport && /^(\d+)/.exec(viewport);
    return m ? Number(m[1]) : null;
}

/** Where a pin sits in a frame's own pixels: at the right end of its element, halfway down, kept inside the frame. */
export function pinIn(rect: Box, frame: { w: number; h: number }): { x: number; y: number } {
    const x = rect.x + rect.w - 14;
    const y = rect.y + rect.h / 2;
    return { x: Math.min(Math.max(x, 14), frame.w - 14), y: Math.min(Math.max(y, 14), frame.h - 14) };
}

/**
 * The thread's stored box, for a frame where its element can't be found: only when the frame is the width it was
 * written at (within 40px), else null, since the layout differs.
 */
export function storedRect(t: Pick<Thread, 'x' | 'y' | 'w' | 'h' | 'viewport'>, frameW: number): Box | null {
    if (t.x === null || t.y === null) return null;
    const vw = viewportWidth(t.viewport);
    if (vw !== null && Math.abs(vw - frameW) > 40) return null;
    return { x: t.x, y: t.y, w: t.w ?? 0, h: t.h ?? 0 };
}
