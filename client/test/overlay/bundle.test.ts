// The committed overlay bundle (worker/public/overlay.js) must match its source: projects deploy the Worker as
// installed, where nothing rebuilds it.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOverlay, OUT } from '../../../scripts/build-overlay.mjs';

describe('worker/public/overlay.js', () => {
    it('is up to date with client/src/overlay (npm run build:overlay)', async () => {
        const fresh = await buildOverlay();
        expect(fs.readFileSync(OUT, 'utf8') === fresh).toBe(true);
    });
});
