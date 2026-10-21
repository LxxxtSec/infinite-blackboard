// Shared blackboard model. Imported by the CLI, server, and browser viewer.
// Keep this file free of Node-only APIs.

export const NODE_TYPES = [
  'start', 'goal', 'intent', 'observation', 'fact', 'hypothesis', 'question',
  'action', 'result', 'finding', 'vuln', 'hint', 'summary', 'note',
  // Teaching-board types. Code units are nodes too, so replay/edges/viewer
  // work unchanged and older clients fall back to neutral styling.
  'unit', 'stage', 'primitive', 'mitigation', 'concept', 'answer',
  // Legacy node type. New compaction events use checkpoints instead.
  'compact',
];

export const EDGE_KINDS = [
  'related-to', 'derived-from', 'supports', 'contradicts', 'depends-on',
  'proves', 'caused-by', 'refines', 'duplicates', 'supersedes', 'resolves',
  // Teaching-board relations: code structure plus exploit-chain semantics.
  'calls', 'includes', 'data-flow', 'implements', 'enables', 'bypasses',
  'step-before', 'part-of', 'explains',
  // Legacy relations remain readable.
  'derive', 'intent-chain', 'produce', 'prove',
];

export const TYPE_PREFIX = {
  start: 's', goal: 'g', intent: 'i', observation: 'o', fact: 'f',
  hypothesis: 'hy', question: 'q', action: 'a', result: 'r', finding: 'fd',
  vuln: 'v', hint: 'h', summary: 'sm', note: 'n', compact: 'c',
  unit: 'u', stage: 'st', primitive: 'pr', mitigation: 'mt', concept: 'cc',
  answer: 'an',
};

export const TYPE_LABEL = {
  start: '起点', goal: '目标', intent: '意图', observation: '观察', fact: '事实',
  hypothesis: '猜测', question: '问题', action: '行动', result: '结果',
  finding: '发现', vuln: '漏洞', hint: '提示', summary: '摘要', note: '记录',
  compact: '压缩',
  unit: '代码单元', stage: '攻击阶段', primitive: '利用原语',
  mitigation: '缓解措施', concept: '概念', answer: '回答',
};

export const EDGE_LABEL = {
  'related-to': '相关', 'derived-from': '派生自', supports: '支持',
  contradicts: '反驳', 'depends-on': '依赖', proves: '证明',
  'caused-by': '由…导致', refines: '细化', duplicates: '重复',
  supersedes: '取代', resolves: '解决',
  calls: '调用', includes: '包含', 'data-flow': '数据流', implements: '实现',
  enables: '使能', bypasses: '绕过', 'step-before': '先于', 'part-of': '属于',
  explains: '讲解',
  derive: '派生', 'intent-chain': '意图链', produce: '产出', prove: '证明',
};

export const NODE_STATES = [
  'open', 'active', 'done', 'blocked', 'dead', 'confirmed', 'refuted', 'deferred',
  'superseded',
];
export const INTENT_STATUS = NODE_STATES;
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
// Confidence is independent from workflow status and severity. A candidate can
// be active, a reproduced issue can still be under remediation, and neither
// concept should be inferred from the node type.
export const CONFIDENCE_LEVELS = ['suspected', 'static-confirmed', 'reproduced', 'confirmed'];
export const CONFIDENCE_LABEL = {
  suspected: '待验证',
  'static-confirmed': '静态确认',
  reproduced: '已复现',
  confirmed: '已确认',
};

// ---- Teaching-board vocabulary (additive) -------------------------------
export const UNIT_KINDS = ['function', 'struct', 'enum', 'macro', 'file'];
export const UNIT_KIND_LABEL = {
  function: '函数', struct: '结构体', enum: '枚举', macro: '宏', file: '文件',
};
export const PHASES = [
  'entry', 'surface', 'trigger', 'primitive', 'leak', 'spray',
  'overwrite', 'bypass', 'escalate', 'impact', 'cleanup',
];
export const PHASE_LABEL = {
  entry: '入口', surface: '攻击面', trigger: '触发', primitive: '原语',
  leak: '泄露', spray: '喷洒', overwrite: '覆写', bypass: '绕过',
  escalate: '提权', impact: '影响', cleanup: '清理',
};
export const DIFFICULTY_LEVELS = ['starter', 'advanced', 'expert'];
export const DIFFICULTY_LABEL = { starter: '入门', advanced: '进阶', expert: '硬核' };
export const LESSON_SCHEMA = 'blackboard.lesson.v1';
export const LESSON_LEVELS = ['overview', 'unit', 'line'];
export const LESSON_LEVEL_LABEL = { overview: '大局讲解', unit: '分步讲解', line: '逐行讲解' };
export const LINE_NOTE_KINDS = ['note', 'key', 'danger', 'payload', 'check'];
export const LINE_NOTE_LABEL = {
  note: '说明', key: '关键', danger: '危险点', payload: '载荷', check: '检查点',
};
export const REQUEST_STATUS = ['open', 'answered', 'closed'];

export function emptyGraph() {
  return {
    meta: {}, nodes: {}, edges: {}, cursors: {}, cursorTrail: [],
    activities: {}, checkpoints: {},
    // Teaching-board side tables. Empty on pentest boards, so existing
    // consumers keep seeing exactly the same shape they saw before.
    files: {}, lessons: {}, requests: {}, replies: {},
    // Events the log held but replay could not use; lint reports them.
    integrity: { corruptLines: 0, rejected: 0 },
  };
}

/** Replay one event onto the blackboard in place. Events are the source of truth. */
export function apply(g, ev) {
  if (!ev || typeof ev !== 'object') return g;
  switch (ev.op) {
    case 'node':
      if (ev.node && typeof ev.node.id === 'string' && ev.node.id && typeof ev.node.type === 'string') {
        g.nodes[ev.node.id] = ev.node;
      } else if (g.integrity) g.integrity.rejected++;
      break;
    case 'edge': {
      // An edge is only meaningful between two existing, distinct nodes; a
      // damaged or hand-edited log must not leave dangling edges in the graph.
      const e = ev.edge;
      if (e && typeof e.id === 'string' && e.id && e.from !== e.to && g.nodes[e.from] && g.nodes[e.to]) {
        g.edges[e.id] = e;
      } else if (g.integrity) g.integrity.rejected++;
      break;
    }
    case 'patch': {
      const n = g.nodes[ev.id];
      if (n && ev.set) {
        // A node's identity and creation time are fixed; everything else may change.
        const { id: _id, ts: _ts, ...rest } = ev.set;
        if (typeof rest.type !== 'string' || !rest.type) delete rest.type;
        Object.assign(n, rest);
      }
      break;
    }
    case 'cursor': {
      const c = ev.cursor;
      if (!c || !c.agentId) break;
      g.cursors[c.agentId] = c;
      g.cursorTrail.push(c);
      // Legacy projection for old viewers and exports.
      if (c.agentId === 'agent:primary') g.meta.focus = c.to || null;
      break;
    }
    // Teaching-board side tables. Unknown/broken records are ignored (or
    // counted) instead of failing replay, like every other event.
    case 'file': {
      const f = ev.file;
      if (f && typeof f.path === 'string' && f.path) g.files[f.path] = f;
      else if (g.integrity) g.integrity.rejected++;
      break;
    }
    case 'lesson': {
      const l = ev.lesson;
      if (l && typeof l.id === 'string' && l.id) g.lessons[l.id] = l;
      else if (g.integrity) g.integrity.rejected++;
      break;
    }
    case 'request': {
      const r = ev.request;
      if (r && typeof r.id === 'string' && r.id) g.requests[r.id] = r;
      else if (g.integrity) g.integrity.rejected++;
      break;
    }
    case 'reply': {
      const r = ev.reply;
      if (r && typeof r.id === 'string' && r.id && r.requestId) g.replies[r.id] = r;
      else if (g.integrity) g.integrity.rejected++;
      break;
    }
    case 'activity':
      if (ev.activity && ev.activity.id) g.activities[ev.activity.id] = ev.activity;
      break;
    case 'checkpoint':
      if (ev.checkpoint && ev.checkpoint.id) g.checkpoints[ev.checkpoint.id] = ev.checkpoint;
      break;
    case 'meta':
      if (ev.set) Object.assign(g.meta, ev.set);
      break;
    case 'reset':
      return emptyGraph();
    default:
      break;
  }
  return g;
}

export function applyAll(g, events) {
  // `apply` returns a fresh graph for `reset`, so its result must be kept.
  for (const ev of events) g = apply(g, ev);
  return g;
}

/** The default relation is deliberately weak; semantic links are Agent decisions. */
export function inferEdgeKind() {
  return 'related-to';
}

/** Next short id for `prefix` ("n" → n1, n2…), derived from what already exists. */
export function nextShortId(existing, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const id of Object.keys(existing)) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let id = `${prefix}${max + 1}`;
  while (existing[id]) id = `${prefix}${Number(id.slice(prefix.length)) + 1}`;
  return id;
}

/**
 * Resolve what an Agent typed to a real id. Accepts the exact id, the form
 * copied out of a digest ("[n12]"), a case-insensitive match, or a unique prefix
 * (handy for older, long ids). Ambiguity is an error that lists the candidates.
 */
export function resolveRef(map, ref, label = 'node') {
  const raw = String(ref ?? '').trim();
  const clean = raw.replace(/^[[#@]+/, '').replace(/[\],.;:)]+$/, '');
  if (!clean) throw new Error(`no such ${label}: ${raw}`);
  if (map[clean]) return clean;
  const keys = Object.keys(map);
  const lower = clean.toLowerCase();
  const ci = keys.filter((k) => k.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];
  const prefixed = keys.filter((k) => k.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    const shown = prefixed.slice(0, 5).join(', ');
    throw new Error(`ambiguous ${label} reference "${clean}": ${shown}${prefixed.length > 5 ? ', …' : ''}`);
  }
  throw new Error(`no such ${label}: ${clean}`);
}

export function edgeId(from, to, kind) {
  return `${from}->${to}:${kind}`;
}

export function currentCursor(g, agentId = 'agent:primary') {
  return g.cursors?.[agentId]?.to || (agentId === 'agent:primary' ? g.meta?.focus : null) || null;
}

/** A unit is a node with type 'unit'; edges, cursor and digest work unchanged. */
export const isUnit = (node) => node?.type === 'unit';

export function unitOf(g, id) {
  const node = id ? g.nodes[id] : null;
  return isUnit(node) ? node : null;
}

export function unitsOf(g) {
  return Object.values(g.nodes || {}).filter(isUnit);
}

export function orderedStages(g) {
  const stages = Object.values(g.nodes || {}).filter((n) => n.type === 'stage' && n.status !== 'removed');
  const order = new Map();
  for (const edge of Object.values(g.edges || {})) {
    if (edge.kind !== 'step-before') continue;
    // from step-before to: `from` runs first.
    if (!order.has(edge.from)) order.set(edge.from, []);
    order.get(edge.from).push(edge.to);
  }
  // Kahn-style topological order over the step-before graph, falling back to
  // BFS from stages that nothing precedes. Cycles keep their creation order.
  const incoming = new Set([...order.values()].flat());
  const starts = stages.filter((s) => !incoming.has(s.id)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const byId = new Map(stages.map((s) => [s.id, s]));
  const seen = new Set();
  const result = [];
  // Depth-first so one exploit chain stays contiguous, then disconnected stages.
  const visit = (stage) => {
    if (seen.has(stage.id)) return;
    seen.add(stage.id);
    result.push(stage);
    for (const id of order.get(stage.id) || []) {
      const node = byId.get(id);
      if (node) visit(node);
    }
  };
  for (const stage of starts) visit(stage);
  for (const stage of stages.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))) visit(stage);
  return result;
}
