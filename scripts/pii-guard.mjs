#!/usr/bin/env node
// @ts-check
// Stops real people's data from being committed here (PLAN.md, "Privacy"). Tests and docs use fictional people
// ("Jordan Alvarez") and example.org emails.
//
//   node scripts/pii-guard.mjs --staged         what `git commit` would add (the pre-commit hook)
//   node scripts/pii-guard.mjs --msg <file>     a commit message (the commit-msg hook)
//   node scripts/pii-guard.mjs --all            every tracked file
//
// It checks added lines only, and fails on an email address outside the fictional and system domains below, or a US
// phone number outside the fictional 555 exchange. Findings are printed masked, so the check never copies a real
// value into a log. Never bypass it (--no-verify): remove the data instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });

const OK_DOMAINS =
    /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.example|[a-z0-9-]+\.test|[a-z0-9-]+\.invalid|localhost|anthropic\.com|users\.noreply\.github\.com|github\.com)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const PHONE = /(?<![\w.+-])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-](\d{4})(?![\w-])/g;

/** @type {string[]} */
const findings = [];
const mask = (/** @type {string} */ s) => (s.length <= 2 ? '**' : s[0] + '*'.repeat(Math.min(s.length - 2, 8)) + s.at(-1));

/** @param {string} text @param {string} where */
function checkText(text, where) {
    for (const m of text.matchAll(EMAIL))
        if (!OK_DOMAINS.test(m[1])) findings.push(`${where}: an email outside the fictional domains (${mask(m[0].toLowerCase())})`);
    for (const m of text.matchAll(PHONE)) if (m[2] !== '555') findings.push(`${where}: a phone number outside 555 (${mask(m[1] + m[2] + m[3])})`);
}

// added lines of a unified diff, with their file and line number
/** @param {string} diff */
function checkDiff(diff) {
    let file = null;
    let line = 0;
    for (const l of diff.split('\n')) {
        if (l.startsWith('+++ ')) file = l.slice(4).replace(/^b\//, '');
        else if (l.startsWith('@@')) line = Number(l.match(/\+(\d+)/)?.[1] ?? 0);
        else if (l.startsWith('+') && file) checkText(l.slice(1), `${file}:${line++}`);
        else if (!l.startsWith('-')) line++;
    }
}

const [mode, arg] = process.argv.slice(2);
if (mode === '--staged') checkDiff(git('diff', '--cached', '-U0', '--no-renames'));
else if (mode === '--msg') checkText(readFileSync(arg, 'utf8').replace(/^#.*$/gm, ''), 'the commit message');
else if (mode === '--all') {
    for (const p of git('ls-files').split('\n').filter(Boolean)) {
        let text;
        try {
            text = readFileSync(join(ROOT, p), 'utf8');
        } catch {
            continue;
        }
        if (!text.includes('\0')) text.split('\n').forEach((l, i) => checkText(l, `${p}:${i + 1}`));
    }
} else {
    console.error('usage: pii-guard.mjs --staged | --msg <file> | --all');
    process.exit(2);
}

if (findings.length) {
    const shown = [...new Set(findings)];
    console.error(`pii-guard: stopped. This would put personal data in the repo (${shown.length}):`);
    for (const f of shown.slice(0, 40)) console.error(`  ${f}`);
    console.error('Remove it and use fictional data (Jordan Alvarez, jordan@example.org, 212-555-0100). Never bypass this check.');
    process.exit(1);
}
