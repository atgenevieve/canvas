import { defineConfig } from 'vitest/config';

// The Worker runs on Miniflare (workerd) inside the tests, so everything here runs in Node.
export default defineConfig({
    test: {
        include: ['worker/test/**/*.test.ts', 'client/test/**/*.test.{ts,mjs}'],
        environment: 'node',
        hookTimeout: 30000,
    },
});
