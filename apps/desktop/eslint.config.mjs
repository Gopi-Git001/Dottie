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
