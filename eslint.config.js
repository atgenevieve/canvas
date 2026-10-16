import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['node_modules/**', '**/.wrangler/**', 'worker/public/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['client/**', 'scripts/**', 'worker/test/**', '*.config.{ts,js}'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['client/src/overlay/**'],
        languageOptions: { globals: globals.browser },
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'error',
            'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
        },
    },
);
