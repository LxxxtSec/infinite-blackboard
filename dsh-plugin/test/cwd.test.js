// Working-directory resolution: live session cwd first, then the session
// header, then creation metadata, then the process directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCwd } from '../lib/cwd.js';

const session = (extra = {}) => ({ header: { cwd: '/work' }, ...extra });
const exec = (s) => ({ agent: { session: s } });

test('the live working-directory projection wins', () => {
  assert.equal(resolveCwd(exec(session()), () => '/work/sub'), '/work/sub');
});

test('a throwing or empty live projection falls back to the session header', () => {
  const s = session({ meta: { cwd: '/meta' } });
  assert.equal(resolveCwd(exec(s), () => { throw new Error('no owner'); }), '/work');
  assert.equal(resolveCwd(exec(s), () => ''), '/work');
  assert.equal(resolveCwd(exec(s), () => undefined), '/work');
});

test('creation metadata is used when the header has no cwd', () => {
  assert.equal(resolveCwd(exec({ meta: { cwd: '/meta' } })), '/meta');
});

test('the process directory is the last resort', () => {
  assert.equal(resolveCwd(exec({})), process.cwd());
  assert.equal(resolveCwd(undefined, () => '/never'), process.cwd());
  assert.equal(resolveCwd({ agent: {} }, () => '/never'), process.cwd());
});
