// What the overlay, the board, the Worker and the CLI agree on. docs/CONTRACT.md says what each field means; change
// both together.

export const CONTRACT_VERSION = 1;
export const DEFAULT_BASE = '/__canvas';
export const MAX_STEPS = 100;
export const MAX_STEP_AGE_MS = 5 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Masked {
    masked: true;
    length: number;
}

export type Value = string | boolean | Masked;

export interface ElementFacts {
    selector: string;
    words: string;
    tag: string;
    role?: string;
    component?: string;
    source?: string;
    rect: Rect;
}

export interface Env {
    url: string;
    viewport: { w: number; h: number; dpr: number };
    scheme: 'light' | 'dark';
    userAgent: string;
    branch?: string;
    commit?: string;
    at: string; // ISO time
}

interface StepBase {
    t: number; // ms since the epoch
}

export type Step =
    | (StepBase & { kind: 'click'; selector: string; words: string; x: number; y: number })
    | (StepBase & { kind: 'input'; selector: string; label?: string; value: Value })
    | (StepBase & { kind: 'change'; selector: string; label?: string; value: Value })
    | (StepBase & { kind: 'key'; key: string; selector?: string })
    | (StepBase & { kind: 'nav'; url: string; how: 'load' | 'push' | 'replace' | 'pop' })
    | (StepBase & { kind: 'scroll'; selector: string | 'window'; x: number; y: number })
    | (StepBase & { kind: 'resize'; w: number; h: number });

export interface ConsoleError {
    t: number;
    message: string;
    stack?: string;
}

export interface FailedRequest {
    t: number;
    method: string;
    url: string;
    status: number; // 0 for a network error
    ms: number;
}

export interface Capture {
    version: typeof CONTRACT_VERSION;
    element: ElementFacts | null;
    area?: Rect;
    point?: { x: number; y: number };
    env: Env;
    steps: Step[];
    errors: ConsoleError[];
    failed: FailedRequest[];
    shots: { element?: string; screen?: string }; // upload ids
}

export interface Comment {
    id: string;
    thread_id: string;
    author: string;
    body: string;
    created_at: string;
    edited_at: string | null;
}

export interface Thread {
    id: string;
    url: string;
    selector: string | null;
    words: string | null;
    component: string | null;
    source: string | null;
    branch: string | null;
    commit_sha: string | null;
    viewport: string | null;
    x: number | null;
    y: number | null;
    w: number | null;
    h: number | null;
    status: 'open' | 'resolved';
    has_capture: boolean;
    created_by: string;
    created_at: string;
    updated_at: string;
    resolved_by: string | null;
    resolved_at: string | null;
    comments: Comment[];
}

export interface NewThread {
    body: string;
    capture: Capture;
}

export interface StorageItem {
    kind: 'shot' | 'capture';
    id: string; // an upload id, or the thread id for a capture
    thread_id: string | null;
    bytes: number;
    created_at: string;
}

export interface Storage {
    total: { bytes: number; shots: number; captures: number };
    items: StorageItem[]; // largest first
}

export type Size = 'phone' | 'tablet' | 'desktop';
export const SIZES: Record<Size, { w: number; h: number }> = {
    phone: { w: 390, h: 844 },
    tablet: { w: 820, h: 1180 },
    desktop: { w: 1440, h: 900 },
};

export interface NewScreen {
    name: string;
    path: string; // the app path, e.g. "/people?tab=open"
    sizes: Size[];
    steps: Step[]; // replayed after load to reach a state; may be empty
    x: number; // where it sits on the board
    y: number;
}

export interface Screen extends NewScreen {
    id: string;
    created_at: string;
    updated_at: string;
}

export type BoardMessage =
    | { canvas: 1; type: 'replay'; steps: Step[] }
    | { canvas: 1; type: 'mode'; comment: boolean }
    | { canvas: 1; type: 'pins'; threads: Thread[] };

export type OverlayMessage =
    | { canvas: 1; type: 'ready'; url: string }
    | { canvas: 1; type: 'replayed'; ok: boolean; failedAt?: number }
    | { canvas: 1; type: 'picked'; capture: Capture };

export interface CanvasConfig {
    project: string;
    url: string;
    base?: string;
}
