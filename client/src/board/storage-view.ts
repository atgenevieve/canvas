// The storage tab: the total used, then every screenshot and recording, largest (or newest) first. Select rows (shift-
// click for a range), and Delete removes them after a confirm that names the count and the size. Nothing else deletes.
import type { Storage, StorageItem, Thread } from '../../../shared/contract.ts';
import { at, get, post } from './api.ts';
import { byId, confirmDialog, h } from './dom.ts';
import { shortDate } from './format.ts';
import { loadThreads, on, store } from './store.ts';
import { clickSelect, confirmText, countsLine, formatBytes, itemKey, pruneSelection, type SortKey, totals, visibleItems } from './storage.ts';

let data: Storage | null = null;
let sort: SortKey = 'size';
let resolvedOnly = false;
let selected = new Set<string>();
let anchor: string | null = null;
let shown: StorageItem[] = [];

export function initStorage(): void {
    const sortSel = byId<HTMLSelectElement>('st-sort');
    sortSel.addEventListener('change', () => {
        sort = sortSel.value === 'date' ? 'date' : 'size';
        render();
    });
    const resolvedBtn = byId<HTMLButtonElement>('st-resolved');
    resolvedBtn.addEventListener('click', () => {
        resolvedOnly = !resolvedOnly;
        resolvedBtn.setAttribute('aria-pressed', String(resolvedOnly));
        render();
    });
    byId('st-delete').addEventListener('click', remove);
    on('threads', () => data && render());
}

export async function loadStorage(): Promise<void> {
    data = await get<Storage>('storage');
    render();
}

function threadTitle(t: Thread | undefined): string {
    return t?.comments[0]?.body || '';
}

function render() {
    if (!data) return;
    byId('st-total').textContent = formatBytes(data.total.bytes);
    byId('st-counts').textContent = countsLine(data.total.shots, data.total.captures);
    const threads = new Map(store.threads.map((t) => [t.id, t]));
    shown = visibleItems(data.items, threads, { sort, resolvedOnly });
    selected = pruneSelection(selected, shown);
    const order = shown.map(itemKey);
    const rows = shown.map((item) => {
        const key = itemKey(item);
        const t = item.thread_id ? threads.get(item.thread_id) : undefined;
        const title = item.thread_id ? threadTitle(t) || 'Thread ' + item.thread_id : 'No thread';
        const box = h('input', { type: 'checkbox', 'aria-label': 'Select ' + (item.kind === 'shot' ? 'screenshot' : 'recording') + ': ' + title });
        box.checked = selected.has(key);
        box.addEventListener('click', (ev) => {
            selected = clickSelect(order, selected, anchor, key, box.checked, (ev as MouseEvent).shiftKey);
            anchor = key;
            syncChecks();
        });
        const thumb =
            item.kind === 'shot'
                ? h('img', { class: 'tn', alt: '', loading: 'lazy', decoding: 'async', src: at('api/uploads/' + encodeURIComponent(item.id)) })
                : h('span', { class: 'tn' });
        return h(
            'tr',
            { 'data-key': key },
            h('td', { class: 'cb' }, box),
            h('td', { class: 'thumb' }, thumb),
            h('td', { class: 'title' + (item.thread_id ? '' : ' none') }, h('span', { text: title })),
            h('td', { text: item.kind === 'shot' ? 'Screenshot' : 'Recording' }),
            h('td', { class: 'date', text: shortDate(item.created_at) }),
            h('td', { class: 'n', text: formatBytes(item.bytes) }),
        );
    });
    byId('st-rows').replaceChildren(...rows);
    syncChecks();
}

function syncChecks() {
    for (const tr of byId('st-rows').querySelectorAll<HTMLTableRowElement>('tr')) {
        const on = selected.has(tr.dataset.key || '');
        tr.classList.toggle('on', on);
        (tr.querySelector('input') as HTMLInputElement).checked = on;
    }
    const t = totals(shown, selected);
    const bar = byId('st-bar');
    bar.hidden = !t.count;
    byId('st-selected').textContent = t.count + ' selected · ' + formatBytes(t.bytes);
}

async function remove() {
    const items = shown.filter((i) => selected.has(itemKey(i)));
    if (!items.length) return;
    if (!(await confirmDialog(confirmText(totals(items, selected))))) return;
    const btn = byId<HTMLButtonElement>('st-delete');
    btn.disabled = true;
    try {
        const shots = items.filter((i) => i.kind === 'shot').map((i) => i.id);
        if (shots.length) await post('uploads/delete', { ids: shots });
        for (const i of items) if (i.kind === 'capture') await post('threads/' + encodeURIComponent(i.id) + '/capture/delete');
        selected = new Set();
        anchor = null;
    } finally {
        btn.disabled = false;
        await Promise.all([loadStorage(), loadThreads()]).catch(() => {});
    }
}
