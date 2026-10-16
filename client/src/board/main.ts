// The board page at BASE/: the Board tab (screens, pins, threads) and the Storage tab. `?thread=<id>` opens a thread,
// `?tab=storage` the storage tab. BASE/live says when a thread or the screens change.
import { liveUrl } from './api.ts';
import { boardKey, initBoard, setCommenting } from './board.ts';
import { byId } from './dom.ts';
import { initStorage, loadStorage } from './storage-view.ts';
import { loadScreens, loadThreads, on, reloadThread, select, store } from './store.ts';
import { initThreads } from './threads.ts';
import { readUrl, type Tab, writeUrl } from './url.ts';

let tab: Tab = 'board';

function setTab(next: Tab) {
    tab = next;
    byId('tab-board').setAttribute('aria-selected', String(tab === 'board'));
    byId('tab-storage').setAttribute('aria-selected', String(tab === 'storage'));
    byId('board-view').hidden = tab !== 'board';
    byId('storage-view').hidden = tab !== 'storage';
    byId('comment').hidden = tab !== 'board';
    if (tab === 'storage') {
        setCommenting(false);
        loadStorage().catch(() => {});
    }
    syncUrl();
}

function syncUrl() {
    const s = writeUrl({ tab, thread: store.selected }, location.search);
    if (s !== location.search) history.replaceState(null, '', location.pathname + s + location.hash);
}

function connectLive() {
    let ws: WebSocket | null = null;
    let wait = 1000;
    let retry = 0;
    const open = () => {
        clearTimeout(retry);
        if (ws || document.visibilityState !== 'visible') return;
        let sock: WebSocket;
        try {
            sock = new WebSocket(liveUrl());
        } catch {
            return;
        }
        ws = sock;
        let opened = false;
        sock.onopen = () => {
            // whatever changed while it was closed
            if (opened || wait > 1000) Promise.all([loadThreads(), loadScreens()]).catch(() => {});
            opened = true;
            wait = 1000;
        };
        sock.onmessage = (ev) => {
            let m: { type?: string; id?: string } | null;
            try {
                m = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (m?.type === 'thread' && typeof m.id === 'string') {
                reloadThread(m.id);
                if (tab === 'storage') loadStorage().catch(() => {});
            } else if (m?.type === 'screens') loadScreens().catch(() => {});
        };
        sock.onclose = () => {
            if (ws !== sock) return;
            ws = null;
            retry = window.setTimeout(open, wait);
            wait = Math.min(wait * 2, 30000);
        };
    };
    setInterval(() => ws?.readyState === 1 && ws.send('ping'), 30000);
    document.addEventListener('visibilitychange', open);
    addEventListener('online', open);
    open();
}

async function boot() {
    const url = readUrl(location.search);
    byId('project').textContent = location.hostname;
    initBoard({ onProject: (name) => (byId('project').textContent = name) });
    initThreads();
    initStorage();
    byId('tab-board').addEventListener('click', () => setTab('board'));
    byId('tab-storage').addEventListener('click', () => setTab('storage'));
    document.addEventListener('keydown', (ev) => tab === 'board' && boardKey(ev));
    on('selected', syncUrl);
    setTab(url.tab);
    await Promise.all([loadThreads(), loadScreens()]).catch(() => {});
    if (url.thread) select(url.thread);
    connectLive();
}

boot();
