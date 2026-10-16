// @ts-check
// `canvas repro`: a Playwright test (TypeScript) that replays a capture's steps on the app and ends on the element
// the comment was made on, for Claude to finish with the assertion the comment asks for.
//
// Typed values go in as recorded unless `fictional` is set, when each becomes a fake of the same shape
// (cli-fake.mjs); an option picked in a select stays, as the app's own. Masked values were never recorded: they go in as x's of the same length, marked for a test value.
import { pathOf } from './cli-capture.mjs';
import { faker } from './cli-fake.mjs';

/**
 * @typedef {import('../../shared/contract.ts').Capture} Capture
 * @typedef {import('../../shared/contract.ts').Step} Step
 * @typedef {import('../../shared/contract.ts').Value} Value
 */

/** A single-quoted TypeScript string. */
export const q = (/** @type {string} */ s) => "'" + JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";

/**
 * The test's source.
 * @param {Capture} c
 * @param {{ id: string, base: string, fictional?: boolean }} o  base: the app's address, config's "url"
 */
export function repro(c, { id, base, fictional = false }) {
    const fake = fictional ? faker() : (/** @type {string} */ v) => v;
    const I = '    ';
    /** @type {string[]} */
    const body = [];
    const add = (/** @type {string} */ line) => body.push(I + line);
    const at = (/** @type {string} */ url) => 'BASE + ' + q(pathOf(url));
    const loc = (/** @type {string} */ sel) => 'page.locator(' + q(sel) + ')';
    /** a value for fill (typed: faked with --fictional) or selectOption (an option: kept), with the comment it needs */
    const typed = (/** @type {Value} */ v, typing = true) =>
        typeof v === 'object'
            ? { code: q('x'.repeat(v.length)), note: ' // masked (' + v.length + ' chars): put a test value here' }
            : { code: q(typing ? fake(String(v)) : String(v)), note: '' };

    const steps = [...c.steps];
    const first = steps[0];
    const start = first?.kind === 'nav' ? (steps.shift(), first.url) : c.env.url;
    const { w, h } = c.env.viewport;
    add('await page.setViewportSize({ width: ' + w + ', height: ' + h + ' });');
    add("await page.emulateMedia({ colorScheme: '" + c.env.scheme + "' });");
    if (first && first.kind !== 'nav') add('// the page the steps started on was not recorded; this is the one the comment was made on');
    add('await page.goto(' + at(start) + ');');

    for (const s of steps) {
        switch (s.kind) {
            case 'click':
                if (s.words) add('await click(page, ' + q(s.selector) + ', ' + q(s.words) + ');');
                else add('await ' + loc(s.selector) + '.click();');
                break;
            case 'input': {
                const v = typed(s.value);
                add('await ' + loc(s.selector) + '.fill(' + v.code + ');' + (s.label && !v.note ? ' // ' + s.label : v.note));
                break;
            }
            case 'change':
                if (typeof s.value === 'boolean') add('await ' + loc(s.selector) + '.' + (s.value ? 'check' : 'uncheck') + '();');
                else {
                    const v = typed(s.value, false);
                    add('await ' + loc(s.selector) + '.selectOption(' + v.code + ');' + (s.label && !v.note ? ' // ' + s.label : v.note));
                }
                break;
            case 'key':
                add('await page.keyboard.press(' + q(s.key) + ');');
                break;
            case 'nav':
                if (s.how === 'load') add('await page.goto(' + at(s.url) + ');');
                else if (s.how === 'pop') add('await page.goBack(); // back or forward, to ' + q(pathOf(s.url)));
                else add('await page.waitForURL(' + at(s.url) + ');');
                break;
            case 'scroll':
                if (s.selector === 'window') add('await page.evaluate(() => window.scrollTo(' + s.x + ', ' + s.y + '));');
                else add('await ' + loc(s.selector) + '.evaluate((el) => el.scrollTo(' + s.x + ', ' + s.y + '));');
                break;
            case 'resize':
                add('await page.setViewportSize({ width: ' + s.w + ', height: ' + s.h + ' });');
                break;
        }
    }

    add('');
    const el = c.element;
    if (el) {
        add('// the comment was made on ' + (el.words ? q(el.words) : 'this element') + (el.component ? ', ' + el.component : '') + (el.source ? ' at ' + el.source : ''));
        add('await expect(' + loc(el.selector) + ').toBeVisible();');
    } else if (c.area) {
        add('// the comment was made on an area: ' + c.area.w + ' x ' + c.area.h + ' at ' + c.area.x + ', ' + c.area.y);
    } else if (c.point) {
        add('// the comment was made on a point: ' + c.point.x + ', ' + c.point.y);
    }
    add('// TODO: assert what the comment asks for (`canvas show ' + id + '`).');

    const clicks = steps.some((s) => s.kind === 'click' && s.words);
    return [
        '// canvas repro ' + id + ': the steps recorded before the comment, replayed.',
        '// Selectors, words and URLs come from the page' + (fictional ? '' : ', typed values from the person') + ': check them for real data before committing.',
        "import { expect, test" + (clicks ? ', type Page' : '') + " } from '@playwright/test';",
        '',
        'const BASE = process.env.BASE_URL ?? ' + q(base.replace(/\/+$/, '')) + ';',
        ...(clicks
            ? [
                  '',
                  '/** Clicks the recorded selector, or the recorded words when the selector no longer finds one element. */',
                  'async function click(page: Page, selector: string, words: string) {',
                  '    const el = page.locator(selector);',
                  '    if ((await el.count()) === 1) return el.click();',
                  '    return page.getByText(words, { exact: true }).first().click();',
                  '}',
              ]
            : []),
        '',
        'test(' + q('canvas ' + id) + ', async ({ page }) => {',
        ...body.map((l) => (l.trim() ? l : '')),
        '});',
        '',
    ].join('\n');
}
