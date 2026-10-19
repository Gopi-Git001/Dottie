// Minimal flat config (E01 ruling 2i follow-up). Kept identical in packages/contracts and packages/codex-adapter;
// codex-adapter/test/lint-config.test.ts fails if the two drift apart.
import comments from '@eslint-community/eslint-plugin-eslint-comments';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { '@eslint-community/eslint-comments': comments },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='in']",
          message:
            "The `in` operator also sees inherited (prototype) members (ruling 2i). Use Object.hasOwn(obj, key) (or hasOwn from canonical.ts). If you truly need `in`, disable this line with a reason: `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
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
];
