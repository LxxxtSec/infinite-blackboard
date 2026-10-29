// Model-facing blackboard tools.
//
// Every tool is a thin, typed wrapper around one Infinite Blackboard CLI command. The
// tool layer owns argument shaping, session-working-directory plumbing and
// model-friendly rendering; it never owns board semantics.
//
// `defineTool` is injected so this module stays testable without a live DSH
// runtime (tests pass an identity function).

import { FALLBACK_VOCABULARY } from './board-lib.js';
import { parseJson, runBlackboard } from './cli.js';

const text = (value) => [{ type: "text", text: String(value) }];

function nodeSummary(node) {
  if (!node) return '(none)';
  const bits = [String(node.id), `[${node.type}]`, node.title || ''];
  if (node.status) bits.push(`status=${node.status}`);
  if (node.severity) bits.push(`severity=${node.severity}`);
  if (node.confidence) bits.push(`confidence=${node.confidence}`);
  if (node.loc?.path) bits.push(`@${node.loc.path}${node.loc.line ? `:${node.loc.line}` : ''}`);
  return bits.join(' ').trim();
}

function edgeSummary(edge) {
  return `${edge.from} --${edge.kind}--> ${edge.to}`;
}

function truncatedNote(result) {
  return Array.isArray(result?.truncated) && result.truncated.length
    ? `\nWarning: the CLI truncated fields: ${result.truncated.join(', ')}. Split long content into several nodes or write it to a file.`
    : '';
}

/**
 * Build the tool definitions.
 *
 * @param {Function} defineTool - `defineTool` from `@deepseek-ai/dsh-tools`.
 * @param {{ getCli: () => { command: string, prefix: string[] }, resolveCwd: (exec: any) => string,
 *           agentId?: string, timeoutMs?: number, vocabulary?: object }} deps
 */
export function createBlackboardTools(defineTool, deps) {
  const { getCli, resolveCwd, timeoutMs } = deps;
  const agentId = deps.agentId || undefined;
  // Description-only vocabulary: the CLI validates every value and accepts
  // unknown types, so a stale copy here can never reject a valid record. It
  // only lists what the resolved distribution knows about.
  const { NODE_TYPES, EDGE_KINDS, NODE_STATES, SEVERITIES, CONFIDENCE_LEVELS } =
    deps.vocabulary || FALLBACK_VOCABULARY;

  /** Run a CLI command in the calling session's working directory. */
  const call = (argv, exec) => runBlackboard(argv, { cwd: resolveCwd(exec), cli: getCli(), timeoutMs, signal: exec?.signal, agentId });
  const callJson = async (argv, exec, label) => parseJson(await call(argv, exec), label);

  const tools = [];

  tools.push(defineTool({
    name: 'blackboard_brief',
    description:
      'Recover the blackboard: counts, the current cursor node, its direct relations, the recent cursor trail, open questions and recent checkpoints. '
      + 'Read-only. Call it when starting or resuming work in a workspace that has a .flow/ board, and after context compaction.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const { digest } = await callJson(['digest', '--json'], exec, 'blackboard digest');
      return digest;
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_context',
    description:
      'Build a bounded, task-scoped context packet from the board (markdown). '
      + 'Read-only. Use it to zoom into a focus node, its neighborhood, or everything since a checkpoint without loading the whole board.',
    parameters: {
      focus: { type: 'string', description: 'Node id (or unique id prefix) to center the packet on. Defaults to the agent cursor.' },
      depth: { type: 'integer', description: 'Relation hops to include, 0-5. Default 2.' },
      budget: { type: 'integer', description: 'Approximate token budget for the packet. Default 4000.' },
      since: { type: 'string', description: 'Checkpoint id or timestamp to include only newer material.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['context'];
      if (args.focus) argv.push('--focus', String(args.focus));
      if (args.depth !== undefined) argv.push('--depth', String(args.depth));
      if (args.budget !== undefined) argv.push('--budget', String(args.budget));
      if (args.since !== undefined) argv.push('--since', String(args.since));
      argv.push('--markdown');
      return call(argv, exec);
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_add',
    description:
      'Record one node on the blackboard: a judgment, observation, hypothesis, finding, question, action, result or note. '
      + 'Describe evidence, not terminal noise. Creating a node does NOT move the cursor and does NOT create an edge; '
      + 'pass enter=true to move the cursor, or relate_here=true to link the new node to the current cursor node. '
      + 'Built-in types: '
      + `${NODE_TYPES.join(', ')}.`,
    parameters: {
      type: { type: 'string', required: true, description: `Node type. Built-ins: ${NODE_TYPES.join(', ')}; custom types are allowed.` },
      title: { type: 'string', required: true, description: 'Short, specific title (the CLI caps it). Put the evidence in detail.' },
      detail: { type: 'string', description: 'Evidence or reasoning body.' },
      status: { type: 'string', description: `Optional lifecycle status: ${NODE_STATES.join(', ')}.` },
      severity: { type: 'string', description: `Optional severity (mainly vuln/finding): ${SEVERITIES.join(', ')}.` },
      confidence: { type: 'string', description: `Optional verification level: ${CONFIDENCE_LEVELS.join(', ')}. Independent of status and severity.` },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels; repeated --tag.' },
      at: { type: 'string', description: 'Optional source location, file:line.' },
      parent: { type: 'string', description: 'Optional explicit source node id (legacy parent projection).' },
      relation: { type: 'string', description: `Optional edge kind when linking to parent/current node: ${EDGE_KINDS.slice(0, 11).join(', ')}.` },
      reason: { type: 'string', description: 'Optional short reason for the cursor move.' },
      enter: { type: 'boolean', description: 'Move the agent cursor to the new node.' },
      relate_here: { type: 'boolean', description: 'Link the new node to the current cursor node without moving the cursor.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['node', 'add', String(args.type), String(args.title)];
      if (args.detail) argv.push('--detail', String(args.detail));
      if (args.status) argv.push('--status', String(args.status));
      if (args.severity) argv.push('--sev', String(args.severity));
      if (args.confidence) argv.push('--confidence', String(args.confidence));
      for (const tag of args.tags || []) argv.push('--tag', String(tag));
      if (args.at) argv.push('--at', String(args.at));
      if (args.parent) argv.push('--parent', String(args.parent));
      if (args.relation) argv.push('--rel', String(args.relation));
      if (args.reason) argv.push('--reason', String(args.reason));
      if (args.enter) argv.push('--enter');
      if (args.relate_here) argv.push('--relate-here');
      argv.push('--json');
      const result = await callJson(argv, exec, 'blackboard node add');
      const lines = [`Created ${nodeSummary(result.node)}`];
      if (result.edge) lines.push(`Edge: ${edgeSummary(result.edge)}`);
      if (result.cursor?.to) lines.push(`Cursor → ${result.cursor.to}`);
      else if (result.cursor) lines.push('Cursor cleared');
      return lines.join('\n') + truncatedNote(result);
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_edit',
    description:
      'Update an existing node: retitle, rewrite detail, change lifecycle status (done/blocked/open/dead/...), severity, confidence or tags. '
      + 'Use this to mark work done or blocked instead of creating duplicate nodes.',
    parameters: {
      id: { type: 'string', required: true, description: 'Node id or unique id prefix.' },
      title: { type: 'string', description: 'Replacement title.' },
      detail: { type: 'string', description: 'Replacement evidence/reasoning body.' },
      status: { type: 'string', description: `New lifecycle status: ${NODE_STATES.join(', ')}.` },
      severity: { type: 'string', description: `New severity: ${SEVERITIES.join(', ')}.` },
      confidence: { type: 'string', description: `New verification level: ${CONFIDENCE_LEVELS.join(', ')}.` },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['edit', String(args.id)];
      if (args.title !== undefined) argv.push('--title', String(args.title));
      if (args.detail !== undefined) argv.push('--detail', String(args.detail));
      if (args.status !== undefined) argv.push('--status', String(args.status));
      if (args.severity !== undefined) argv.push('--sev', String(args.severity));
      if (args.confidence !== undefined) argv.push('--confidence', String(args.confidence));
      for (const tag of args.tags || []) argv.push('--tag', String(tag));
      argv.push('--json');
      const node = await callJson(argv, exec, 'blackboard edit');
      return `Updated ${nodeSummary(node)}` + truncatedNote(node);
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_link',
    description:
      'Create one explicit relation between two existing nodes (read as "from <relation> to"). '
      + 'Prefer this over adjacency: the board only treats explicit edges as reasoning structure.',
    parameters: {
      from: { type: 'string', required: true, description: 'Source node id or unique prefix.' },
      to: { type: 'string', required: true, description: 'Target node id or unique prefix.' },
      relation: { type: 'string', description: `Edge kind, default related-to. Common: ${EDGE_KINDS.slice(0, 11).join(', ')}.` },
      label: { type: 'string', description: 'Optional free-text label for the edge.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['link', String(args.from), String(args.to)];
      if (args.relation) argv.push('--rel', String(args.relation));
      if (args.label) argv.push('--label', String(args.label));
      argv.push('--json');
      const edge = await callJson(argv, exec, 'blackboard link');
      return `Linked ${edgeSummary(edge)}` + truncatedNote(edge);
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_focus',
    description:
      'Move the agent cursor without creating any edge: to an existing node, to the next open intent/hypothesis/question ("next"), or clear it ("clear"). '
      + 'The cursor is attention, not parenthood.',
    parameters: {
      to: { type: 'string', required: true, description: 'Node id/prefix, "next" or "clear".' },
      reason: { type: 'string', description: 'Optional short reason, retained in the cursor trail.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['focus', String(args.to)];
      if (args.reason) argv.push('--reason', String(args.reason));
      argv.push('--json');
      const result = await callJson(argv, exec, 'blackboard focus');
      const cursor = result.cursor;
      if (!cursor || cursor.to === null || cursor.to === undefined) return 'Cursor cleared';
      return `Cursor → ${cursor.to}`;
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_show',
    description:
      'Inspect the board without changing it: with an id, show one node with its incoming/outgoing relations; '
      + 'without an id, list recent nodes (optionally filtered by type or to open items only).',
    parameters: {
      id: { type: 'string', description: 'Node id or unique prefix. Omit to list nodes instead.' },
      type: { type: 'string', description: 'List filter: node type.' },
      open: { type: 'boolean', description: 'List filter: open intents, hypotheses and questions only.' },
      limit: { type: 'integer', description: 'List size cap, default 30.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      if (args.id) {
        const result = await callJson(['show', String(args.id), '--json'], exec, 'blackboard show');
        const lines = [`${nodeSummary(result.node)}`];
        if (result.node?.detail) lines.push('', result.node.detail);
        if (result.parents?.length) {
          lines.push('', 'Incoming:');
          for (const p of result.parents) lines.push(`  ${nodeSummary(p)} (${p.edge})`);
        }
        if (result.children?.length) {
          lines.push('', 'Outgoing:');
          for (const c of result.children) lines.push(`  ${nodeSummary(c)} (${c.edge})`);
        }
        return lines.join('\n');
      }
      const argv = ['ls'];
      if (args.type) argv.push('--type', String(args.type));
      if (args.open) argv.push('--open');
      if (args.limit !== undefined) argv.push('--limit', String(args.limit));
      argv.push('--json');
      const nodes = await callJson(argv, exec, 'blackboard ls');
      if (!Array.isArray(nodes) || nodes.length === 0) return '(no nodes match)';
      return nodes.map((n) => nodeSummary(n)).join('\n');
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_checkpoint',
    description:
      'Save a recovery checkpoint on the board (the current cursor node and a short summary). '
      + 'Call it before a long detour or when the user asks to preserve the current position.',
    parameters: {
      summary: { type: 'string', description: 'Short summary of where the work stands. Defaults to the generated digest.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['checkpoint'];
      if (args.summary) argv.push('--summary', String(args.summary));
      argv.push('--json');
      const checkpoint = await callJson(argv, exec, 'blackboard checkpoint');
      const at = checkpoint.cursorNodeId ? ` @${checkpoint.cursorNodeId}` : '';
      return `Checkpoint ${checkpoint.id}${at}${checkpoint.summary ? `: ${checkpoint.summary}` : ''}` + truncatedNote(checkpoint);
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_init',
    description:
      'Create a .flow/ board in the current workspace root and set its title. '
      + 'Only call this when the user explicitly asks to enable blackboard in this project; '
      + 'if a parent directory already has a board, the CLI refuses and that parent board should be used instead.',
    parameters: {
      title: { type: 'string', description: 'Board title: the project or task name.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const initArgv = ['init'];
      if (args.title) initArgv.push('--title', String(args.title));
      const initOut = (await call(initArgv, exec)).trim();
      const status = await callJson(['status', '--json'], exec, 'blackboard status');
      const stats = status.stats || {};
      return `${initOut}\nBoard ready: ${stats.total ?? 0} nodes, ${stats.edges ?? 0} edges, cursor ${status.cursor ? nodeSummary(status.cursor) : '(none)'}`;
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_unlink',
    description:
      'Remove one explicit relation between two nodes (the append-only log keeps the history). '
      + 'Use it when a recorded relation turns out to be wrong, instead of leaving a misleading edge on the board.',
    parameters: {
      from: { type: 'string', required: true, description: 'Source node id or unique prefix.' },
      to: { type: 'string', required: true, description: 'Target node id or unique prefix.' },
      relation: { type: 'string', description: 'Edge kind to remove when several relations exist between the same pair.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['unlink', String(args.from), String(args.to)];
      if (args.relation) argv.push('--rel', String(args.relation));
      argv.push('--json');
      const edge = await callJson(argv, exec, 'blackboard unlink');
      return `Unlinked ${edgeSummary(edge)}`;
    },
  }));

  tools.push(defineTool({
    name: 'blackboard_remove',
    description:
      'Remove a node and its relations from the board; the append-only log keeps the history. '
      + 'Prefer blackboard_edit (status dead/superseded/refuted) when you only want to retire a claim; remove is for entries that should never have been recorded.',
    parameters: {
      id: { type: 'string', required: true, description: 'Node id or unique prefix.' },
      reason: { type: 'string', description: 'Why it is being removed; recorded on the removal event.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const argv = ['remove', String(args.id)];
      if (args.reason) argv.push('--reason', String(args.reason));
      argv.push('--json');
      const result = await callJson(argv, exec, 'blackboard remove');
      const edges = Array.isArray(result.edges) ? result.edges.length : 0;
      return `Removed ${result.id}${edges ? ` (${edges} relations)` : ''}`;
    },
  }));

  return tools;
}

/** Exported for tests and prompt text. */
export { nodeSummary, edgeSummary };
