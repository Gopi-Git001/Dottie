/** Ruling 2i follow-up: the `in` ban and the disable-reason rule are one config, kept identical in both packages. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url); // dist/test → package root
test('eslint.config.mjs is identical in packages/contracts and packages/codex-adapter, and bans `in` and for...in with a reason rule', () => {
  const mine = readFileSync(new URL('eslint.config.mjs', root), 'utf8');
  const theirs = readFileSync(new URL('../contracts/eslint.config.mjs', root), 'utf8');
  assert.equal(mine, theirs);
  assert.match(mine, /selector: "BinaryExpression\[operator='in'\]"/);
  assert.match(mine, /Object\.hasOwn/);
  assert.match(mine, /selector: 'ForInStatement'/);
  assert.match(mine, /Object\.keys\(obj\) or Object\.entries\(obj\)/);
  assert.match(mine, /eslint-comments\/require-description/);
});
