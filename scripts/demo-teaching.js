#!/usr/bin/env node
// Seed a code-teaching demo board: `node scripts/demo-teaching.js [dir]`.
//
// Copies the synthetic kernel-LPE classroom sample into a fresh directory (so
// code anchors stay inside the board root), imports it, loads the three sample
// lessons, and leaves one student question open for the Agent to answer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'blackboard.js');
const SAMPLE = path.resolve(HERE, '..', 'examples', 'kernel-lpe-demo');
const dir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'blackboard-teaching-demo'));

if (fs.existsSync(path.join(dir, '.flow'))) fs.rmSync(path.join(dir, '.flow'), { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.cpSync(SAMPLE, dir, { recursive: true });

const run = (...args) => execFileSync(process.execPath, [CLI, ...args], {
  cwd: dir,
  env: { ...process.env, BLACKBOARD_QUIET: '1' },
  encoding: 'utf8',
}).trim();

run('init', '--title', '内核 LPE 教学示例 · Android');
// The intended flow: import code, let the Agent analyse it, then write the
// per-PoC chain and short function roles. No fixed lifecycle is imposed here.
run('code', 'import', '.');
run('annotate', '--file', 'roles.json');
run('chain', 'import', 'chain.json');
run('learn', 'leak_kernel_pointer');
for (const lesson of ['lesson-overview.json', 'lesson-vuln-free.json', 'lesson-leak.json']) {
  run('teach', 'import', lesson);
}
run('ask', 'refcount 的检查和递减都在锁里，为什么还会竞态？', '--file', 'vuln_demo.c', '--lines', '69-86');
run('reply', 'rq1', '--text', '锁只保护临界区本身。`refcnt` 的检查与递减虽然都在锁内，但对象的生命周期由调用者决定：`vuln_free()` 返回后 slot 仍可能被别处引用，示例里就没有在释放后摘链。所以这里的竞态不是“锁没加”，而是“锁保护的范围小于对象的生命周期”。');

console.log(`教学黑板已生成：${dir}`);
console.log(run('status'));
console.log(`查看：node ${CLI} serve --open  (cwd=${dir})`);
console.log('待答提问：blackboard requests → blackboard reply rq1 --text "…"');
