// Host-side snapshot projection and route payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCli, runBlackboard } from '../lib/cli.js';
import { SNAPSHOT_PATH, createSnapshotRoute, snapshotPayload } from '../lib/route.js';
import { buildBoardSnapshot } from '../lib/snapshot.js';

const cli = resolveCli();
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'blackboard-snap-'));

async function seedBoard(cwd) {
  await runBlackboard(['init', '--title', 'snap board'], { cwd, cli });
  await runBlackboard(['node', 'add', 'goal', 'Goal A', '--enter', '--json'], { cwd, cli });
  await runBlackboard(['node', 'add', 'hypothesis', 'Hypo B', '--detail', 'evidence text', '--json'], { cwd, cli });
  await runBlackboard(['link', 'g1', 'hy1', '--rel', 'derived-from', '--json'], { cwd, cli });
}

test('snapshot carries title, cursor, nodes and edges', async () => {
  const cwd = tempDir();
  await seedBoard(cwd);
  const snapshot = await buildBoardSnapshot(cwd);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.title, 'snap board');
  assert.equal(snapshot.cursorId, 'g1');
  assert.equal(snapshot.stats.nodes, 2);
  assert.equal(snapshot.stats.edges, 1);
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ['g1', 'hy1']);
  assert.equal(snapshot.nodes[1].detail, 'evidence text');
  assert.equal(snapshot.edges[0].kind, 'derived-from');
  assert.equal(snapshot.cwd, cwd);
});

test('a session in a subdirectory snapshots the ancestor board', async () => {
  const root = tempDir();
  await seedBoard(root);
  const sub = path.join(root, 'sub');
  mkdirSync(sub, { recursive: true });
  const snapshot = await buildBoardSnapshot(sub);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.cwd, root);
  assert.equal(snapshot.stats.nodes, 2);
});

test('a boardless directory reports no-board instead of throwing', async () => {
  const snapshot = await buildBoardSnapshot(tempDir());
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.reason, 'no-board');
});

test('payload resolves the session directory and reports an unknown session', async () => {
  const cwd = tempDir();
  await seedBoard(cwd);
  const params = new URLSearchParams('session=s1');
  const ok = await snapshotPayload({ searchParams: params, resolveCwd: () => cwd });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.stats.nodes, 2);

  const missing = await snapshotPayload({ searchParams: params, resolveCwd: () => null });
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.reason, 'no-session');

  const broken = await snapshotPayload({ searchParams: params, resolveCwd: () => { throw new Error('boom'); } });
  assert.equal(broken.body.reason, 'session-error');
  assert.match(broken.body.message, /boom/);
});

test('the route is one exact path with a handler', () => {
  const route = createSnapshotRoute({ resolveCwd: () => null });
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, SNAPSHOT_PATH);
  assert.equal(typeof route.handler, 'function');
});
