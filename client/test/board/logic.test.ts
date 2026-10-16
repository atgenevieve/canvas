// @vitest-environment happy-dom
// The board's pure logic: the camera, where frames and pins go, the storage tab's order, filter, selection and totals,
// and the address. The page itself is checked in a real browser by test/board.browser.mjs.
import { describe, expect, it } from 'vitest';
import type { Screen, StorageItem, Thread } from '../../../shared/contract.ts';
import { bounds, center, fitBox, fromCenter, MAX_Z, MIN_Z, panBy, toScreen, toWorld, wheelFactor, zoomAt } from '../../src/board/camera.ts';
import { ago, who } from '../../src/board/format.ts';
import { FRAME_GAP, framesOf, nextSpot, pageKey, pinIn, screenBox, storedRect, threadOnScreen } from '../../src/board/layout.ts';
import { clickSelect, confirmText, countsLine, formatBytes, itemKey, pruneSelection, totals, visibleItems } from '../../src/board/storage.ts';
import { readUrl, writeUrl } from '../../src/board/url.ts';

const screen = (o: Partial<Screen> = {}): Screen => ({
    id: 's1',
    name: 'People',
    path: '/people',
    sizes: ['phone', 'desktop'],
    steps: [],
    x: 100,
    y: 50,
    created_at: '2026-10-16T10:00:00Z',
    updated_at: '2026-10-16T10:00:00Z',
    ...o,
});

describe('camera', () => {
    it('zooms about the pointer: the world point under it stays put', () => {
        const cam = { x: 10, y: 20, z: 1 };
        const before = toWorld(cam, 300, 200);
        const next = zoomAt(cam, 300, 200, 2);
        expect(next.z).toBe(2);
        const after = toWorld(next, 300, 200);
        expect(after.x).toBeCloseTo(before.x);
        expect(after.y).toBeCloseTo(before.y);
    });

    it('clamps the zoom', () => {
        expect(zoomAt({ x: 0, y: 0, z: 1 }, 0, 0, 1000).z).toBe(MAX_Z);
        expect(zoomAt({ x: 0, y: 0, z: 1 }, 0, 0, 0.0001).z).toBe(MIN_Z);
    });

    it('pans in screen pixels whatever the zoom', () => {
        expect(panBy({ x: 0, y: 0, z: 2 }, 100, -50)).toEqual({ x: 50, y: -25, z: 2 });
    });

    it('round-trips the middle of the view', () => {
        const cam = { x: 40, y: -30, z: 0.5 };
        const c = center(cam, 800, 600);
        expect(fromCenter({ ...c, z: 0.5 }, 800, 600)).toEqual(cam);
        const s = toScreen(cam, c.x, c.y);
        expect(s).toEqual({ x: 400, y: 300 });
    });

    it('fits a box whole and centred, never above the cap', () => {
        const box = { x: 0, y: 0, w: 2000, h: 1000 };
        const cam = fitBox(box, 1000, 800, 1, 50);
        expect(cam.z).toBeCloseTo(0.45);
        const mid = center(cam, 1000, 800);
        expect(mid.x).toBeCloseTo(1000);
        expect(mid.y).toBeCloseTo(500);
        expect(fitBox({ x: 0, y: 0, w: 10, h: 10 }, 1000, 800, 1).z).toBe(1);
    });

    it('bounds many boxes, none for none', () => {
        expect(bounds([])).toBeNull();
        expect(bounds([{ x: 0, y: 0, w: 10, h: 10 }, { x: -5, y: 20, w: 10, h: 10 }])).toEqual({ x: -5, y: 0, w: 15, h: 30 });
    });

    it('a wheel zooms in for negative deltas, capped per event', () => {
        expect(wheelFactor(-10)).toBeGreaterThan(1);
        expect(wheelFactor(10)).toBeLessThan(1);
        expect(wheelFactor(1000)).toBe(wheelFactor(40));
    });
});

describe('layout', () => {
    it('lays a screen’s sizes side by side, phone first', () => {
        const fs = framesOf(screen({ sizes: ['desktop', 'phone'] }));
        expect(fs.map((f) => [f.size, f.x, f.y, f.w, f.h])).toEqual([
            ['phone', 100, 50, 390, 844],
            ['desktop', 100 + 390 + FRAME_GAP, 50, 1440, 900],
        ]);
        expect(fs[0].key).toBe('s1:phone');
        const b = screenBox(screen());
        expect(b).toEqual({ x: 100, y: 22, w: 390 + FRAME_GAP + 1440, h: 900 + 28 });
    });

    it('puts a new screen to the right of the others', () => {
        expect(nextSpot([])).toEqual({ x: 0, y: 0 });
        const s = screen({ sizes: ['phone'] });
        expect(nextSpot([s])).toEqual({ x: 100 + 390 + 120, y: 50 });
    });

    it('matches a thread to a screen by path and query, not origin, hash or query order', () => {
        expect(pageKey('https://preview.example.org/people/?b=2&a=1#x')).toBe('/people?a=1&b=2');
        expect(threadOnScreen({ url: 'https://preview.example.org/people' }, { path: '/people' })).toBe(true);
        expect(threadOnScreen({ url: 'https://preview.example.org/' }, { path: '/' })).toBe(true);
        expect(threadOnScreen({ url: 'https://preview.example.org/settings' }, { path: '/people' })).toBe(false);
    });

    it('puts a pin at the right end of its element, inside the frame', () => {
        expect(pinIn({ x: 10, y: 100, w: 200, h: 40 }, { w: 390, h: 844 })).toEqual({ x: 196, y: 120 });
        expect(pinIn({ x: 300, y: 830, w: 200, h: 40 }, { w: 390, h: 844 })).toEqual({ x: 376, y: 830 });
    });

    it('uses a thread’s stored box only at the width it was written at', () => {
        const t = { x: 10, y: 20, w: 30, h: 40, viewport: '390x844' };
        expect(storedRect(t, 390)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
        expect(storedRect(t, 1440)).toBeNull();
        expect(storedRect({ ...t, x: null }, 390)).toBeNull();
    });
});

const item = (kind: 'shot' | 'capture', id: string, bytes: number, created_at: string, thread_id: string | null = 't1'): StorageItem => ({
    kind,
    shot_kind: kind === 'shot' ? 'screen' : null,
    id,
    thread_id,
    bytes,
    created_at,
});

describe('storage', () => {
    const items = [
        item('shot', 'u1', 420_000, '2026-10-16T10:00:00Z'),
        item('shot', 'u2', 1_800_000, '2026-10-16T09:00:00Z'),
        item('capture', 't2', 38_000, '2026-10-15T09:00:00Z', 't2'),
        item('shot', 'u3', 1_500_000, '2026-10-14T09:00:00Z', null),
    ];
    const threads = new Map<string, Pick<Thread, 'status'>>([
        ['t1', { status: 'open' }],
        ['t2', { status: 'resolved' }],
    ]);

    it('sorts by size, largest first, or by date, newest first', () => {
        expect(visibleItems(items, threads, { sort: 'size', resolvedOnly: false }).map((i) => i.id)).toEqual(['u2', 'u3', 'u1', 't2']);
        expect(visibleItems(items, threads, { sort: 'date', resolvedOnly: false }).map((i) => i.id)).toEqual(['u1', 'u2', 't2', 'u3']);
    });

    it('"Resolved only" keeps what belongs to resolved threads', () => {
        expect(visibleItems(items, threads, { sort: 'size', resolvedOnly: true }).map((i) => i.id)).toEqual(['t2']);
    });

    it('selects one row, or a range with shift, in the order shown', () => {
        const order = ['a', 'b', 'c', 'd', 'e'];
        let sel = clickSelect(order, new Set(), null, 'b', true, false);
        expect([...sel]).toEqual(['b']);
        sel = clickSelect(order, sel, 'b', 'e', true, true);
        expect([...sel].sort()).toEqual(['b', 'c', 'd', 'e']);
        sel = clickSelect(order, sel, 'e', 'c', false, true);
        expect([...sel]).toEqual(['b']);
        // shift with no anchor is a plain click
        expect([...clickSelect(order, new Set(), null, 'd', true, true)]).toEqual(['d']);
    });

    it('totals the selection by kind and bytes, and drops what isn’t shown', () => {
        const sel = new Set([itemKey(items[0]), itemKey(items[1]), itemKey(items[2]), 'shot:gone']);
        expect(totals(items, sel)).toEqual({ count: 3, bytes: 2_258_000, shots: 2, captures: 1 });
        expect(pruneSelection(sel, items).has('shot:gone')).toBe(false);
    });

    it('writes sizes and the confirm question', () => {
        expect(formatBytes(900)).toBe('900 B');
        expect(formatBytes(38_000)).toBe('38 KB');
        expect(formatBytes(420_000)).toBe('420 KB');
        expect(formatBytes(1_800_000)).toBe('1.8 MB');
        expect(formatBytes(2_200_000)).toBe('2.2 MB');
        expect(formatBytes(184_000_000)).toBe('184 MB');
        expect(confirmText({ shots: 2, captures: 0, bytes: 2_200_000 })).toBe('Delete 2 screenshots (2.2 MB)?');
        expect(confirmText({ shots: 1, captures: 1, bytes: 38_500 })).toBe('Delete 1 screenshot and 1 recording (38.5 KB)?');
        expect(countsLine(412, 96)).toBe('412 screenshots · 96 recordings');
    });
});

describe('the address', () => {
    it('reads the tab and the thread', () => {
        expect(readUrl('')).toEqual({ tab: 'board', thread: null });
        expect(readUrl('?thread=c7k2m9qp')).toEqual({ tab: 'board', thread: 'c7k2m9qp' });
        expect(readUrl('?tab=storage')).toEqual({ tab: 'storage', thread: null });
        expect(readUrl('?thread=<script>')).toEqual({ tab: 'board', thread: null });
    });

    it('writes them back, keeping anything else', () => {
        expect(writeUrl({ tab: 'board', thread: null }, '?tab=storage')).toBe('');
        expect(writeUrl({ tab: 'storage', thread: null }, '')).toBe('?tab=storage');
        expect(writeUrl({ tab: 'board', thread: 'abc' }, '?x=1')).toBe('?x=1&thread=abc');
    });
});

describe('words', () => {
    it('names people and times', () => {
        expect(who('jordan@example.org', 'jordan@example.org')).toBe('You');
        expect(who('claude', 'jordan@example.org')).toBe('Claude');
        expect(who('ruth@example.org', 'jordan@example.org')).toBe('ruth');
        const now = Date.parse('2026-10-16T12:00:00Z');
        expect(ago('2026-10-16T11:58:00Z', now)).toBe('2m');
        expect(ago('2026-10-16T11:00:00Z', now)).toBe('1h');
        expect(ago('2026-10-01T11:00:00Z', now)).toBe('Oct 1');
    });
});
