// Load the blackboard distribution's shared library.
//
// The snapshot route replays the event log with the *same* code the CLI uses
// (`lib/model.js`, `lib/store.js`) instead of shipping a private copy, so the
// Web view can never disagree with `blackboard digest`. Those modules are
// imported from the resolved distribution root at request time, which also means
// the plugin needs no `../../lib` import and no build step of its own.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveBlackboardRoot } from './blackboard-root.js';

/** Resolved root -> Promise<{ root, model, store }>. One import per root. */
const loaded = new Map();

/** Human-readable resolution failure, reused by the routes. */
export const NO_DISTRIBUTION =
  'blackboard: 没找到 blackboard 分发（需要含 bin/blackboard.js 与 lib/ 的目录）。'
  + '请给插件配置 cliPath，或设置 BLACKBOARD_CLI=/abs/path/bin/blackboard.js / BLACKBOARD_ROOT=/abs/path。';

/**
 * @param {string} [root] - a distribution root; resolved automatically when omitted.
 * @returns {Promise<{ root: string, model: object, store: object }>}
 */
export function loadBoardLib(root) {
  let target = root || null;
  if (!target) {
    const found = resolveBlackboardRoot();
    if (!found) return Promise.reject(new Error(NO_DISTRIBUTION));
    target = found.root;
  }
  const cached = loaded.get(target);
  if (cached) return cached;

  const pending = Promise.all([
    import(pathToFileURL(path.join(target, 'lib', 'model.js')).href),
    import(pathToFileURL(path.join(target, 'lib', 'store.js')).href),
  ]).then(([model, store]) => ({ root: target, model, store }));

  // A failed import must not be cached: a repaired distribution reloads cleanly.
  pending.catch(() => loaded.delete(target));
  loaded.set(target, pending);
  return pending;
}

/**
 * The vocabulary the CLI's own model defines. Only tool *descriptions* use it,
 * so a missing distribution degrades to this frozen copy rather than failing the
 * plugin: the CLI still validates every value, and unknown types stay storable.
 */
export const FALLBACK_VOCABULARY = Object.freeze({
  NODE_TYPES: [
    'start', 'goal', 'intent', 'observation', 'fact', 'hypothesis', 'question',
    'action', 'result', 'finding', 'vuln', 'hint', 'summary', 'note', 'compact',
  ],
  EDGE_KINDS: [
    'related-to', 'derived-from', 'supports', 'contradicts', 'depends-on',
    'proves', 'caused-by', 'refines', 'duplicates', 'supersedes', 'resolves',
    'derive', 'intent-chain', 'produce', 'prove',
  ],
  NODE_STATES: [
    'open', 'active', 'done', 'blocked', 'dead', 'confirmed', 'refuted', 'deferred', 'superseded',
  ],
  SEVERITIES: ['critical', 'high', 'medium', 'low', 'info'],
  CONFIDENCE_LEVELS: ['suspected', 'static-confirmed', 'reproduced', 'confirmed'],
});

const pick = (value, key, fallback) => (Array.isArray(value) && value.length ? value : fallback);

/** The distribution's vocabulary when reachable, the frozen fallback otherwise. */
export async function loadVocabulary(root) {
  try {
    const { model } = await loadBoardLib(root);
    return {
      NODE_TYPES: pick(model.NODE_TYPES, 'NODE_TYPES', FALLBACK_VOCABULARY.NODE_TYPES),
      EDGE_KINDS: pick(model.EDGE_KINDS, 'EDGE_KINDS', FALLBACK_VOCABULARY.EDGE_KINDS),
      NODE_STATES: pick(model.NODE_STATES, 'NODE_STATES', FALLBACK_VOCABULARY.NODE_STATES),
      SEVERITIES: pick(model.SEVERITIES, 'SEVERITIES', FALLBACK_VOCABULARY.SEVERITIES),
      CONFIDENCE_LEVELS: pick(model.CONFIDENCE_LEVELS, 'CONFIDENCE_LEVELS', FALLBACK_VOCABULARY.CONFIDENCE_LEVELS),
    };
  } catch {
    return FALLBACK_VOCABULARY;
  }
}
