// @ts-check
// Fictional stand-ins for typed values, for `canvas repro --fictional`: each keeps the shape of what it replaces (an
// email stays an email, a date a date, a phone keeps its format with a 555 number, a number keeps its digit count, a
// name its word count), so a test still exercises the same validation. Deterministic: the same value always gets the same fake
// within one faker, and the nth distinct value gets the nth fake, so a golden file stays stable.

const FIRST = ['Jordan', 'Ruth', 'Sam', 'Priya', 'Mateo', 'Ada', 'Kofi', 'Lena'];
const LAST = ['Alvarez', 'Adeyemi', 'Okafor', 'Nakamura', 'Lindqvist', 'Moreau', 'Haddad', 'Kowalski'];
const WORDS = ['maple', 'river', 'lantern', 'orbit', 'quill', 'harbor', 'meadow', 'pebble', 'cedar', 'violet'];
const DIGITS = '123456789';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]+$/;
const NUMERIC = /^[\d\s.,:/+-]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^\d{1,2}\/\d{1,2}\/(\d{2}|\d{4})$/;
const NAME = /^\p{Lu}[\p{L}'-]*( \p{Lu}[\p{L}'-]*){0,3}$/u;

const digitCount = (/** @type {string} */ s) => (s.match(/\d/g) || []).length;
const isPhone = (/** @type {string} */ s) => {
    const n = digitCount(s);
    return PHONE.test(s) && n >= 7 && n <= 15 && (/\D/.test(s) || n === 10 || n === 11);
};

/** Rewrites each digit of `s` in order from `digits`, keeping everything else. */
const redigit = (/** @type {string} */ s, /** @type {string} */ digits) => {
    let i = 0;
    return s.replace(/\d/g, () => digits[i++ % digits.length]);
};

/** A same-case copy of `word` taken from `like`'s first letter. */
const caseLike = (/** @type {string} */ word, /** @type {string} */ like) =>
    /^\p{Lu}/u.test(like) ? word[0].toUpperCase() + word.slice(1) : word;

/** One fake for a typed value, the nth (from 0) distinct value faked. */
export function fakeOne(/** @type {string} */ value, n = 0) {
    const s = value.trim();
    if (!s) return value;
    const first = FIRST[n % FIRST.length];
    const last = LAST[(n + Math.floor(n / LAST.length)) % LAST.length];
    if (EMAIL.test(s)) return (first + '.' + last).toLowerCase() + (n >= FIRST.length ? n : '') + '@example.org';
    // a date stays a real date, in the same layout
    const day = String(1 + (n % 28)).padStart(2, '0');
    if (ISO_DATE.test(s)) return '2000-01-' + day;
    if (US_DATE.test(s)) return '01/' + day + '/' + (s.length - s.lastIndexOf('/') === 3 ? '00' : '2000');
    if (isPhone(s)) {
        const count = digitCount(s);
        // the last seven are 555-01xx (the range kept for fiction); before them, 212 and a leading 1 as needed
        const tail = '55501' + String(n % 100).padStart(2, '0');
        const head = count > 7 ? ('1'.repeat(Math.max(0, count - 10)) + '212').slice(-(count - 7)) : '';
        return redigit(s, (head + tail).slice(-count));
    }
    if (NUMERIC.test(s) && /\d/.test(s)) {
        // same digit count, never a zero, so a leading digit stays non-zero and the number keeps its size
        const shift = n % DIGITS.length;
        return redigit(s, DIGITS.slice(shift) + DIGITS.slice(0, shift));
    }
    if (NAME.test(s)) {
        const words = s.split(' ').length;
        if (words === 1) return first;
        return [first, ...Array.from({ length: words - 2 }, (_, i) => FIRST[(n + i + 1) % FIRST.length]), last].join(' ');
    }
    return s
        .split(/(\s+)/)
        .map((part, i) => (/^\s+$/.test(part) ? part : caseLike(WORDS[(n + i / 2) % WORDS.length], part)))
        .join('');
}

/** A faker that gives each distinct value its own fake, the same one each time it's seen. */
export function faker() {
    /** @type {Map<string, string>} */
    const seen = new Map();
    return (/** @type {string} */ value) => {
        let fake = seen.get(value);
        if (fake === undefined) seen.set(value, (fake = fakeOne(value, seen.size)));
        return fake;
    };
}
