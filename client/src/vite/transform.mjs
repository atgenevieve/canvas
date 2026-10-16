// Adds `data-canvas-src="path:line"` to every host (lowercase) JSX element of a project .jsx/.tsx file. It parses with
// Babel's parser and edits the original text with magic-string, so the rest of the file is untouched and the source
// map is exact. Components, member names (`<UI.Row>`), namespaced names and fragments are left alone.
import path from 'node:path';
import { parse } from '@babel/parser';
import MagicString from 'magic-string';

export const ATTR = 'data-canvas-src';

/**
 * @typedef {{ type: string; start?: number | null; end?: number | null; loc?: { start: { line: number } } | null }} Node
 * @typedef {Node & { name: Node & { name?: string }; attributes: (Node & { name?: Node & { name?: string } })[] }} OpeningElement
 */

/** @param {unknown} node @param {(el: OpeningElement) => void} visit */
function walk(node, visit) {
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
    }
    if (!node || typeof node !== 'object') return;
    const n = /** @type {Record<string, unknown> & Node} */ (node);
    if (typeof n.type !== 'string') return;
    if (n.type === 'JSXOpeningElement') visit(/** @type {OpeningElement} */ (/** @type {unknown} */ (n)));
    for (const key in n) {
        if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
        const value = n[key];
        if (value && typeof value === 'object') walk(value, visit);
    }
}

/**
 * @param {string} code
 * @param {string} id the module id (may carry a ?query)
 * @param {string} root the project root; `path` is relative to it
 * @returns {{ code: string; map: import('magic-string').SourceMap } | null}
 */
export function transformJsx(code, id, root) {
    if (id.startsWith('\0')) return null;
    const file = id.split('?')[0];
    const ext = path.extname(file);
    if (ext !== '.tsx' && ext !== '.jsx') return null;
    if (file.includes('/node_modules/') || file.includes('\\node_modules\\')) return null;
    if (!code.includes('<')) return null;

    let ast;
    try {
        ast = parse(code, {
            sourceType: 'module',
            plugins: ext === '.tsx' ? ['jsx', 'typescript'] : ['jsx'],
        });
    } catch (_) {
        return null; // the next plugin reports the syntax error
    }

    const rel = path.relative(root, file).split(path.sep).join('/');
    const s = new MagicString(code);
    let changed = false;
    walk(ast.program, (el) => {
        if (el.name.type !== 'JSXIdentifier' || !el.name.name || !/^[a-z]/.test(el.name.name)) return;
        if (el.attributes.some((a) => a.type === 'JSXAttribute' && a.name?.name === ATTR)) return;
        if (el.name.end == null || !el.loc) return;
        s.appendLeft(el.name.end, ` ${ATTR}="${rel}:${el.loc.start.line}"`);
        changed = true;
    });
    if (!changed) return null;
    return { code: s.toString(), map: s.generateMap({ source: file, includeContent: true, hires: 'boundary' }) };
}
