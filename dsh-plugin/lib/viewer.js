// Managed standalone viewer processes.
//
// The in-UI "canvas" mode embeds the real blackboard viewer (public/), so it
// gets the same groups, filters, inspector and live SSE as `blackboard serve`.
//
// Lifecycle — the port is released when:
//   * the plugin unloads (profile reload, `dsh web` shutdown) — stopAll kills
//     each viewer's whole process group;
//   * the DSH host dies hard (SIGKILL/crash) — scripts/serve-guard.mjs detects
//     that it was reparented and kills its viewer;
//   * the viewer is idle for `idleMs` (no canvas tab touching it) — the reaper
//     stops it, and opening the canvas again starts a fresh one;
//   * the viewer itself crashes — the next open spawns a replacement.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Parent-death watchdog wrapping the viewer process. */
export const GUARD_PATH = path.resolve(HERE, '..', 'scripts', 'serve-guard.mjs');

/** How long an untouched viewer keeps its port: 30 minutes. */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/** Ask the OS for a free loopback port, then release it for the child. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForViewer(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`viewer exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/graph`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`viewer did not answer on ${url} within ${timeoutMs}ms`);
}

/**
 * @param {{ getCli: () => { command: string, prefix: string[] }, timeoutMs?: number,
 *           idleMs?: number, now?: () => number }} options
 */
export function createViewerManager({ getCli, timeoutMs = 15000, idleMs = DEFAULT_IDLE_MS, now = () => Date.now() }) {
  /** board root -> { child, port, url, lastUsed } */
  const running = new Map();
  let reaper = null;

  const isAlive = (entry) => entry.child.exitCode === null && entry.child.signalCode === null;

  function killEntry(entry) {
    // The guard leads its own process group, so one signal reaches the viewer too.
    try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { entry.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  function reap() {
    const cutoff = now() - idleMs;
    for (const [root, entry] of running) {
      if (!isAlive(entry) || entry.lastUsed <= cutoff) {
        killEntry(entry);
        running.delete(root);
      }
    }
    return running.size;
  }

  function startReaper() {
    if (reaper || !(idleMs > 0)) return;
    const period = Math.max(1000, Math.min(60_000, Math.floor(idleMs / 4)));
    reaper = setInterval(() => reap(), period);
    reaper.unref?.();
  }

  async function ensure(boardRoot) {
    const existing = running.get(boardRoot);
    if (existing && isAlive(existing)) {
      existing.lastUsed = now();
      return existing;
    }
    if (existing) running.delete(boardRoot);

    const port = await freePort();
    const cli = getCli();
    const child = spawn(process.execPath, [GUARD_PATH, cli.command, ...cli.prefix, 'serve', '--port', String(port)], {
      cwd: boardRoot,
      env: { ...process.env, BLACKBOARD_QUIET: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const url = `http://127.0.0.1:${port}`;
    const entry = { child, port, url, lastUsed: now() };
    running.set(boardRoot, entry);
    startReaper();

    try {
      await waitForViewer(url, child, timeoutMs);
      return entry;
    } catch (error) {
      killEntry(entry);
      running.delete(boardRoot);
      const detail = String(stderr || '').trim();
      throw new Error(detail || error.message);
    }
  }

  function stopAll() {
    if (reaper) {
      clearInterval(reaper);
      reaper = null;
    }
    for (const entry of running.values()) killEntry(entry);
    running.clear();
  }

  return { ensure, stopAll, reap, running };
}
