// Where the toolbar sits: the plugin's `corner`, unless you dragged it to another one, which this browser keeps in
// localStorage (`canvas:corner`) for this app. docs/CONTRACT.md, "The overlay on its own".

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export const CORNERS: readonly Corner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
export const CORNER_KEY = 'canvas:corner';
export const DEFAULT_CORNER: Corner = 'bottom-right';

export function isCorner(value: unknown): value is Corner {
    return typeof value === 'string' && (CORNERS as readonly string[]).includes(value);
}

/** The corner nearest a point (the dragged toolbar's centre) in a viewport of w × h. */
export function nearestCorner(x: number, y: number, w: number, h: number): Corner {
    return `${y < h / 2 ? 'top' : 'bottom'}-${x < w / 2 ? 'left' : 'right'}` as Corner;
}

/** The kept corner, else the plugin's, else bottom right. */
export function readCorner(fallback: unknown, storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Corner {
    let kept: string | null = null;
    try {
        kept = storage?.getItem(CORNER_KEY) ?? null;
    } catch (_e) {
        // storage blocked: a private window, or site data off
    }
    if (isCorner(kept)) return kept;
    return isCorner(fallback) ? fallback : DEFAULT_CORNER;
}

export function saveCorner(corner: Corner, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
    try {
        storage?.setItem(CORNER_KEY, corner);
    } catch (_e) {
        // storage blocked; the corner lasts until the page reloads
    }
}

function safeStorage(): Storage | undefined {
    try {
        return globalThis.localStorage;
    } catch (_e) {
        return undefined;
    }
}
