// The storage tab's logic: order, the "Resolved only" filter, selection (with shift-click ranges), totals. Pure.
import type { StorageItem, Thread } from '../../../shared/contract.ts';

export type SortKey = 'size' | 'date';

export const itemKey = (i: Pick<StorageItem, 'kind' | 'id'>): string => i.kind + ':' + i.id;

export function visibleItems(
    items: StorageItem[],
    threads: Map<string, Pick<Thread, 'status'>>,
    { sort, resolvedOnly }: { sort: SortKey; resolvedOnly: boolean },
): StorageItem[] {
    const out = resolvedOnly ? items.filter((i) => i.thread_id && threads.get(i.thread_id)?.status === 'resolved') : items.slice();
    const byDate = (a: StorageItem, b: StorageItem) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
    out.sort(sort === 'size' ? (a, b) => b.bytes - a.bytes || byDate(a, b) : (a, b) => byDate(a, b) || b.bytes - a.bytes);
    return out;
}

/**
 * The selection after a checkbox click. A plain click sets that row to `checked`; a shift-click sets every row from the
 * anchor (the last row clicked) to this one, in the order shown.
 */
export function clickSelect(order: string[], selected: Set<string>, anchor: string | null, clicked: string, checked: boolean, shift: boolean): Set<string> {
    const next = new Set(selected);
    const a = anchor === null ? -1 : order.indexOf(anchor);
    const b = order.indexOf(clicked);
    if (shift && a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        for (let i = from; i <= to; i++) {
            if (checked) next.add(order[i]);
            else next.delete(order[i]);
        }
    } else if (checked) next.add(clicked);
    else next.delete(clicked);
    return next;
}

/** Drop selected keys no longer listed (after a delete, a refresh or a filter). */
export function pruneSelection(selected: Set<string>, items: StorageItem[]): Set<string> {
    const shown = new Set(items.map(itemKey));
    return new Set([...selected].filter((k) => shown.has(k)));
}

export function totals(items: StorageItem[], selected: Set<string>): { count: number; bytes: number; shots: number; captures: number } {
    const t = { count: 0, bytes: 0, shots: 0, captures: 0 };
    for (const i of items) {
        if (!selected.has(itemKey(i))) continue;
        t.count++;
        t.bytes += i.bytes;
        if (i.kind === 'shot') t.shots++;
        else t.captures++;
    }
    return t;
}

/** 184 MB, 1.8 MB, 420 KB, 38 KB, 900 B: decimal units, as Cloudflare bills. */
export function formatBytes(n: number): string {
    if (n < 1000) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = -1;
    while (v >= 1000 && u < units.length - 1) {
        v /= 1000;
        u++;
    }
    return (v >= 100 || Number.isInteger(+v.toFixed(1)) ? Math.round(v) : +v.toFixed(1)) + ' ' + units[u];
}

const plural = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many);

export function countsLine(shots: number, captures: number): string {
    return plural(shots, 'screenshot', 'screenshots') + ' · ' + plural(captures, 'recording', 'recordings');
}

/** The confirm dialog's question: what goes, and how much. */
export function confirmText(t: { shots: number; captures: number; bytes: number }): string {
    const parts = [];
    if (t.shots) parts.push(plural(t.shots, 'screenshot', 'screenshots'));
    if (t.captures) parts.push(plural(t.captures, 'recording', 'recordings'));
    return 'Delete ' + parts.join(' and ') + ' (' + formatBytes(t.bytes) + ')?';
}
