#!/usr/bin/env node
// Run a long-lived viewer child and make sure it never outlives its owner.
//
// `blackboard serve` is started as a grandchild of the DSH host. On a graceful
// shutdown the host kills our whole process group; on a hard kill (SIGKILL,
// crash) it cannot, and the viewer would be reparented to launchd and keep its
// port. So this guard also polls its parent: once it is reparented (ppid 1, or
// any ppid change), it kills the viewer and exits.
//
// Usage: node serve-guard.mjs <command> <args...>
//   e.g. node serve-guard.mjs /usr/bin/node /path/bin/blackboard.js serve --port 4321

import { spawn } from 'node:child_process';

const [, , command, ...args] = process.argv;
if (!command) {
  console.error('serve-guard: missing command');
  process.exit(2);
}

const startedWith = process.ppid;
// Keep the viewer's stderr on our own stderr so the host can report why it failed.
const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', () => process.exit(0));
child.on('error', (error) => {
  console.error(`serve-guard: ${error.message}`);
  process.exit(1);
});

const watcher = setInterval(() => {
  if (process.ppid !== startedWith || process.ppid === 1) stop();
}, 2000);
watcher.unref?.();
