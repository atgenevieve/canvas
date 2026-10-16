// @vitest-environment happy-dom
// Screenshot masking and upload, on happy-dom. It can't draw, so this drives the hooks the screenshot library calls
// (filter each node, then hand over each clone) the way the library walks the tree; the pixels are checked in a real
// browser by test/shots.browser.mjs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from 'modern-screenshot';
import { isPrivate } from '../../src/overlay/private.ts';
import { isSecretField, maskHooks, PRIVATE_FILL, scaleFor, upload } from '../../src/overlay/shots.ts';

/** Clone `node` as modern-screenshot does: filter each child before cloning it, call onCloneEachNode last. */
function cloneLikeLibrary(node: Node, hooks: Pick<Options, 'filter' | 'onCloneEachNode'>): Node {
    const cloned = node.cloneNode(false);
    if (node.nodeType === 1 && 'value' in (node as HTMLInputElement)) {
        (cloned as Element).setAttribute('value', (node as HTMLInputElement).value);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (hooks.filter && !hooks.filter(child)) continue;
        cloned.appendChild(cloneLikeLibrary(child, hooks));
    }
    hooks.onCloneEachNode?.(cloned);
    return cloned;
}

function page(html: string): HTMLElement {
    document.body.innerHTML = `<main id="root">${html}</main>`;
    return document.getElementById('root') as HTMLElement;
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

describe('isPrivate', () => {
    it('is true on a marked element and anything inside it', () => {
        const root = page('<section data-canvas-private><p><b id="in">Jordan Alvarez</b></p></section><p id="out">Hi</p>');
        expect(isPrivate(root.querySelector('section'))).toBe(true);
        expect(isPrivate(root.querySelector('#in'))).toBe(true);
        expect(isPrivate(root.querySelector('#out'))).toBe(false);
        expect(isPrivate(null)).toBe(false);
    });
});

describe('masking', () => {
    it('keeps a private element as an empty solid block and drops everything inside', () => {
        const root = page(`
            <h1>People</h1>
            <section data-canvas-private class="card" title="Ruth Adeyemi">
                Ruth Adeyemi <img src="/avatar.png" alt="Ruth"> <span>ruth@example.org</span>
            </section>
            <span data-canvas-private>555-0142</span>`);
        const clone = cloneLikeLibrary(root, maskHooks()) as HTMLElement;
        expect(clone.textContent).toContain('People');
        expect(clone.textContent).not.toMatch(/Ruth|example\.org|555/);
        expect(clone.querySelector('img')).toBeNull();
        const [section, span] = Array.from(clone.querySelectorAll<HTMLElement>('[data-canvas-private]'));
        expect(section.childNodes).toHaveLength(0);
        expect(section.getAttribute('title')).toBeNull();
        expect(section.getAttribute('class')).toBeNull();
        expect(section.style.getPropertyValue('background')).toContain(PRIVATE_FILL.slice(1));
        expect(section.style.getPropertyPriority('background')).toBe('important');
        expect(section.style.getPropertyValue('color')).toBe('transparent');
        expect(span.style.getPropertyValue('display')).toBe('inline-block');
    });

    it('blanks a private image itself', () => {
        const root = page('<img data-canvas-private src="/avatar.png" srcset="/avatar-2x.png 2x" alt="Ruth">');
        const img = (cloneLikeLibrary(root, maskHooks()) as HTMLElement).querySelector('img') as HTMLImageElement;
        expect(img.getAttribute('src')).toBeNull();
        expect(img.getAttribute('srcset')).toBeNull();
        expect(img.getAttribute('alt')).toBeNull();
    });

    it('shows password and payment fields empty, other fields as typed', () => {
        const root = page(`
            <input id="pw" type="password">
            <input id="cc" autocomplete="cc-number">
            <input id="np" autocomplete="new-password">
            <input id="name">`);
        for (const id of ['pw', 'cc', 'np']) (root.querySelector(`#${id}`) as HTMLInputElement).value = 'hunter22';
        (root.querySelector('#name') as HTMLInputElement).value = 'Jordan';
        const clone = cloneLikeLibrary(root, maskHooks()) as HTMLElement;
        for (const id of ['pw', 'cc', 'np']) expect(clone.querySelector(`#${id}`)?.getAttribute('value')).toBeNull();
        expect(clone.querySelector('#name')?.getAttribute('value')).toBe('Jordan');
    });

    it('leaves out the canvas UI', () => {
        const root = page('<p>App</p><div data-canvas-ui><button>Comment</button></div>');
        const clone = cloneLikeLibrary(root, maskHooks()) as HTMLElement;
        expect(clone.querySelector('[data-canvas-ui]')).toBeNull();
        expect(clone.textContent).not.toContain('Comment');
    });

    it('knows which fields are secret', () => {
        const el = (html: string) => page(html).firstElementChild as Element;
        expect(isSecretField(el('<input type="hidden">'))).toBe(true);
        expect(isSecretField(el('<input autocomplete="current-password">'))).toBe(true);
        expect(isSecretField(el('<input type="email">'))).toBe(false);
        expect(isSecretField(el('<div></div>'))).toBe(false);
    });
});

describe('scaleFor', () => {
    it('uses the screen ratio, at most 2', () => {
        expect(scaleFor(390, 844, 1)).toBe(1);
        expect(scaleFor(390, 844, 3)).toBe(2);
    });
    it('keeps the longest side at most 2000px', () => {
        expect(scaleFor(1440, 900, 2)).toBeCloseTo(2000 / 1440);
        expect(Math.round(5000 * scaleFor(5000, 300, 1))).toBe(2000);
    });
});

describe('upload', () => {
    it('posts the image to api/uploads and returns its id and size', async () => {
        const fetchMock = vi.fn(async () => Response.json({ id: 'up_k2m9', bytes: 4 }));
        vi.stubGlobal('fetch', fetchMock);
        const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' });
        await expect(upload(blob, 'https://preview.example.org/__canvas/')).resolves.toEqual({ id: 'up_k2m9', bytes: 4 });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://preview.example.org/__canvas/api/uploads');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/webp');
        expect(init.body).toBe(blob);
    });

    it('defaults to the same-origin base', async () => {
        const fetchMock = vi.fn(async () => Response.json({ id: 'up_a', bytes: 1 }));
        vi.stubGlobal('fetch', fetchMock);
        await upload(new Blob(['x'], { type: 'image/png' }));
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/__canvas/api/uploads');
    });

    it('throws the service error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'too large' }, { status: 413 })));
        await expect(upload(new Blob(['x'], { type: 'image/png' }), '/__canvas')).rejects.toThrow(/413: too large/);
    });
});
