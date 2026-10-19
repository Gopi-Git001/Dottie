// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

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
    // E01/E02 prototype-key sweep: `key in obj` also matches inherited members (constructor,
    // __proto__, toString, ...). Use Object.hasOwn, a Map, or shared/own.ts `own()` for tables.
    files: ['**/*.ts', '**/*.mts', '**/*.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator='in']", message: 'Use Object.hasOwn(obj, key) (or a Map / own()) instead of `in`: `in` also matches inherited keys such as constructor and __proto__.' },
      ],
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
