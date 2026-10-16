// What the overlay reads off an element: a selector that finds it again, its visible words, its field label and value,
// and whether it is private. docs/CONTRACT.md ("A capture", "Masking") says what each must do.
import type { Masked, Value } from '../../../shared/contract.ts';

export const MAX_WORDS = 120;
export const PRIVATE_ATTR = 'data-canvas-private';
const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
const NOT_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image']);

/** Marked `data-canvas-private`, on the element or any ancestor. */
export function isPrivate(el: Element | null | undefined): boolean {
    return !!el?.closest(`[${PRIVATE_ATTR}]`);
}

/** Whether a field's value must be replaced with `{ masked, length }`. */
export function isMasked(el: Element): boolean {
    if (isPrivate(el)) return true;
    if (el instanceof HTMLInputElement) {
        const type = el.type.toLowerCase();
        if (type === 'password' || type === 'hidden') return true;
    }
    for (let node: Element | null = el; node; node = node.parentElement) {
        const auto = node.getAttribute('autocomplete')?.trim().toLowerCase();
        if (auto && auto.split(/\s+/).some((token) => token.startsWith('cc-') || token === 'new-password' || token === 'current-password')) {
            return true;
        }
    }
    return false;
}

/** An input or textarea people type into, or a contenteditable region. Selects, checkboxes and buttons are not. */
export function isTextField(el: Element | null): el is HTMLElement {
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return !NOT_TEXT_INPUTS.has(el.type.toLowerCase());
    return el instanceof HTMLElement && el.isContentEditable;
}

export function mask(value: string): Masked {
    return { masked: true, length: value.length };
}

/** A field's current value as a step records it: text, a checkbox's state, or masked. */
export function valueOf(el: Element): Value {
    let value: string | boolean;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) value = el.checked;
    else if (el instanceof HTMLSelectElement && el.multiple) value = [...el.selectedOptions].map((o) => o.value).join(',');
    else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) value = el.value;
    else value = el.textContent ?? '';
    if (!isMasked(el)) return value;
    return typeof value === 'boolean' ? { masked: true, length: 0 } : mask(value);
}

function hidden(el: Element): boolean {
    if (el instanceof HTMLElement && el.hidden) return true;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    return !!style && (style.display === 'none' || style.visibility === 'hidden');
}

function collect(node: Node, out: string[], budget: { left: number }): void {
    if (budget.left <= 0) return;
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        out.push(text);
        budget.left -= text.trim().length;
        return;
    }
    if (!(node instanceof Element)) return;
    if (SKIP_TEXT.has(node.tagName.toUpperCase()) || node.hasAttribute(PRIVATE_ATTR) || hidden(node)) return;
    if (node instanceof HTMLInputElement && (node.type === 'button' || node.type === 'submit' || node.type === 'reset')) {
        out.push(` ${node.value} `);
        return;
    }
    for (const child of node.childNodes) collect(child, out, budget);
    // Block-level boundaries read as spaces ("Name" + "Role", not "NameRole").
    out.push(' ');
}

/** The first 120 characters of an element's visible text, private parts left out. */
export function wordsOf(el: Element | null): string {
    if (!el || isPrivate(el)) return '';
    const out: string[] = [];
    collect(el, out, { left: MAX_WORDS * 2 });
    return out.join('').replace(/\s+/g, ' ').trim().slice(0, MAX_WORDS);
}

/** A field's label: its associated <label>, aria-labelledby, aria-label, placeholder or name. */
export function labelOf(el: Element): string | undefined {
    const doc = el.ownerDocument;
    const labels: Element[] = [];
    if ('labels' in el && (el as HTMLInputElement).labels) labels.push(...(el as HTMLInputElement).labels!);
    if (!labels.length && el.id) labels.push(...doc.querySelectorAll(`label[for="${attrEscape(el.id)}"]`));
    const wrapping = el.closest('label');
    if (!labels.length && wrapping) labels.push(wrapping);
    for (const label of labels) {
        const words = labelWords(label, el);
        if (words) return words;
    }
    const by = el.getAttribute('aria-labelledby');
    if (by) {
        const words = by
            .split(/\s+/)
            .map((id) => wordsOf(doc.getElementById(id)))
            .filter(Boolean)
            .join(' ');
        if (words) return words.slice(0, MAX_WORDS);
    }
    for (const attr of ['aria-label', 'placeholder', 'name']) {
        const value = el.getAttribute(attr)?.trim();
        if (value) return value.slice(0, MAX_WORDS);
    }
    return undefined;
}

// A label's words without the text of the control inside it (a wrapping label around a select would read its options).
function labelWords(label: Element, control: Element): string {
    if (!label.contains(control)) return wordsOf(label);
    const copy = label.cloneNode(true) as Element;
    copy.querySelectorAll('input, select, textarea, [contenteditable]').forEach((n) => n.remove());
    if (isPrivate(label)) return '';
    const out: string[] = [];
    collect(copy, out, { left: MAX_WORDS * 2 });
    return out.join('').replace(/\s+/g, ' ').trim().slice(0, MAX_WORDS);
}

export function cssEscape(value: string): string {
    const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
    if (css?.escape) return css.escape(value);
    return value.replace(/^(-?)(\d)|[^\w-]/g, (match, dash: string | undefined, digit: string | undefined) =>
        digit !== undefined ? `${dash}\\3${digit} ` : `\\${match}`,
    );
}

function attrEscape(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
}

const CLASS_OK = /^[a-zA-Z_][\w-]{0,39}$/;

function anchorOf(el: Element): string | null {
    const testid = el.getAttribute('data-testid');
    if (testid) return `[data-testid="${attrEscape(testid)}"]`;
    if (el.id) return /^[a-zA-Z_][\w-]*$/.test(el.id) ? `#${el.id}` : `[id="${attrEscape(el.id)}"]`;
    return null;
}

function segment(el: Element): string {
    const tag = el.tagName.toLowerCase();
    // Two readable classes at most; generated ones (css-1x2y3z, long hashes) stay out.
    const classes = [...el.classList].filter((c) => CLASS_OK.test(c) && !/\d{3,}/.test(c)).slice(0, 2);
    let part = tag + classes.map((c) => `.${cssEscape(c)}`).join('');
    const parent = el.parentElement;
    if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return part;
}

function matches(doc: Document, selector: string, el: Element): boolean {
    try {
        return doc.querySelector(selector) === el;
    } catch (_e) {
        return false;
    }
}

function count(doc: Document, selector: string): number {
    try {
        return doc.querySelectorAll(selector).length;
    } catch (_e) {
        return 0;
    }
}

/**
 * A CSS selector that finds the element again: `[data-testid]`, then `#id`, then the shortest `tag.class:nth-of-type`
 * path that still finds it, from the nearest ancestor with either (or from the root).
 */
export function selectorFor(el: Element): string {
    const doc = el.ownerDocument;
    const own = anchorOf(el);
    if (own && matches(doc, own, el)) return own;

    const path: string[] = [];
    let anchor: string | null = null;
    for (let node: Element | null = el; node; node = node.parentElement) {
        if (node !== el) {
            const a = anchorOf(node);
            if (a && count(doc, a) === 1) {
                anchor = a;
                break;
            }
        }
        if (node === doc.documentElement) break;
        path.unshift(segment(node));
        if (node === doc.body) break;
    }
    // The shortest tail of the path that finds this element, under the anchor when there is one.
    for (let i = path.length - 1; i >= 0; i--) {
        const tail = path.slice(i).join(' > ');
        const candidate = anchor ? (i === 0 ? `${anchor} > ${tail}` : `${anchor} ${tail}`) : tail;
        if (matches(doc, candidate, el)) return candidate;
    }
    const full = path.join(' > ');
    return anchor ? `${anchor} > ${full}` : full;
}
