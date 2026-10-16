// @ts-check
// A capture as `canvas show` prints it: the element, where it was made, the steps as a numbered list, console errors
// and failed requests. Masked values print as "•••• (12 chars)", never anything of the value itself.
/**
 * @typedef {import('../../shared/contract.ts').Capture} Capture
 * @typedef {import('../../shared/contract.ts').Step} Step
 * @typedef {import('../../shared/contract.ts').Value} Value
 */

/** A typed value as it reads in a step. */
export function showValue(/** @type {Value} */ v) {
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    if (typeof v === 'object') return '•••• (' + v.length + ' chars)';
    return JSON.stringify(v);
}

/** The path, query and hash of a URL (the whole of it if it doesn't parse). */
export function pathOf(/** @type {string} */ url) {
    try {
        const u = new URL(url);
        return u.pathname + u.search + u.hash;
    } catch {
        return url;
    }
}

const field = (/** @type {{ selector: string, label?: string }} */ s) => (s.label ? s.label + ' (' + s.selector + ')' : s.selector);

/** One step in words. */
export function describeStep(/** @type {Step} */ s) {
    switch (s.kind) {
        case 'click':
            return 'click ' + (s.words ? '"' + s.words + '" ' : '') + '(' + s.selector + ')';
        case 'input':
            return 'type ' + showValue(s.value) + ' into ' + field(s);
        case 'change':
            return (typeof s.value === 'boolean' ? 'turn ' : 'set ') + field(s) + ' ' + (typeof s.value === 'boolean' ? showValue(s.value) : 'to ' + showValue(s.value));
        case 'key':
            return 'press ' + s.key + (s.selector ? ' on ' + s.selector : '');
        case 'nav':
            return { load: 'load ', push: 'go to ', replace: 'replace with ', pop: 'back/forward to ' }[s.how] + pathOf(s.url);
        case 'scroll':
            return 'scroll ' + (s.selector === 'window' ? 'the page' : s.selector) + ' to ' + s.x + ', ' + s.y;
        case 'resize':
            return 'resize to ' + s.w + 'x' + s.h;
    }
}

const secs = (/** @type {number} */ ms) => (ms / 1000).toFixed(1) + 's';

/** The capture's lines, under headings. @param {Capture} c */
export function captureLines(c) {
    const lines = [];
    const el = c.element;
    lines.push('Element');
    if (el) {
        lines.push('  Selector:  ' + el.selector);
        lines.push('  Words:     ' + (el.words ? '"' + el.words + '"' : '(none)'));
        lines.push('  Tag:       ' + el.tag + (el.role ? ' (role ' + el.role + ')' : ''));
        if (el.component) lines.push('  Component: ' + el.component);
        if (el.source) lines.push('  Source:    ' + el.source);
        lines.push('  Box:       ' + el.rect.w + ' x ' + el.rect.h + ' at ' + el.rect.x + ', ' + el.rect.y);
    } else if (c.area) lines.push('  none (an area: ' + c.area.w + ' x ' + c.area.h + ' at ' + c.area.x + ', ' + c.area.y + ')');
    else if (c.point) lines.push('  none (a point: ' + c.point.x + ', ' + c.point.y + ')');
    else lines.push('  none picked');

    const e = c.env;
    lines.push('', 'Env');
    lines.push('  URL:       ' + e.url);
    lines.push('  Viewport:  ' + e.viewport.w + 'x' + e.viewport.h + ' @' + e.viewport.dpr + 'x, ' + e.scheme);
    if (e.branch || e.commit) lines.push('  Build:     ' + [e.branch, e.commit?.slice(0, 12)].filter(Boolean).join(' @ '));
    lines.push('  Browser:   ' + e.userAgent);
    lines.push('  At:        ' + e.at);

    const start = c.steps[0]?.t ?? 0;
    lines.push('', 'Steps' + (c.steps.length ? '' : ': none'));
    const pad = String(c.steps.length).length;
    c.steps.forEach((s, i) => lines.push('  ' + String(i + 1).padStart(pad) + '. +' + secs(s.t - start).padEnd(7) + describeStep(s)));

    lines.push('', 'Console errors' + (c.errors.length ? '' : ': none'));
    for (const err of c.errors) {
        lines.push('  +' + secs(err.t - start) + ' ' + err.message);
        const at = err.stack?.split('\n').find((l) => /^\s*at /.test(l));
        if (at) lines.push('      ' + at.trim());
    }

    lines.push('', 'Failed requests' + (c.failed.length ? '' : ': none'));
    for (const f of c.failed) lines.push('  ' + f.method + ' ' + f.url + ' → ' + (f.status || 'network error') + ' (' + f.ms + 'ms)');
    return lines;
}
