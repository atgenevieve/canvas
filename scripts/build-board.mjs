// Builds the board page (client/src/board) into worker/public: index.html, board.js and board.css, which the Worker
// serves at BASE/. Run with `npm run build:board`; --watch rebuilds on change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'client/src/board');
const OUT = path.join(ROOT, 'worker/public');

/** @type {import('esbuild').BuildOptions} */
const options = {
    entryPoints: { board: path.join(SRC, 'main.ts') },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    outdir: OUT,
    legalComments: 'none',
    logLevel: 'warning',
};

function copyStatic() {
    fs.mkdirSync(OUT, { recursive: true });
    fs.copyFileSync(path.join(SRC, 'index.html'), path.join(OUT, 'index.html'));
    fs.copyFileSync(path.join(SRC, 'board.css'), path.join(OUT, 'board.css'));
}

copyStatic();
if (process.argv.includes('--watch')) {
    const ctx = await context(options);
    await ctx.watch();
    fs.watch(SRC, (_e, file) => file && /\.(html|css)$/.test(file) && copyStatic());
    console.info('build-board: watching', path.relative(ROOT, SRC));
} else {
    await build(options);
    console.info('build-board: wrote', path.relative(ROOT, OUT), '(index.html, board.js, board.css)');
}
