// Locate the blackboard distribution this plugin drives.
//
// The plugin deliberately bundles no board semantics: every tool call spawns the
// `blackboard` CLI, and the Web snapshot reuses the very same `lib/` replay code
// the CLI uses. That code lives in a *distribution* — a checkout or installed
// copy — which is a separate directory from this plugin:
//
//   <root>/bin/blackboard.js    the CLI every tool call spawns
//   <root>/lib/                 model + store, reused by the snapshot route
//   <root>/skills/blackboard/   the packaged Agent skill (for `npm run skill:install`)
//   <root>/public/              the built viewer the canvas mode embeds
//
// Nothing is vendored here: a fork of `lib/` would be a second source of truth
// for the event log, and the whole point of driving the CLI is that a version
// skew can never desynchronize the plugin from the board format.

import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** This plugin's package root (the repository root in a standalone install). */
export const PLUGIN_ROOT = path.resolve(HERE, '..');

/** Where the CLI lives inside a distribution. */
export const CLI_RELATIVE = path.join('bin', 'blackboard.js');

/** Point at the CLI itself (`.../bin/blackboard.js`). */
export const CLI_ENV = 'BLACKBOARD_CLI';
/** Point at the distribution root (the directory holding `bin/` and `lib/`). */
export const ROOT_ENV = 'BLACKBOARD_ROOT';

/** Configured on purpose but pointing nowhere — a mistake worth failing loudly. */
export class BlackboardRootError extends Error {
  constructor(message, source) {
    super(message);
    this.name = 'BlackboardRootError';
    this.source = source;
  }
}

export const SOURCES = {
  CONFIG: 'config:cliPath',
  ENV_CLI: `env:${CLI_ENV}`,
  ENV_ROOT: `env:${ROOT_ENV}`,
  NODE_MODULES: 'node_modules/blackboard',
  SIBLING: 'sibling-checkout',
  PATH: 'path',
};

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function isExecutable(target) {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `<root>/bin/blackboard.js` → `<root>`; anything else → the same guess. */
export function rootOfCli(cliPath) {
  return path.dirname(path.dirname(path.resolve(cliPath)));
}

function descriptor(source, cliPath) {
  return {
    source,
    cliPath,
    root: rootOfCli(cliPath),
    command: process.execPath,
    prefix: [cliPath],
  };
}

/**
 * The project's own `blackboard launcher` installs a tiny shell shim on PATH
 * (`exec "<node>" "<cli>" "$@"`). Its realpath is not the CLI, so read the shim
 * and pull the CLI path back out; a symlink to the CLI needs no such help.
 */
function cliFromShim(file) {
  let real;
  try {
    real = realpathSync(file);
  } catch {
    return null;
  }
  if (path.basename(real) === path.basename(CLI_RELATIVE)) return real;
  let text = '';
  try {
    if (statSync(real).size > 8192) return null;
    text = readFileSync(real, 'utf8');
  } catch {
    return null;
  }
  // Any quoted or bare argument ending in blackboard.js: the shim quotes it.
  const matches = text.match(/[^\s"'`]+bin[/\\]blackboard\.js/g) || [];
  for (const candidate of matches) {
    const cleaned = candidate.replace(/["'`)]+$/, '');
    const resolved = path.isAbsolute(cleaned) ? cleaned : path.resolve(path.dirname(real), cleaned);
    if (isFile(resolved)) return resolved;
  }
  return null;
}

/** The first runnable `blackboard` on PATH, in PATH order. */
export function findOnPath(env = process.env) {
  const raw = env.PATH || env.Path || '';
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `blackboard${ext}`);
      if (isFile(candidate) && (process.platform === 'win32' || isExecutable(candidate))) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolve the distribution, first hit wins:
 *
 *   1. plugin config `cliPath`                (explicit, highest priority)
 *   2. env `BLACKBOARD_CLI`                   (path to bin/blackboard.js)
 *   3. env `BLACKBOARD_ROOT`                  (path to the distribution root)
 *   4. <pluginRoot>/node_modules/blackboard   (npm-installed copy)
 *   5. sibling checkout <pluginRoot>/..       (dev layout: blackboard/dsh-plugin)
 *   6. a `blackboard` executable on PATH      (launcher shim or a symlink)
 *
 * Configured-but-broken input throws `BlackboardRootError`; a plain absence
 * returns null, so the plugin can still load and fail each call with the error.
 *
 * @param {string} [cliPath] - the plugin's `cliPath` config.
 * @param {{ env?: NodeJS.ProcessEnv, pluginRoot?: string }} [options]
 * @returns {{ source: string, cliPath: string|null, root: string|null,
 *             command: string, prefix: string[] } | null}
 */
export function resolveBlackboard(cliPath, { env = process.env, pluginRoot = PLUGIN_ROOT } = {}) {
  if (cliPath) {
    const resolved = path.resolve(String(cliPath));
    if (!isFile(resolved)) {
      throw new BlackboardRootError(`blackboard: cliPath does not exist: ${resolved}`, SOURCES.CONFIG);
    }
    return descriptor(SOURCES.CONFIG, resolved);
  }

  const envCli = env[CLI_ENV];
  if (envCli) {
    const resolved = path.resolve(String(envCli));
    if (!isFile(resolved)) {
      throw new BlackboardRootError(`blackboard: ${CLI_ENV} does not exist: ${resolved}`, SOURCES.ENV_CLI);
    }
    return descriptor(SOURCES.ENV_CLI, resolved);
  }

  const envRoot = env[ROOT_ENV];
  if (envRoot) {
    const root = path.resolve(String(envRoot));
    const cli = path.join(root, CLI_RELATIVE);
    if (!isFile(cli)) {
      throw new BlackboardRootError(
        `blackboard: ${ROOT_ENV} is not a blackboard distribution (no ${CLI_RELATIVE}): ${root}`,
        SOURCES.ENV_ROOT,
      );
    }
    return descriptor(SOURCES.ENV_ROOT, cli);
  }

  for (const packageName of ['blackboard', 'infinite-blackboard']) {
    const installed = path.join(path.resolve(pluginRoot), 'node_modules', packageName, CLI_RELATIVE);
    if (isFile(installed)) return descriptor(SOURCES.NODE_MODULES, installed);
  }

  const sibling = path.join(path.resolve(pluginRoot, '..'), CLI_RELATIVE);
  if (isFile(sibling)) return descriptor(SOURCES.SIBLING, sibling);

  const onPath = findOnPath(env);
  if (onPath) {
    const cli = cliFromShim(onPath);
    if (cli) return descriptor(SOURCES.PATH, cli);
    // Runnable, but its origin is unknown: usable as a command, no lib/ shared.
    return { source: SOURCES.PATH, cliPath: null, root: null, command: onPath, prefix: [] };
  }

  return null;
}

/**
 * The distribution root alone, for callers that need `<root>/lib` or
 * `<root>/skills` rather than a command line. Null when none is resolvable.
 *
 * @param {string} [cliPath] - the plugin's `cliPath` config.
 * @returns {{ cliPath: string, root: string, source: string } | null}
 */
export function resolveBlackboardRoot(cliPath, options) {
  const found = resolveBlackboard(cliPath, options);
  if (!found || !found.root || !found.cliPath) return null;
  return { cliPath: found.cliPath, root: found.root, source: found.source };
}

/** Where a distribution may hide, for the error message only. */
export function describeSearchPath(pluginRoot = PLUGIN_ROOT) {
  return [
    '  · config  cliPath',
    `  · env     ${CLI_ENV}=/abs/path/bin/blackboard.js`,
    `  · env     ${ROOT_ENV}=/abs/path`,
    `  · installed copy   ${path.join(pluginRoot, 'node_modules', 'blackboard')} or node_modules/infinite-blackboard`,
    `  · sibling checkout ${path.resolve(pluginRoot, '..')}`,
    '  · PATH    blackboard',
  ].join('\n');
}
