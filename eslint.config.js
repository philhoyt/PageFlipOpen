import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Catch dead code
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Catch common mistakes
      'no-undef': 'error',
      'no-constant-condition': 'error',

      // Prefer const where possible
      'prefer-const': 'error',

      // Enforce === over ==
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
    },
  },
];
