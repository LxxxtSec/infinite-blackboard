// Spawn the blackboard CLI for one command.
//
// The plugin deliberately does not reimplement board semantics: every read and
// every mutation goes through the same CLI, event log and validation that the
// terminal and the Claude Code integration use. A version skew can therefore
// never desynchronize the plugin from the board format.

import { spawn } from 'node:child_process';

import { BlackboardRootError, describeSearchPath, resolveBlackboard } from './blackboard-root.js';

/** Hard stop for one CLI call: board commands are local and fast. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export class BlackboardCliError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = 'BlackboardCliError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Resolve how to invoke the CLI. The search order lives in `blackboard-root.js`;
 * an explicit `cliPath` still wins, and a broken explicit path still throws.
 */
export function resolveCli(cliPath) {
  let found = null;
  try {
    found = resolveBlackboard(cliPath);
  } catch (error) {
    if (error instanceof BlackboardRootError) throw new BlackboardCliError(error.message);
    throw error;
  }
  if (!found) {
    throw new BlackboardCliError(
      `blackboard: 没找到 blackboard 分发，无法调用 CLI。以下位置都没有命中：\n${describeSearchPath()}`,
    );
  }
  return { command: found.command, prefix: found.prefix };
}

/** Strip ANSI, CLI prefixes and trailing whitespace from stderr for the model. */
export function cleanStderr(stderr, limit = 2000) {
  const text = String(stderr || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.replace(/^(blackboard:|提示)\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Parse the stdout of a `--json` invocation, failing with context if it is not JSON. */
export function parseJson(stdout, command = 'blackboard') {
  const text = String(stdout || '').trim();
  if (!text) throw new BlackboardCliError(`blackboard: ${command} returned no output`);
  try {
    return JSON.parse(text);
  } catch {
    throw new BlackboardCliError(`blackboard: ${command} returned non-JSON output: ${text.slice(0, 200)}`);
  }
}

export function cliEnv(_cwd, base = process.env, agentId) {
  const env = {
    ...base,
    // Keep stdout machine-readable and free of progress hints.
    BLACKBOARD_QUIET: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  // An explicitly configured identity is what keeps parallel Agents on separate
  // cursors. Left unset, an inherited BLACKBOARD_AGENT (and the CLI's own
  // agent:primary default) stays in charge; the plugin must not override it.
  if (agentId) env.BLACKBOARD_AGENT = String(agentId);
  // Deliberately NOT setting BLACKBOARD_CWD/FLOW_CWD: the CLI treats an
  // explicit project directory as authoritative and skips its ancestor-board
  // discovery, so pinning the live session cwd here would make a session that
  // cd'd into a subdirectory create a nested board instead of using the
  // project's board. The child runs with cwd = the live session directory and
  // the CLI finds the nearest ancestor board itself, exactly like the terminal.
  delete env.BLACKBOARD_CWD;
  delete env.FLOW_CWD;
  return env;
}

/**
 * Run one CLI command and resolve its stdout.
 *
 * @param {string[]} argv - arguments after the CLI script (e.g. ['digest', '--json']).
 * @param {{ cwd: string, cli: { command: string, prefix: string[] }, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function runBlackboard(argv, { cwd, cli, timeoutMs = DEFAULT_TIMEOUT_MS, signal, agentId } = {}) {
  if (!cwd) return Promise.reject(new BlackboardCliError('blackboard: no working directory available for this session'));
  if (signal?.aborted) return Promise.reject(new BlackboardCliError('blackboard: cancelled'));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cli.command, [...cli.prefix, ...argv], {
        cwd,
        env: cliEnv(cwd, process.env, agentId),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new BlackboardCliError(`blackboard: failed to start "${cli.command}": ${error.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      finish(reject, new BlackboardCliError(`blackboard: failed to run "${cli.command}": ${error.message}`));
    });
    child.on('close', (code) => {
      if (signal?.aborted) {
        finish(reject, new BlackboardCliError('blackboard: cancelled'));
        return;
      }
      if (timer && code === null) {
        finish(reject, new BlackboardCliError(`blackboard: timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const reason = cleanStderr(stderr) || `blackboard CLI exited with code ${code}`;
        finish(reject, new BlackboardCliError(reason, { code, stderr: cleanStderr(stderr) }));
        return;
      }
      finish(resolve, stdout);
    });
  });
}
