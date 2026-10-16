// Where an element comes from: its React component chain (`SaveBar › Button`), read from React's fiber on the element,
// and its source file and line from the nearest `data-canvas-src` the Vite plugin added. docs/CONTRACT.md ("The Vite
// plugin") says which components count.

export const SRC_ATTR = 'data-canvas-src';
/** The innermost components kept; a real app's outer providers and routers say nothing about the element. */
export const MAX_CHAIN = 3;

// React's fiber tags for components that have a name (function, class, forwardRef, memo, simple memo) and for host
// elements. Stable since React 16.
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
const HOST_TAG = 5;

interface Fiber {
    tag: number;
    type: unknown;
    return: Fiber | null;
    child: Fiber | null;
    stateNode: unknown;
}

/** The fiber React keeps on a host element (`__reactFiber$<random>`), or on its nearest ancestor that has one. */
export function fiberOf(el: Element | null): Fiber | null {
    for (let node: Element | null = el; node; node = node.parentElement) {
        for (const key of Object.keys(node)) {
            if (key.startsWith('__reactFiber$')) return (node as unknown as Record<string, Fiber>)[key] ?? null;
        }
    }
    return null;
}

type Named = { displayName?: unknown; name?: unknown; render?: Named; type?: Named };

// A component's name as written: capitalised and at least three letters. Minified builds rename functions to `g` or
// `Ce`, which say nothing; an app's preview build keeps names when its bundler is told to (keepNames).
const REAL_NAME = /^[A-Z][A-Za-z0-9_$]{2,}$/;

/** A component's name: `displayName`, then `name`, looking through forwardRef and memo. Empty when anonymous. */
export function nameOf(type: unknown): string {
    if (!type || (typeof type !== 'function' && typeof type !== 'object')) return '';
    const t = type as Named;
    if (typeof t.displayName === 'string' && t.displayName) return t.displayName;
    if (typeof t.name === 'string' && REAL_NAME.test(t.name) && t.name !== 'Anonymous') return t.name;
    if (t.render) return nameOf(t.render);
    if (t.type) return nameOf(t.type);
    return '';
}

// The first host element a component renders, depth first.
function hostOf(fiber: Fiber): Element | null {
    const stack: Fiber[] = fiber.child ? [fiber.child] : [];
    let budget = 200;
    while (stack.length && budget-- > 0) {
        const f = stack.shift()!;
        if (f.tag === HOST_TAG && f.stateNode instanceof Element) return f.stateNode;
        if (f.child) stack.unshift(f.child);
    }
    return null;
}

function isLibrary(fiber: Fiber): boolean {
    const src = hostOf(fiber)?.getAttribute(SRC_ATTR) ?? '';
    return src.includes('node_modules');
}

/**
 * The components around an element, outermost first, at most MAX_CHAIN of the innermost: named, not anonymous, not
 * from a library. A memo and the component inside it count once.
 */
export function componentChain(el: Element | null): string[] {
    const names: string[] = [];
    for (let f = fiberOf(el); f; f = f.return) {
        if (!COMPONENT_TAGS.has(f.tag)) continue;
        const name = nameOf(f.type);
        if (!name || isLibrary(f)) continue;
        if (names[names.length - 1] === name) continue;
        names.push(name);
        if (names.length >= MAX_CHAIN) break;
    }
    return names.reverse();
}

/** The source of the element, from its own `data-canvas-src` or its nearest ancestor's. */
export function sourceOf(el: Element | null): string | undefined {
    return el?.closest(`[${SRC_ATTR}]`)?.getAttribute(SRC_ATTR) ?? undefined;
}

/** The label under a hovered element: `SaveBar › Button · save-bar.tsx:18`, or the tag when nothing is known. */
export function labelFor(el: Element): string {
    const chain = componentChain(el).join(' › ');
    const src = sourceOf(el);
    const file = src ? src.split('/').pop() : '';
    const parts = [chain, file].filter(Boolean);
    return parts.length ? parts.join(' · ') : el.tagName.toLowerCase();
}
