// What the board page knows: who's looking, the threads, the screens. The views subscribe and redraw on a change.
import type { Screen, Thread } from '../../../shared/contract.ts';
import { ApiError, get } from './api.ts';

type Listener = () => void;

export const store = {
    me: null as string | null,
    threads: [] as Thread[],
    screens: [] as Screen[],
    selected: null as string | null,
};

const listeners = { threads: new Set<Listener>(), screens: new Set<Listener>(), selected: new Set<Listener>() };
export function on(what: keyof typeof listeners, fn: Listener): void {
    listeners[what].add(fn);
}
export function emit(what: keyof typeof listeners): void {
    for (const fn of listeners[what]) fn();
}

const byActivity = (a: Thread, b: Thread) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0);

export async function loadThreads(): Promise<void> {
    const out = await get<{ me: string; threads: Thread[] }>('threads');
    store.me = out.me;
    store.threads = out.threads.slice().sort(byActivity);
    if (store.selected && !store.threads.some((t) => t.id === store.selected)) select(null);
    emit('threads');
}

export function upsert(thread: Thread): void {
    store.threads = [thread, ...store.threads.filter((t) => t.id !== thread.id)].sort(byActivity);
    emit('threads');
}

export function removeThread(id: string): void {
    store.threads = store.threads.filter((t) => t.id !== id);
    if (store.selected === id) select(null);
    emit('threads');
}

/** One thread again (a live update): changed, or gone. */
export async function reloadThread(id: string): Promise<void> {
    try {
        const out = await get<{ me: string; thread: Thread }>('threads/' + encodeURIComponent(id));
        upsert(out.thread);
    } catch (e) {
        if (e instanceof ApiError && e.status === 404) removeThread(id);
    }
}

export async function loadScreens(): Promise<void> {
    const out = await get<{ screens: Screen[] }>('screens');
    store.screens = out.screens;
    emit('screens');
}

export function select(id: string | null): void {
    if (id === store.selected) return;
    store.selected = id;
    emit('selected');
}

export const threadById = (id: string | null): Thread | undefined => (id ? store.threads.find((t) => t.id === id) : undefined);
