// Canvas mode: the managed viewer process and the route that hands the tab its URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCli, runBlackboard } from '../lib/cli.js';
import { VIEWER_PATH, createViewerRoute } from '../lib/route.js';
import { GUARD_PATH, createViewerManager, freePort } from '../lib/viewer.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cli = resolveCli();
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'blackboard-viewer-'));

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

test('freePort returns a usable loopback port', async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0);
});

test('the viewer route refuses a boardless workspace', async () => {
  const route = createViewerRoute({ resolveCwd: () => tempDir(), ensureViewer: async () => { throw new Error('must not run'); } });
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, VIEWER_PATH);
  const res = fakeRes();
  await route.handler({ url: `${VIEWER_PATH}?session=s1` }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'no-board');
});

test('the viewer route returns the managed URL for a real board', async () => {
  const cwd = tempDir();
  await runBlackboard(['init', '--title', 'viewer board'], { cwd, cli });
  await runBlackboard(['node', 'add', 'goal', 'Canvas goal', '--enter', '--json'], { cwd, cli });

  const calls = [];
  const route = createViewerRoute({
    resolveCwd: () => cwd,
    ensureViewer: async (root) => { calls.push(root); return { url: 'http://127.0.0.1:12345', port: 12345 }; },
  });
  const res = fakeRes();
  await route.handler({ url: `${VIEWER_PATH}?session=s1` }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.url, 'http://127.0.0.1:12345');
  assert.deepEqual(calls, [cwd]);
});

test('the manager starts one real viewer per board and stops it again', async () => {
  const cwd = tempDir();
  await runBlackboard(['init', '--title', 'canvas board'], { cwd, cli });
  await runBlackboard(['node', 'add', 'goal', 'Canvas goal', '--enter', '--json'], { cwd, cli });
  await runBlackboard(['node', 'add', 'observation', 'Canvas observation', '--json'], { cwd, cli });

  const manager = createViewerManager({ getCli: () => cli, timeoutMs: 20000 });
  try {
    const entry = await manager.ensure(cwd);
    assert.match(entry.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    // Same board root reuses the process it already owns.
    const again = await manager.ensure(cwd);
    assert.equal(again.port, entry.port);

    const graph = await (await fetch(`${entry.url}/api/graph`)).json();
    // `/api/graph` mirrors the viewer's own snapshot: nodes/edges are id-keyed maps.
    assert.deepEqual(Object.keys(graph.nodes).sort(), ['g1', 'o1']);
    assert.equal(Object.keys(graph.edges).length, 0);

    const page = await (await fetch(entry.url)).text();
    assert.match(page, /<html|<!doctype html/i);
    manager.stopAll();
    assert.equal(manager.running.size, 0);

    // stopAll must release the port, not just forget the process.
    await assert.rejects(() => fetch(`${entry.url}/api/graph`, { signal: AbortSignal.timeout(1500) }));
  } finally {
    manager.stopAll();
  }
});

test('the reaper releases an idle viewer port', async () => {
  const cwd = tempDir();
  await runBlackboard(['init', '--title', 'idle board'], { cwd, cli });
  await runBlackboard(['node', 'add', 'goal', 'Idle goal', '--enter', '--json'], { cwd, cli });

  const manager = createViewerManager({ getCli: () => cli, timeoutMs: 20000, idleMs: 0 });
  try {
    const entry = await manager.ensure(cwd);
    assert.equal((await (await fetch(`${entry.url}/api/graph`)).json()).meta.title, 'idle board');
    manager.reap();
    assert.equal(manager.running.size, 0);
    await assert.rejects(() => fetch(`${entry.url}/api/graph`, { signal: AbortSignal.timeout(1500) }));
  } finally {
    manager.stopAll();
  }
});

test('the guard reaps its viewer when the owning process dies', async () => {
  const dir = tempDir();
  const marker = path.join(dir, 'beats.txt');
  const dummy = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'.'),200);`;
  const parent = `const { spawn } = require('node:child_process');`
    + `spawn(process.execPath, [${JSON.stringify(GUARD_PATH)}, process.execPath, '-e', ${JSON.stringify(dummy)}],`
    + ` { stdio: ['ignore','ignore','inherit'], detached: true }).unref();`;
  // The parent exits immediately; only the guard's parent watch can stop the viewer.
  execFileSync(process.execPath, ['-e', parent]);
  await sleep(3200);
  const before = statSync(marker).size;
  await sleep(1000);
  assert.equal(statSync(marker).size, before, 'the reaped viewer must stop heartbeating');
});
