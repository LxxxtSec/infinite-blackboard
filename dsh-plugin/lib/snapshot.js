// Host-side board projection for the Web client view.
//
// The client never parses .blackboard/ itself: the host replays the event log with
// the same library the CLI uses and ships one bounded JSON snapshot.

import { loadBoardLib } from './board-lib.js';

const MAX_NODES = 1000;
const MAX_EDGES = 3000;
const MAX_DETAIL = 4000;

const clip = (value, limit = MAX_DETAIL) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/** The nearest ancestor board root, or the directory itself when there is none. */
export function boardRoot(cwd, lib) {
  return lib.store.findRoot(cwd) || cwd;
}

/**
 * Build the model-facing/Web-facing snapshot of one board.
 *
 * @param {string} cwd - any directory inside the project (session working directory).
 * @param {string} [distribution] - a blackboard distribution root; resolved
 *   automatically (config/env/installed copy/sibling/PATH) when omitted.
 * @returns {Promise<object>} `{ ok: true, ... }` or `{ ok: false, reason }`.
 */
export async function buildBoardSnapshot(cwd, distribution) {
  if (!cwd || typeof cwd !== 'string') return { ok: false, reason: 'no-cwd' };

  let lib;
  try {
    lib = await loadBoardLib(distribution);
  } catch (error) {
    return { ok: false, reason: 'no-distribution', cwd, message: String(error?.message || error) };
  }
  const { findRoot, isInitialized, readState, replay, stats } = lib.store;

  const root = findRoot(cwd);
  if (!root || !isInitialized(root)) {
    return { ok: false, reason: 'no-board', cwd: root || cwd };
  }

  const graph = replay(root);
  const summary = stats(graph);
  const state = readState(root);
  const cursorId = lib.model.currentCursor(graph) || null;
  const allNodes = Object.values(graph.nodes).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const allEdges = Object.values(graph.edges);

  return {
    ok: true,
    cwd: root,
    title: graph.meta?.title || state.title || '',
    session: state.session || '',
    cursorId,
    updatedAt: Date.now(),
    truncated: allNodes.length > MAX_NODES || allEdges.length > MAX_EDGES,
    stats: {
      nodes: summary.total,
      edges: summary.edges,
      frontier: summary.frontier,
      activities: summary.activities,
      checkpoints: summary.checkpoints,
      byType: summary.byType || {},
    },
    trail: (graph.cursorTrail || []).slice(-20).map((entry) => ({
      to: entry.to ?? null,
      at: entry.at || 0,
      reason: entry.reason || '',
    })),
    checkpoints: Object.values(graph.checkpoints || {}).slice(-10).map((checkpoint) => ({
      id: checkpoint.id,
      at: checkpoint.at || 0,
      summary: clip(checkpoint.summary, 300),
      cursorNodeId: checkpoint.cursorNodeId ?? null,
    })),
    nodes: allNodes.slice(-MAX_NODES).map((node) => ({
      id: node.id,
      type: node.type,
      title: clip(node.title, 500),
      detail: node.detail ? clip(node.detail) : '',
      status: node.status || null,
      severity: node.severity || null,
      confidence: node.confidence || null,
      tags: Array.isArray(node.tags) ? node.tags : [],
      ts: node.ts || 0,
      updated: node.updated || 0,
      loc: node.loc || null,
      parent: node.parent || null,
    })),
    edges: allEdges.slice(-MAX_EDGES).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edge.label || '',
    })),
  };
}
