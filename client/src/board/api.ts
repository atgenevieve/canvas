// The canvas API, from the board page at BASE/. Paths are relative to BASE, found from this script's own address
// (BASE/board.js), so the board works wherever the Worker is routed.

export const BASE = new URL('.', import.meta.url);

export const at = (path: string): string => new URL(path, BASE).toString();

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
        res = await fetch(at(path), { cache: 'no-store', ...init });
    } catch {
        throw new ApiError('Couldn’t reach the canvas. Try again.', 0);
    }
    const out = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || out === null) throw new ApiError(out?.error || 'Something went wrong. Try again.', res.status);
    return out;
}

export const get = <T>(path: string): Promise<T> => send<T>('api/' + path);

export const post = <T>(path: string, body?: unknown): Promise<T> =>
    send<T>('api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const liveUrl = (): string => at('live').replace(/^http/, 'ws');
