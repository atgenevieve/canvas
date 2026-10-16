#!/usr/bin/env node
// @ts-check
// `canvas`: see src/cli.mjs.
import fs from 'node:fs';
import { main } from '../src/cli.mjs';

main(process.argv.slice(2), {
    fetch: globalThis.fetch,
    env: process.env,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(line + '\n'),
    readStdin: () => fs.readFileSync(0, 'utf8'),
}).then(
    (code) => (process.exitCode = code),
    (e) => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
    },
);
