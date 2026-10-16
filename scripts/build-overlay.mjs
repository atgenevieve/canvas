// Bundles the overlay (client/src/overlay/index.ts) into one ES module, worker/public/overlay.js, which the Worker
// serves at BASE/overlay.js. The built file is committed: projects deploy the Worker from this package as installed
// (node_modules/@atgenevieve/canvas/worker), where nothing builds it. A test (client/test/overlay/bundle.test.ts)
// fails when it is out of date with the source.
//
//   npm run build:overlay           write it
//   npm run build:overlay -- --check   exit 1 if the committed file differs from a fresh build
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = path.join(root, 'client/src/overlay/index.ts');
export const OUT = path.join(root, 'worker/public/overlay.js');
const BANNER = '// The canvas overlay. Built from client/src/overlay by scripts/build-overlay.mjs; edit the source, not this file.';

/** The bundle's text. */
export async function buildOverlay() {
    const result = await build({
        entryPoints: [ENTRY],
        bundle: true,
        format: 'esm',
        target: 'es2022',
        minify: true,
        write: false,
        charset: 'utf8',
        legalComments: 'eof',
        banner: { js: BANNER },
        logLevel: 'silent',
    });
    return result.outputFiles[0].text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const text = await buildOverlay();
    if (process.argv.includes('--check')) {
        const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (current !== text) {
            console.error('worker/public/overlay.js is out of date: run npm run build:overlay');
            process.exit(1);
        }
        console.info('worker/public/overlay.js is up to date');
    } else {
        fs.writeFileSync(OUT, text);
        console.info(`wrote worker/public/overlay.js (${(text.length / 1024).toFixed(1)} KB)`);
    }
}
