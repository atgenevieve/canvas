// Whether an element is private: marked `data-canvas-private` itself or inside an element that is (CONTRACT.md,
// "Masking"). Private elements show as a solid block in screenshots.
export const PRIVATE_ATTR = 'data-canvas-private';

export function isPrivate(el: Element | null | undefined): boolean {
    return !!el && el.closest(`[${PRIVATE_ATTR}]`) !== null;
}
