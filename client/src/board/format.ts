// Words for people and times in the thread list and the storage table. Pure.

export function who(author: string, me: string | null): string {
    if (me && author === me) return 'You';
    if (author === 'claude') return 'Claude';
    return author.split('@')[0];
}

const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** 2m, 3h, 4d, then Oct 14. "now" under a minute. */
export function ago(iso: string, now = Date.now()): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (now - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
    return day.format(new Date(t));
}

export function shortDate(iso: string): string {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? day.format(new Date(t)) : '';
}
