// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import comments from '@eslint-community/eslint-plugin-eslint-comments';

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'assets/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    // Shared prototype-safety block, copied from E02 packages/codex-adapter/eslint.config.mjs @ 59fa315
    // (feature/E02-approvals-bridge; E01 ruling 2i). Only paths are adapted: `files` also covers
    // scripts/, and the hasOwn hint points at src/shared/own.ts instead of canonical.ts.
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.mjs', 'scripts/**/*.mts'],
    plugins: { '@eslint-community/eslint-comments': comments },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='in']",
          message:
            "The `in` operator also sees inherited (prototype) members (ruling 2i). Use Object.hasOwn(obj, key) (or own() from src/shared/own.ts). If you truly need `in`, disable this line with a reason: `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
        {
          selector: 'ForInStatement',
          message:
            "`for...in` also walks inherited (prototype) enumerable keys (ruling 2i). Iterate own keys with Object.keys(obj) or Object.entries(obj) instead. If you truly need it, disable this line with a reason: `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
      ],
      // Every disable comment must say why (`-- reason`), name its rules, and actually suppress something.
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
    },
  },
  {
    // vitest mocks are routinely passed as bare methods to expect().
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/unbound-method': 'off' },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node, parserOptions: { projectService: false, project: false } },
  },
  {
    // Renderer boundary (spec §4): no Node, no Electron, no shell/fs/child_process.
    files: ['src/renderer/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'node:*', 'fs', 'fs/*', 'child_process', 'path', 'os', 'net', 'http', 'https'], message: 'Renderer must use window.dottie (preload API) only.' },
            { group: ['../main/*', '../../main/*', '../preload/*'], message: 'Renderer may import only from src/shared.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*', 'fs', 'child_process', '../main/*'], message: 'Sandboxed preload: electron (contextBridge/ipcRenderer) and src/shared only.' }] },
      ],
    },
  },
);
