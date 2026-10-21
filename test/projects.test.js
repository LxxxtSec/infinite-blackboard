import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.js';

test('projects mode starts empty, creates/switches projects, imports and reports analysis status', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-projects-'));
  const projectsRoot = path.join(base, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const port = 56000 + Math.floor(Math.random() * 2000);
  const server = await startServer({ cwd: base, port, projectsRoot });
  t.after(() => server.close());
  const api = `http://127.0.0.1:${port}`;

  const initial = await (await fetch(`${api}/api/projects`)).json();
  assert.equal(initial.enabled, true);
  assert.equal(initial.projects.length, 1);
  assert.equal(initial.projects[0].status, 'empty');
  assert.equal(initial.projects[0].units, 0);

  const graph = await (await fetch(`${api}/api/graph`)).json();
  assert.deepEqual(graph.nodes, {});
  const token = graph.requestToken;

  const created = await fetch(`${api}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ name: '第二个项目' }),
  });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.project.title, '第二个项目');

  const listed = await (await fetch(`${api}/api/projects`)).json();
  assert.equal(listed.projects.length, 2);
  assert.ok(listed.projects.some((project) => project.id === createdBody.project.id && project.active));

  const source = path.join(base, 'src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'pwn.c'), 'static void pwn(void) {}\\n');
  const imported = await fetch(`${api}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ source, dest: 'poc' }),
  });
  assert.equal(imported.status, 200);

  const pending = await (await fetch(`${api}/api/projects`)).json();
  const current = pending.projects.find((project) => project.active);
  assert.equal(current.status, 'pending');
  assert.equal(current.units, 1);

  const roles = await fetch(`${api}/api/roles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ roles: { pwn: '入口函数' } }),
  });
  assert.equal(roles.status, 200);
  const analyzed = await (await fetch(`${api}/api/projects`)).json();
  assert.equal(analyzed.projects.find((project) => project.active).status, 'analyzed');

  const firstId = analyzed.projects.find((project) => !project.active).id;
  const switched = await fetch(`${api}/api/projects/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ id: firstId }),
  });
  assert.equal(switched.status, 200);
  const emptyAgain = await (await fetch(`${api}/api/graph`)).json();
  assert.deepEqual(emptyAgain.nodes, {});

  const beforeDelete = await (await fetch(`${api}/api/projects`)).json();
  const other = beforeDelete.projects.find((project) => !project.active);
  const deleted = await fetch(`${api}/api/projects/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ id: other.id }),
  });
  assert.equal(deleted.status, 200);
  const afterDelete = await (await fetch(`${api}/api/projects`)).json();
  assert.equal(afterDelete.projects.length, 1);
  assert.equal(afterDelete.active, beforeDelete.active);

  const refused = await fetch(`${api}/api/projects/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ id: afterDelete.active }),
  });
  assert.equal(refused.status, 409);
});
