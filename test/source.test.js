import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  detectSource, prepareSource, unsafeEntries, slugify, isGitUrl, isRemoteArchive,
} from '../lib/source.js';
import { importCode } from '../lib/importer.js';
import { ensure, replay, stats } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'flow.js');
const TOOLS = { git: ['git', '--version'], zip: ['zip', '-v'], unzip: ['unzip', '-v'] };

function has(tool) {
  return spawnSync(TOOLS[tool][0], TOOLS[tool].slice(1), { encoding: 'utf8' }).status === 0;
}

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-source-'));
  ensure(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('source detection separates local paths, git URLs and archives', () => {
  assert.equal(slugify('https://github.com/acme/poc.git'), 'poc');
  assert.equal(slugify('poc.zip'), 'poc');
  assert.equal(isGitUrl('https://github.com/acme/poc'), true);
  assert.equal(isGitUrl('git@github.com:acme/poc.git'), true);
  assert.equal(isRemoteArchive('https://example.com/poc.zip'), true);
  assert.equal(isGitUrl('https://example.com/poc.zip'), false);
  assert.equal(detectSource('https://example.com/poc.zip').kind, 'remote-archive');
  assert.equal(detectSource('https://github.com/acme/poc').kind, 'git');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-local-'));
  fs.writeFileSync(path.join(dir, 'a.c'), 'static void f(void){}\n');
  try {
    assert.equal(detectSource(dir).kind, 'local');
    assert.equal(detectSource(path.join(dir, 'a.c')).kind, 'local');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-zip-'));
    const zip = path.join(empty, 'poc.zip');
    fs.writeFileSync(zip, '');
    assert.equal(detectSource(zip).kind, 'archive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unsafe archive paths are rejected before extraction', () => {
  assert.deepEqual(unsafeEntries(['src/a.c', 'README.md']), []);
  const bad = unsafeEntries(['../escape.c', '/etc/passwd', 'C:/windows/x', 'ok/../../x']);
  assert.equal(bad.length, 4);
});

test('a zip PoC can be imported directly through the CLI', (t) => {
  if (!has('zip') || !has('unzip')) {
    t.skip('zip/unzip not available');
    return;
  }
  const board = project(t);
  const src = path.join(board, '..', `poc-src-${process.pid}`);
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'src', 'trigger.c'), 'static void trigger_race(void){ helper(); }\nstatic void helper(void){}\n');
  fs.writeFileSync(path.join(src, 'README.md'), '# demo\n');
  const archive = path.join(board, '..', `poc-${process.pid}.zip`);
  execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: src });
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(archive, { force: true }); });

  const out = execFileSync(process.execPath, [CLI, 'code', 'import', archive, '--dest', 'poc'], {
    cwd: board, env: { ...process.env, BLACKBOARD_QUIET: '1' }, encoding: 'utf8',
  });
  assert.match(out, /来源/);
  assert.match(out, /已导入/);
  const g = replay(board);
  assert.equal(Object.keys(g.files).length, 1);
  assert.equal(stats(g).units, 2);
  assert.match(g.meta.source || '', /poc-.*\.zip$/);
  assert.ok(fs.existsSync(path.join(board, '.flow', 'sources', 'poc', 'src', 'trigger.c')));
});

test('a file:// git repository can be fetched and imported', async (t) => {
  if (!has('git')) { t.skip('git not available'); return; }
  const board = project(t);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'exploit.c'), '#include "x.h"\nstatic void pwn(void){}\n');
  fs.writeFileSync(path.join(repo, 'x.h'), 'struct x { int y; };\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'demo'], { cwd: repo });

  const source = await prepareSource(`file://${repo}`, { cwd: board, dest: 'poc' });
  assert.equal(source.kind, 'git');
  assert.ok(fs.existsSync(path.join(source.dir, 'exploit.c')));
  const imported = importCode(board, source.dir);
  assert.equal(imported.files.length, 2);
  assert.ok(stats(replay(board)).units >= 2);
  assert.deepEqual(replay(board).files['.flow/sources/poc/exploit.c'].includes, ['x.h']);
});
