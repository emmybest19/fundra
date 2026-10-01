import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', 'src/generated/'],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Logging goes through Pino so secrets are redacted and output is structured.
      'no-console': 'error',
      eqeqeq: ['error', 'always'],

      // Money is bigint kobo; parsing floats is how rounding bugs get in.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is bigint kobo. Never parse floats.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money is bigint kobo. Never parse floats.',
        },
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from src/config/env.ts, not process.env.',
        },
      ],

      // Exhaustive switches over statuses and transaction types.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    // The only places allowed to read process.env: app config, and the Prisma CLI config
    // (which runs outside the app, before env.ts could validate anything).
    files: ['src/config/env.ts', 'prisma.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  {
    // Plain JS config files are not part of the TypeScript project.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must stay last: turns off rules that conflict with Prettier's formatting.
  prettier,
);
