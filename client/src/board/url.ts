// The address: `?thread=<id>` opens that thread (the PR comment links here), `?tab=storage` shows the storage tab.
// Anything else in the query is kept as it is.

export type Tab = 'board' | 'storage';

export interface UrlState {
    tab: Tab;
    thread: string | null;
}

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function readUrl(search: string): UrlState {
    const q = new URLSearchParams(search);
    const t = q.get('thread');
    return { tab: q.get('tab') === 'storage' ? 'storage' : 'board', thread: t && THREAD_ID.test(t) ? t : null };
}

/** The query for this state, keeping other parameters; '' when there's nothing to say. */
export function writeUrl(state: UrlState, search = ''): string {
    const q = new URLSearchParams(search);
    if (state.tab === 'storage') q.set('tab', 'storage');
    else q.delete('tab');
    if (state.thread) q.set('thread', state.thread);
    else q.delete('thread');
    const s = q.toString();
    return s ? '?' + s : '';
}
