// @vitest-environment happy-dom
// The overlay's recorder, its DOM helpers and replay, on happy-dom: the steps each action writes, the ring buffer, the
// errors and failed requests, masking (docs/CONTRACT.md "Masking"), selectors and words, and replaying steps.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STEP_AGE_MS, MAX_STEPS } from '../../shared/contract.ts';
import type { Step } from '../../shared/contract.ts';
import { isMasked, isPrivate, labelOf, selectorFor, valueOf, wordsOf } from '../src/overlay/dom.ts';
import { startRecorder, type Recorder } from '../src/overlay/recorder.ts';
import { replay } from '../src/overlay/replay.ts';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    el.focus();
    for (let i = 1; i <= value.length; i++) {
        el.value = value.slice(0, i);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
}
function blur(el: HTMLElement): void {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}
function key(el: Element, k: string): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
}
const kinds = (steps: Step[]) => steps.map((s) => s.kind);

let rec: Recorder | null = null;
function start(opts?: Parameters<typeof startRecorder>[0]): Recorder {
    rec = startRecorder(opts);
    return rec;
}

beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState(null, '', '/start');
});
afterEach(() => {
    rec?.stop();
    rec = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('selectorFor', () => {
    it('prefers data-testid, then #id', () => {
        document.body.innerHTML = '<button id="save" data-testid="save-btn">Save</button><button id="cancel">Cancel</button>';
        expect(selectorFor($('#save'))).toBe('[data-testid="save-btn"]');
        expect(selectorFor($('#cancel'))).toBe('#cancel');
    });

    it('builds a short tag.class:nth-of-type path from the nearest anchor', () => {
        document.body.innerHTML = `
            <ul data-testid="people">
                <li class="row"><button class="chip">Jordan Alvarez</button></li>
                <li class="row"><button class="chip">Ruth Adeyemi</button></li>
            </ul>`;
        const second = document.querySelectorAll('button')[1];
        const sel = selectorFor(second);
        expect(sel).toBe('[data-testid="people"] > li.row:nth-of-type(2) > button.chip');
        expect(document.querySelector(sel)).toBe(second);
    });

    it('keeps the path as short as still finds the element', () => {
        document.body.innerHTML = `<main id="app"><section><div><p class="note">One</p><span class="tag">Two</span></div></section></main>`;
        const sel = selectorFor($('span'));
        expect(sel).toBe('#app span.tag');
        expect(document.querySelector(sel)).toBe($('span'));
    });

    it('works with no anchor, leaves generated classes out, and escapes odd ids', () => {
        document.body.innerHTML = `<div><p class="css-1x2y345 lead">A</p><p class="lead">B</p></div><div id="1:weird"><b>C</b></div>`;
        const second = document.querySelectorAll('p')[1];
        const sel = selectorFor(second);
        expect(sel).not.toContain('css-1x2y345');
        expect(document.querySelector(sel)).toBe(second);
        const weird = selectorFor($('[id="1:weird"]'));
        expect(document.querySelector(weird)).toBe($('[id="1:weird"]'));
        expect(document.querySelector(selectorFor($('b')))).toBe($('b'));
    });

    it('skips a duplicated id', () => {
        document.body.innerHTML = '<div><i id="dup">a</i></div><div><i id="dup">b</i></div>';
        const second = document.querySelectorAll('i')[1];
        expect(document.querySelector(selectorFor(second))).toBe(second);
    });
});

describe('wordsOf and labelOf', () => {
    it('reads visible text, collapsed, first 120 characters', () => {
        document.body.innerHTML = `<div id="card"><h2>Jordan   Alvarez</h2><p>Organizer</p><p hidden>secret</p><script>x()</script><span style="display:none">gone</span></div>`;
        expect(wordsOf($('#card'))).toBe('Jordan Alvarez Organizer');
        document.body.innerHTML = `<p id="long">${'word '.repeat(60)}</p>`;
        expect(wordsOf($('#long')).length).toBe(120);
    });

    it('labels a field from <label>, aria-labelledby, aria-label, placeholder, then name', () => {
        document.body.innerHTML = `
            <label for="a">Email</label><input id="a">
            <label>Phone <input id="b"></label>
            <span id="lab">Branch</span><input id="c" aria-labelledby="lab">
            <input id="d" aria-label="Search">
            <input id="e" placeholder="Notes">
            <input id="f" name="zip">
            <input id="g">
            <label>Role <select id="h"><option>Chair</option></select></label>`;
        expect(labelOf($('#a'))).toBe('Email');
        expect(labelOf($('#b'))).toBe('Phone');
        expect(labelOf($('#c'))).toBe('Branch');
        expect(labelOf($('#d'))).toBe('Search');
        expect(labelOf($('#e'))).toBe('Notes');
        expect(labelOf($('#f'))).toBe('zip');
        expect(labelOf($('#g'))).toBeUndefined();
        expect(labelOf($('#h'))).toBe('Role');
    });
});

describe('masking', () => {
    it.each([
        ['type=password', '<input id="f" type="password">'],
        ['type=hidden', '<input id="f" type="hidden">'],
        ['autocomplete=cc-number', '<input id="f" autocomplete="cc-number">'],
        ['autocomplete=cc-csc', '<input id="f" autocomplete="cc-csc">'],
        ['autocomplete with a section token', '<input id="f" autocomplete="billing cc-exp">'],
        ['autocomplete=new-password', '<input id="f" autocomplete="new-password">'],
        ['autocomplete=current-password', '<input id="f" autocomplete="CURRENT-PASSWORD">'],
        ['autocomplete on the form', '<form autocomplete="new-password"><input id="f"></form>'],
        ['data-canvas-private on the field', '<input id="f" data-canvas-private>'],
        ['data-canvas-private on an ancestor', '<div data-canvas-private><label>Note <input id="f"></label></div>'],
        ['a private textarea', '<section data-canvas-private=""><textarea id="f"></textarea></section>'],
    ])('masks %s', (_name, html) => {
        document.body.innerHTML = html;
        const f = $<HTMLInputElement>('#f');
        f.value = 'Ruth Adeyemi';
        expect(isMasked(f)).toBe(true);
        expect(valueOf(f)).toEqual({ masked: true, length: 12 });
    });

    it.each([
        ['a plain field', '<input id="f">'],
        ['autocomplete=email', '<input id="f" autocomplete="email">'],
        ['autocomplete=name', '<input id="f" autocomplete="name">'],
        ['type=email', '<input id="f" type="email">'],
        ['a private sibling', '<div data-canvas-private></div><input id="f">'],
    ])('leaves %s as typed', (_name, html) => {
        document.body.innerHTML = html;
        const f = $<HTMLInputElement>('#f');
        f.value = 'jordan@example.org';
        expect(isMasked(f)).toBe(false);
        expect(valueOf(f)).toBe('jordan@example.org');
    });

    it('masks private selects, checkboxes and contenteditable', () => {
        document.body.innerHTML = `<div data-canvas-private>
            <select id="s"><option value="yes">Yes</option></select>
            <input id="c" type="checkbox" checked>
            <div id="e" contenteditable="true">Ruth</div></div>`;
        expect(valueOf($('#s'))).toEqual({ masked: true, length: 3 });
        expect(valueOf($('#c'))).toEqual({ masked: true, length: 0 });
        expect(valueOf($('#e'))).toEqual({ masked: true, length: 4 });
    });

    it('leaves private text out of words, and private elements read as empty', () => {
        document.body.innerHTML = `<li id="row"><span>Member</span> <span data-canvas-private>Ruth Adeyemi</span> <b>active</b></li>`;
        expect(wordsOf($('#row'))).toBe('Member active');
        expect(wordsOf($('[data-canvas-private]'))).toBe('');
        expect(isPrivate($('[data-canvas-private]'))).toBe(true);
        expect(isPrivate($('b'))).toBe(false);
    });

    it('leaves a private label out of the field label', () => {
        document.body.innerHTML = `<label data-canvas-private>Ruth's note <input id="f"></label>`;
        expect(labelOf($('#f'))).toBeUndefined();
    });

    it('records masked input steps with the length only', () => {
        document.body.innerHTML = `<input id="pw" type="password"><div data-canvas-private><textarea id="note"></textarea></div><input id="ok">`;
        const r = start();
        typeInto($('#pw'), 'hunter22');
        typeInto($('#note'), 'Lives on Elm St');
        typeInto($('#ok'), 'hello');
        blur($('#ok'));
        const inputs = r.steps().filter((s) => s.kind === 'input');
        expect(inputs.map((s) => s.kind === 'input' && s.value)).toEqual([
            { masked: true, length: 8 },
            { masked: true, length: 15 },
            'hello',
        ]);
        expect(JSON.stringify(r.steps())).not.toMatch(/hunter|Elm St/);
    });

    it('records clicks on private elements without their words', () => {
        document.body.innerHTML = `<ul><li data-canvas-private><button id="p">Ruth Adeyemi</button></li><li><button id="q">Open <i data-canvas-private>Ruth</i></button></li></ul>`;
        const r = start();
        $('#p').click();
        $('#q').click();
        const clicks = r.steps().filter((s) => s.kind === 'click');
        expect(clicks.map((s) => s.kind === 'click' && s.words)).toEqual(['', 'Open']);
        expect(JSON.stringify(r.steps())).not.toContain('Ruth');
    });

    it('masks private choices in change steps', () => {
        document.body.innerHTML = `<div data-canvas-private><select id="s"><option value="a">A</option><option value="bb">B</option></select></div>`;
        const r = start();
        const s = $<HTMLSelectElement>('#s');
        s.value = 'bb';
        s.dispatchEvent(new Event('change', { bubbles: true }));
        expect(r.steps().at(-1)).toMatchObject({ kind: 'change', value: { masked: true, length: 2 } });
    });
});

describe('recorder steps', () => {
    it('starts with the load', () => {
        const r = start();
        expect(r.steps()).toEqual([{ kind: 'nav', t: expect.any(Number), url: 'http://localhost:3000/start', how: 'load' }]);
    });

    it('records clicks with selector, words and position', () => {
        document.body.innerHTML = '<button data-testid="go">Go <b>now</b></button>';
        const r = start();
        $('b').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10.4, clientY: 20.6 }));
        expect(r.steps().at(-1)).toEqual({ kind: 'click', t: expect.any(Number), selector: '[data-testid="go"] > b', words: 'now', x: 10, y: 21 });
    });

    it('writes one input step per field per focus, on blur or when another step comes', () => {
        document.body.innerHTML = '<label for="n">Name</label><input id="n"><input id="e" placeholder="Email"><button>Save</button>';
        const r = start();
        typeInto($('#n'), 'Jordan');
        // Not written yet, but steps() shows it as it stands.
        expect(r.steps().at(-1)).toMatchObject({ kind: 'input', selector: '#n', label: 'Name', value: 'Jordan' });
        typeInto($('#e'), 'jordan@example.org');
        $('button').click();
        typeInto($('#n'), 'Jordan Alvarez');
        blur($('#n'));
        typeInto($('#n'), 'J. Alvarez');
        expect(kinds(r.steps())).toEqual(['nav', 'input', 'input', 'click', 'input', 'input']);
        const values = r.steps().flatMap((s) => (s.kind === 'input' ? [s.value] : []));
        expect(values).toEqual(['Jordan', 'jordan@example.org', 'Jordan Alvarez', 'J. Alvarez']);
    });

    it('records changes for selects, checkboxes and radios, not text fields', () => {
        document.body.innerHTML = `
            <select id="s" aria-label="Branch"><option value="bk">Brooklyn</option><option value="qn">Queens</option></select>
            <input id="c" type="checkbox" name="agree">
            <input id="r" type="radio" name="vote" value="yes">
            <input id="t">`;
        const r = start();
        const s = $<HTMLSelectElement>('#s');
        s.value = 'qn';
        s.dispatchEvent(new Event('change', { bubbles: true }));
        $('#c').click();
        $('#r').click();
        $('#t').dispatchEvent(new Event('change', { bubbles: true }));
        const changes = r.steps().filter((x) => x.kind === 'change');
        expect(changes).toEqual([
            { kind: 'change', t: expect.any(Number), selector: '#s', label: 'Branch', value: 'qn' },
            { kind: 'change', t: expect.any(Number), selector: '#c', label: 'agree', value: true },
            { kind: 'change', t: expect.any(Number), selector: '#r', label: 'vote', value: true },
        ]);
    });

    it('records only certain keys, and only outside text fields', () => {
        document.body.innerHTML = '<div id="list" tabindex="0"></div><input id="t"><textarea id="ta"></textarea><div id="ce" contenteditable="true"></div>';
        const r = start();
        for (const k of ['Enter', 'a', 'ArrowDown', 'Shift', 'Escape']) key($('#list'), k);
        key($('#t'), 'Enter');
        key($('#ta'), 'Backspace');
        key($('#ce'), 'Delete');
        key(document.body, 'Tab');
        const keys = r.steps().filter((s) => s.kind === 'key');
        expect(keys).toEqual([
            { kind: 'key', t: expect.any(Number), key: 'Enter', selector: '#list' },
            { kind: 'key', t: expect.any(Number), key: 'ArrowDown', selector: '#list' },
            { kind: 'key', t: expect.any(Number), key: 'Escape', selector: '#list' },
            { kind: 'key', t: expect.any(Number), key: 'Tab' },
        ]);
    });

    it('records history push, replace and pop, and restores history on stop', () => {
        const push = history.pushState;
        const r = start();
        history.pushState(null, '', '/people?tab=open');
        history.replaceState(null, '', '/people?tab=all');
        window.dispatchEvent(new PopStateEvent('popstate'));
        const navs = r.steps().flatMap((s) => (s.kind === 'nav' ? [[s.how, new URL(s.url).pathname + new URL(s.url).search]] : []));
        expect(navs).toEqual([
            ['load', '/start'],
            ['push', '/people?tab=open'],
            ['replace', '/people?tab=all'],
            ['pop', '/people?tab=all'],
        ]);
        r.stop();
        rec = null;
        expect(history.pushState).toBe(push);
    });

    it('records a scroll once it rests 300ms, only past 100px', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="pane" style="overflow:auto;height:100px"><div style="height:2000px"></div></div>';
        const r = start();
        const pane = $('#pane');
        const scrollTo = (y: number) => {
            pane.scrollTop = y;
            pane.dispatchEvent(new Event('scroll'));
        };
        scrollTo(40);
        vi.advanceTimersByTime(200);
        scrollTo(80);
        vi.advanceTimersByTime(300);
        expect(kinds(r.steps())).toEqual(['nav']); // only 80px
        scrollTo(150);
        vi.advanceTimersByTime(299);
        expect(kinds(r.steps())).toEqual(['nav']);
        vi.advanceTimersByTime(1);
        expect(r.steps().at(-1)).toEqual({ kind: 'scroll', t: expect.any(Number), selector: '#pane', x: 0, y: 150 });
        scrollTo(200); // 50px from the last one written
        vi.advanceTimersByTime(300);
        expect(r.steps().filter((s) => s.kind === 'scroll')).toHaveLength(1);
    });

    it('records window scrolls, and writes a resting scroll before the next step', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<button>Next</button>';
        const r = start();
        window.scrollTo(0, 500);
        document.dispatchEvent(new Event('scroll'));
        $('button').click();
        expect(kinds(r.steps())).toEqual(['nav', 'scroll', 'click']);
        expect(r.steps()[1]).toMatchObject({ selector: 'window', y: 500 });
    });

    it('records a resize once it settles', () => {
        vi.useFakeTimers();
        const r = start();
        Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(300);
        expect(r.steps().filter((s) => s.kind === 'resize')).toEqual([{ kind: 'resize', t: expect.any(Number), w: 390, h: 844 }]);
    });

    it('ignores the overlay’s own elements', () => {
        document.body.innerHTML = '<div data-overlay><button>Comment</button></div><button id="app">App</button>';
        const r = start({ ignore: (el) => !!el.closest('[data-overlay]') });
        $('[data-overlay] button').click();
        $('#app').click();
        expect(r.steps().filter((s) => s.kind === 'click')).toHaveLength(1);
    });

    it('stops listening on stop', () => {
        document.body.innerHTML = '<button>Go</button>';
        const r = start();
        r.stop();
        rec = null;
        $('button').click();
        expect(kinds(r.steps())).toEqual(['nav']);
    });
});

describe('the ring buffer', () => {
    it(`keeps the last ${MAX_STEPS} steps`, () => {
        document.body.innerHTML = '<button>Go</button>';
        const r = start();
        for (let i = 0; i < MAX_STEPS + 20; i++) $('button').click();
        const steps = r.steps();
        expect(steps).toHaveLength(MAX_STEPS);
        expect(kinds(steps).every((k) => k === 'click')).toBe(true);
    });

    it('drops steps older than five minutes', () => {
        let clock = 1_000_000;
        document.body.innerHTML = '<button>Go</button>';
        const r = start({ now: () => clock });
        $('button').click();
        clock += MAX_STEP_AGE_MS - 1000;
        $('button').click();
        expect(r.steps()).toHaveLength(3);
        clock += 2000;
        expect(r.steps().map((s) => s.t)).toEqual([1_000_000 + MAX_STEP_AGE_MS - 1000]);
    });
});

describe('errors and failed requests', () => {
    it('records console errors, window errors and unhandled rejections', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const r = start();
        console.error('Save failed:', new TypeError('x is undefined'));
        window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught boom', error: new Error('boom') }));
        const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
        rejection.reason = new Error('no network');
        window.dispatchEvent(rejection);
        const errors = r.errors();
        expect(errors.map((e) => e.message)).toEqual(['Save failed: TypeError: x is undefined', 'Error: boom', 'Unhandled rejection: Error: no network']);
        expect(errors.every((e) => typeof e.stack === 'string')).toBe(true);
    });

    it('records failed fetches and network errors with method, url, status, ms and no bodies', async () => {
        const fake = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes('down')) throw new TypeError('Failed to fetch');
            if (url.includes('abort')) throw new DOMException('aborted', 'AbortError');
            return new Response('{"name":"Ruth Adeyemi"}', { status: url.includes('missing') ? 404 : 200 });
        });
        window.fetch = fake as typeof fetch;
        const r = start();
        await fetch('/api/ok');
        await fetch('/api/missing', { method: 'post', body: 'secret body' });
        await expect(fetch('https://elsewhere.example.org/down')).rejects.toThrow('Failed to fetch');
        await expect(fetch('/api/abort')).rejects.toThrow();
        await fetch('/__canvas/api/missing');
        expect(r.failed()).toEqual([
            { t: expect.any(Number), method: 'POST', url: 'http://localhost:3000/api/missing', status: 404, ms: expect.any(Number) },
            { t: expect.any(Number), method: 'GET', url: 'https://elsewhere.example.org/down', status: 0, ms: expect.any(Number) },
        ]);
        expect(JSON.stringify(r.failed())).not.toMatch(/secret|Ruth/);
        r.stop();
        rec = null;
        expect(window.fetch).toBe(fake);
    });

    it('records failed XHRs', async () => {
        vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
        const r = start();
        const xhr = new XMLHttpRequest();
        xhr.open('DELETE', '/api/people/7');
        Object.defineProperty(xhr, 'status', { value: 500 });
        xhr.send();
        xhr.dispatchEvent(new ProgressEvent('loadend'));
        expect(r.failed()).toEqual([{ t: expect.any(Number), method: 'DELETE', url: 'http://localhost:3000/api/people/7', status: 500, ms: expect.any(Number) }]);
    });
});

describe('replay', () => {
    it('replays clicks, typing, choices, keys and scrolls', async () => {
        document.body.innerHTML = `
            <button id="open">Open</button>
            <input id="name"><input id="pw" type="password">
            <select id="branch"><option value="bk">Brooklyn</option><option value="qn">Queens</option></select>
            <input id="agree" type="checkbox">
            <div id="pane" style="overflow:auto;height:50px"><div style="height:1000px"></div></div>`;
        const seen: string[] = [];
        $('#open').addEventListener('click', () => seen.push('click'));
        $('#name').addEventListener('input', (e) => seen.push(`input:${(e.target as HTMLInputElement).value}`));
        $('#agree').addEventListener('change', () => seen.push('agree'));
        document.addEventListener('keydown', (e) => seen.push(`key:${e.key}`));
        const steps: Step[] = [
            { kind: 'nav', t: 1, url: location.href, how: 'load' },
            { kind: 'click', t: 2, selector: '#open', words: 'Open', x: 0, y: 0 },
            { kind: 'input', t: 3, selector: '#name', value: 'Jordan Alvarez' },
            { kind: 'input', t: 4, selector: '#pw', value: { masked: true, length: 8 } },
            { kind: 'change', t: 5, selector: '#branch', value: 'qn' },
            { kind: 'change', t: 6, selector: '#agree', value: true },
            { kind: 'key', t: 7, key: 'Escape' },
            { kind: 'scroll', t: 8, selector: '#pane', x: 0, y: 300 },
            { kind: 'resize', t: 9, w: 390, h: 844 },
        ];
        expect(await replay(steps, { pause: 0 })).toEqual({ ok: true });
        expect(seen).toEqual(['click', 'input:Jordan Alvarez', 'agree', 'key:Escape']);
        expect($<HTMLInputElement>('#name').value).toBe('Jordan Alvarez');
        expect($<HTMLInputElement>('#pw').value).toBe('');
        expect($<HTMLSelectElement>('#branch').value).toBe('qn');
        expect($<HTMLInputElement>('#agree').checked).toBe(true);
        expect($('#pane').scrollTop).toBe(300);
    });

    it('navigates within the app with pushState and popstate', async () => {
        const pops: string[] = [];
        window.addEventListener('popstate', () => pops.push(location.pathname));
        const result = await replay([{ kind: 'nav', t: 1, url: '/people?tab=open', how: 'push' }], { pause: 0 });
        expect(result).toEqual({ ok: true });
        expect(location.pathname + location.search).toBe('/people?tab=open');
        expect(pops).toEqual(['/people']);
        expect(await replay([{ kind: 'nav', t: 1, url: 'https://elsewhere.example.org/', how: 'push' }], { pause: 0 })).toEqual({ ok: false, failedAt: 0 });
    });

    it('waits for an element that appears later', async () => {
        setTimeout(() => (document.body.innerHTML = '<button id="late">Late</button>'), 100);
        expect(await replay([{ kind: 'click', t: 1, selector: '#late', words: '', x: 0, y: 0 }], { pause: 0, timeout: 1000 })).toEqual({ ok: true });
    });

    it('reports the step whose element never shows', async () => {
        document.body.innerHTML = '<button id="a">A</button>';
        const steps: Step[] = [
            { kind: 'click', t: 1, selector: '#a', words: 'A', x: 0, y: 0 },
            { kind: 'click', t: 2, selector: '#missing', words: '', x: 0, y: 0 },
            { kind: 'click', t: 3, selector: '#a', words: 'A', x: 0, y: 0 },
        ];
        expect(await replay(steps, { pause: 0, timeout: 150 })).toEqual({ ok: false, failedAt: 1 });
    });

    it('replays what the recorder recorded', async () => {
        document.body.innerHTML = '<input id="q" aria-label="Search"><button data-testid="go">Go</button>';
        const r = start();
        typeInto($('#q'), 'Ruth');
        $('[data-testid="go"]').click();
        const steps = r.steps();
        r.stop();
        rec = null;
        $<HTMLInputElement>('#q').value = '';
        const clicked = vi.fn();
        $('[data-testid="go"]').addEventListener('click', clicked);
        expect(await replay(steps, { pause: 0 })).toEqual({ ok: true });
        expect($<HTMLInputElement>('#q').value).toBe('Ruth');
        expect(clicked).toHaveBeenCalledOnce();
    });
});
