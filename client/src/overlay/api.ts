// The canvas API, on the app's own origin (docs/CONTRACT.md, "The API").
import type { NewScreen, NewThread, Screen, Thread } from '../../../shared/contract.ts';

export class Api {
    constructor(readonly base: string) {}

    private async call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
        let res: Response;
        try {
            res = await fetch(`${this.base}/${path}`, {
                method: init?.method ?? 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                ...(init?.body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
            });
        } catch (err) {
            throw new Error('Couldn’t reach the canvas. Try again.', { cause: err });
        }
        const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
        if (!res.ok || !data) throw new Error(data?.error || 'Couldn’t save. Try again.');
        return data;
    }

    threads(): Promise<{ me: string; threads: Thread[] }> {
        return this.call('api/threads');
    }
    newThread(body: NewThread): Promise<{ thread: Thread }> {
        return this.call('api/threads', { method: 'POST', body });
    }
    reply(id: string, body: string): Promise<{ thread: Thread }> {
        return this.call(`api/threads/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { body } });
    }
    setStatus(id: string, resolved: boolean): Promise<{ thread: Thread }> {
        return this.call(`api/threads/${encodeURIComponent(id)}/${resolved ? 'resolve' : 'reopen'}`, { method: 'POST' });
    }
    newScreen(body: NewScreen): Promise<{ screen: Screen }> {
        return this.call('api/screens', { method: 'POST', body });
    }
}
