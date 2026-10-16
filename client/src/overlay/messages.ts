// The overlay's side of the board ↔ overlay messages (docs/CONTRACT.md): same origin only, every message
// `{ canvas: 1, … }`.
import type { BoardMessage, Capture, OverlayMessage, Step, Thread } from '../../../shared/contract.ts';
import type { ReplayResult } from './replay.ts';

export interface BoardHandlers {
    replay(steps: Step[]): Promise<ReplayResult>;
    mode(comment: boolean): void;
    pins(threads: Thread[]): void;
}

export interface BoardLink {
    picked(capture: Capture): void;
    stop(): void;
}

/** In a frame whose parent is on this origin: the board. */
export function isFramed(win: Window = window): boolean {
    if (win.parent === win) return false;
    try {
        return win.parent.location.origin === win.location.origin;
    } catch (_e) {
        return false; // a cross-origin parent can't be read
    }
}

function isBoardMessage(data: unknown): data is BoardMessage {
    if (!data || typeof data !== 'object') return false;
    const m = data as Record<string, unknown>;
    if (m.canvas !== 1) return false;
    if (m.type === 'replay') return Array.isArray(m.steps);
    if (m.type === 'mode') return typeof m.comment === 'boolean';
    if (m.type === 'pins') return Array.isArray(m.threads);
    return false;
}

/** Says `ready` to the board, then answers its messages. */
export function connectBoard(handlers: BoardHandlers, win: Window = window): BoardLink {
    const origin = win.location.origin;
    const send = (message: OverlayMessage) => win.parent.postMessage(message, origin);
    let replaying = false;

    const onMessage = (event: MessageEvent) => {
        if (event.origin !== origin) return;
        if (event.source && event.source !== win.parent) return;
        const data: unknown = event.data;
        if (!isBoardMessage(data)) return;
        if (data.type === 'replay') {
            if (replaying) return;
            replaying = true;
            handlers
                .replay(data.steps)
                .catch((): ReplayResult => ({ ok: false, failedAt: 0 }))
                .then((result) => {
                    replaying = false;
                    send({ canvas: 1, type: 'replayed', ok: result.ok, ...(result.failedAt !== undefined && { failedAt: result.failedAt }) });
                });
        } else if (data.type === 'mode') {
            handlers.mode(data.comment);
        } else {
            handlers.pins(data.threads);
        }
    };
    win.addEventListener('message', onMessage);
    send({ canvas: 1, type: 'ready', url: win.location.href });

    return {
        picked: (capture) => send({ canvas: 1, type: 'picked', capture }),
        stop: () => win.removeEventListener('message', onMessage),
    };
}
