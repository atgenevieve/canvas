// `canvas repro` against golden files, from a fixture capture with every kind of step and masked values, and the
// faker's shapes. UPDATE_GOLDEN=1 rewrites the golden files.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeStep, showValue } from '../src/cli-capture.mjs';
import { fakeOne, faker } from '../src/cli-fake.mjs';
import { q, repro } from '../src/cli-repro.mjs';
import type { Capture } from '../../shared/contract.ts';

const fixture = (name: string) => new URL('./fixtures/' + name, import.meta.url);
const capture = JSON.parse(fs.readFileSync(fixture('capture.json'), 'utf8')) as Capture;

const golden = (name: string, actual: string) => {
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(fixture(name), actual);
    expect(actual).toBe(fs.readFileSync(fixture(name), 'utf8'));
};

describe('canvas repro', () => {
    it('covers every kind of step in the fixture', () => {
        expect(new Set(capture.steps.map((s) => s.kind))).toEqual(new Set(['click', 'input', 'change', 'key', 'nav', 'scroll', 'resize']));
    });

    it('writes the test, with typed values as recorded and masked ones as x’s', () => {
        golden('repro.golden', repro(capture, { id: 'ab3k9m2x', base: 'https://preview.example.org/' }));
    });

    it('swaps typed values for fakes with --fictional, keeping selects’ options', () => {
        const out = repro(capture, { id: 'ab3k9m2x', base: 'https://preview.example.org', fictional: true });
        golden('repro-fictional.golden', out);
        for (const typed of ['ruth.adeyemi@example.org', '(212) 555-0147', "fill('4821')", "fill('Ruth Adeyemi')", 'call after the meeting']) expect(out).not.toContain(typed);
        expect(out).toContain("selectOption('green')");
    });

    it('starts on the comment’s page when the steps don’t begin with a load, and handles a capture with no element', () => {
        const out = repro({ ...capture, element: null, area: { x: 1, y: 2, w: 30, h: 40 }, steps: [capture.steps[13]] }, { id: 'ab3k9m2x', base: 'https://preview.example.org' });
        expect(out).toContain("await page.goto(BASE + '/people/4821?tab=notes');");
        expect(out).toContain('was not recorded');
        expect(out).toContain('// the comment was made on an area: 30 x 40 at 1, 2');
        expect(out).not.toContain('toBeVisible');
        expect(out).not.toContain('async function click');
    });

    it('quotes strings safely', () => {
        expect(q("it's \"x\"\n")).toBe("'it\\'s \"x\"\\n'");
    });

    it('describes masked values by length only', () => {
        expect(showValue({ masked: true, length: 12 })).toBe('•••• (12 chars)');
        expect(describeStep(capture.steps[8])).toBe('type •••• (12 chars) into Password (#password)');
    });
});

describe('the faker', () => {
    it('keeps emails as example.org emails', () => {
        expect(fakeOne('ruth.adeyemi@example.net')).toBe('jordan.alvarez@example.org');
        expect(fakeOne('sam@example.net', 3)).toMatch(/^[a-z.]+@example\.org$/);
        expect(fakeOne('sam@example.net', 9)).toMatch(/^[a-z.]+9@example\.org$/);
    });

    it('keeps a phone’s format, as a 555 number', () => {
        expect(fakeOne('(718) 555-0199')).toBe('(212) 555-0100');
        expect(fakeOne('718.555.0199', 7)).toBe('212.555.0107');
        expect(fakeOne('+1 718 555 0199')).toBe('+1 212 555 0100');
        expect(fakeOne('7185550199')).toBe('2125550100');
        expect(fakeOne('555-0199')).toBe('555-0100');
    });

    it('keeps numbers’ digit counts and punctuation, never leading with zero', () => {
        expect(fakeOne('4821')).toBe('1234');
        expect(fakeOne('90210', 8)).toBe('91234');
        expect(fakeOne('12.50')).toBe('12.34');
        expect(fakeOne('1990-04-17')).toBe('2000-01-01');
        expect(fakeOne('4/17/1990', 2)).toBe('01/03/2000');
        expect(fakeOne('4/17/90')).toBe('01/01/00');
        for (let n = 0; n < 20; n++) expect(fakeOne('500', n)).toMatch(/^[1-9]\d\d$/);
    });

    it('gives names a fictional name of as many words, and other text fictional words', () => {
        expect(fakeOne('Ruth')).toBe('Jordan');
        expect(fakeOne('Ruth Adeyemi', 1)).toBe('Ruth Adeyemi');
        expect(fakeOne('Mary Ann Smith')).toBe('Jordan Ruth Alvarez');
        expect(fakeOne('call after the meeting')).toBe('maple river lantern orbit');
        expect(fakeOne('Call me')).toBe('Maple river');
        expect(fakeOne('')).toBe('');
    });

    it('gives the same value the same fake, and different values different fakes', () => {
        const fake = faker();
        const a = fake('lee@example.com');
        expect(fake('sam@example.com')).not.toBe(a);
        expect(fake('lee@example.com')).toBe(a);
    });
});
