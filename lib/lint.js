// Read-only quality hints for a blackboard. Lint never changes the graph and
// never blocks an Agent action; it only makes context drift visible.

import { currentCursor, unitsOf } from './model.js';
import { coveredUnitIds, lessonStaleFiles, teachingUnits } from './teach.js';

function issue(level, code, message, nodeIds = [], detail = {}) {
  return { level, code, message, nodeIds, ...detail };
}

export function lintGraph(g, { maxTitleLength = 80 } = {}) {
  const nodes = Object.values(g.nodes || {});
  const edges = Object.values(g.edges || {});
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (incoming.has(e.to)) incoming.get(e.to).push(e);
    if (outgoing.has(e.from)) outgoing.get(e.from).push(e);
  }

  const issues = [];
  const { corruptLines = 0, rejected = 0 } = g.integrity || {};
  if (corruptLines || rejected) {
    const parts = [];
    if (corruptLines) parts.push(`${corruptLines} 行无法解析的日志`);
    if (rejected) parts.push(`${rejected} 条不合法的节点/关系事件`);
    issues.push(issue(
      'warn', 'log-integrity',
      `事件日志里有 ${parts.join('、')}，回放时已跳过；对应内容不会出现在黑板上，请检查 .flow/events.jsonl。`,
      [], { corruptLines, rejected },
    ));
  }

  const long = nodes.filter((n) => [...String(n.title || '')].length > maxTitleLength);
  if (long.length) {
    issues.push(issue(
      'warn', 'long-titles',
      `${long.length} 个节点标题超过 ${maxTitleLength} 字；建议把证据和过程移入 detail。`,
      long.slice(0, 20).map((n) => n.id),
      { count: long.length },
    ));
  }

  // Code units are anchors, not claims; a macro with no edge is normal.
  const isolated = nodes.filter((n) => n.type !== 'unit' && !linked.has(n.id));
  if (isolated.length) {
    const byType = {};
    for (const n of isolated) byType[n.type] = (byType[n.type] || 0) + 1;
    issues.push(issue(
      isolated.length > nodes.length / 2 ? 'warn' : 'info',
      'isolated-nodes',
      `${isolated.length}/${nodes.length} 个逻辑节点尚未建立关系；它们仍可保留在未整理区。`,
      isolated.slice(0, 20).map((n) => n.id),
      { count: isolated.length, byType },
    ));
  }

  // Edges read "from <kind> to". A conclusion is evidenced by something that
  // supports/proves it (incoming), or by being derived from / caused by something (outgoing).
  const EVIDENCE_IN = ['supports', 'proves', 'prove', 'derive', 'produce'];
  const EVIDENCE_OUT = ['derived-from', 'caused-by'];
  const unsupported = nodes.filter((n) => {
    if (!['finding', 'vuln'].includes(n.type) || n.status === 'superseded') return false;
    return !(incoming.get(n.id) || []).some((e) => EVIDENCE_IN.includes(e.kind))
      && !(outgoing.get(n.id) || []).some((e) => EVIDENCE_OUT.includes(e.kind));
  });
  if (unsupported.length) {
    issues.push(issue(
      'warn', 'unsupported-conclusions',
      `${unsupported.length} 个 finding/vuln 没有显式证据边；这不阻止记录，但会降低可恢复性。`,
      unsupported.slice(0, 20).map((n) => n.id),
      { count: unsupported.length },
    ));
  }

  const findings = nodes.filter((n) => ['finding', 'vuln'].includes(n.type) && n.status !== 'superseded');
  const missingConfidence = findings.filter((n) => !n.confidence);
  if (missingConfidence.length) {
    issues.push(issue(
      'info', 'missing-confidence',
      `${missingConfidence.length} 个 finding/vuln 尚未声明可信度；无法区分待验证、静态确认和已复现。`,
      missingConfidence.slice(0, 20).map((n) => n.id),
      { count: missingConfidence.length },
    ));
  }

  // Reachability is undirected here: scope only asks whether a conclusion is
  // attached to an objective, never what direction the reasoning must take.
  const goals = nodes.filter((n) => n.type === 'goal');
  if (goals.length) {
    const adjacency = new Map(nodes.map((n) => [n.id, []]));
    for (const edge of edges) {
      adjacency.get(edge.from)?.push(edge.to);
      adjacency.get(edge.to)?.push(edge.from);
    }
    const scoped = new Set(goals.map((n) => n.id));
    const queue = [...scoped];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) || []) {
        if (!scoped.has(next)) { scoped.add(next); queue.push(next); }
      }
    }
    const unscoped = findings.filter((n) => !scoped.has(n.id));
    if (unscoped.length) {
      issues.push(issue(
        'info', 'unscoped-findings',
        `${unscoped.length} 个 finding/vuln 无法沿显式关系回到任何目标；审计覆盖范围难以恢复。`,
        unscoped.slice(0, 20).map((n) => n.id),
        { count: unscoped.length },
      ));
    }
  }

  const compoundThreads = nodes.filter((n) => {
    if (!['intent', 'hypothesis', 'question'].includes(n.type) ||
      !['open', 'active', 'blocked'].includes(n.status || 'open')) return false;
    const text = `${n.title || ''} ${n.detail || ''}`;
    const numbered = text.match(/(?:^|[\s；;])(?:\(\d+\)|（\d+）|\d+[.)、])/g) || [];
    return numbered.length >= 2;
  });
  if (compoundThreads.length) {
    issues.push(issue(
      'info', 'compound-open-threads',
      `${compoundThreads.length} 个开放节点包含多个编号事项；拆成可独立结束的问题后更容易递推和交接。`,
      compoundThreads.slice(0, 20).map((n) => n.id),
      { count: compoundThreads.length },
    ));
  }

  const cursorId = currentCursor(g);
  const cursor = cursorId ? g.nodes[cursorId] : null;
  if (cursor && ['done', 'dead', 'refuted', 'superseded'].includes(cursor.status)) {
    issues.push(issue('warn', 'stale-cursor', `当前游标停在已结束节点 ${cursor.id} (${cursor.status})。`, [cursor.id]));
  } else if (cursor && ['finding', 'vuln'].includes(cursor.type) &&
    (cursor.status === 'confirmed' || ['reproduced', 'confirmed'].includes(cursor.confidence))) {
    issues.push(issue(
      'info', 'settled-finding-cursor',
      `当前游标停在已经收束的结论 ${cursor.id}；若研究已转向其他问题，应把游标移到真实开放方向。`,
      [cursor.id],
    ));
  } else if (cursor && !(incoming.get(cursor.id)?.length || outgoing.get(cursor.id)?.length)) {
    issues.push(issue('info', 'isolated-cursor', `当前节点 ${cursor.id} 没有直接逻辑邻域。`, [cursor.id]));
  }

  const danglingSuperseded = nodes.filter((n) => n.status === 'superseded' &&
    ![...(incoming.get(n.id) || []), ...(outgoing.get(n.id) || [])].some((e) => e.kind === 'supersedes'));
  if (danglingSuperseded.length) {
    issues.push(issue(
      'info', 'unexplained-superseded',
      `${danglingSuperseded.length} 个 superseded 节点没有指出替代它的新结论。`,
      danglingSuperseded.map((n) => n.id),
    ));
  }

  const checkpoints = Object.values(g.checkpoints || {}).sort((a, b) => (a.at || 0) - (b.at || 0));
  if (cursor && ['intent', 'question', 'hypothesis'].includes(cursor.type) && ['open', 'active'].includes(cursor.status || 'open')) {
    const closing = checkpoints.find((c) => c.cursorNodeId === cursor.id &&
      /(?:完成|收尾|结束|已确认|已关闭)/.test(String(c.summary || '')));
    if (closing) {
      issues.push(issue(
        'warn', 'checkpoint-status-drift',
        `检查点 ${closing.id} 表示当前方向已经收束，但节点 ${cursor.id} 仍为 ${cursor.status || 'open'}。`,
        [cursor.id], { checkpointId: closing.id },
      ));
    }
  }

  // Teaching-board checks. A board without code units never reaches these,
  // so the pentest lint output stays unchanged.
  const units = unitsOf(g).filter((unit) => unit.status !== 'removed');
  if (units.length) {
    const missingFiles = units.filter((unit) => !g.files?.[unit.file]);
    if (missingFiles.length) {
      issues.push(issue(
        'warn', 'missing-code-files',
        `${missingFiles.length} 个代码单元指向未导入的文件；行号锚点可能失效。`,
        missingFiles.slice(0, 20).map((unit) => unit.id),
        { count: missingFiles.length },
      ));
    }

    const badRanges = units.filter((unit) => {
      const file = g.files?.[unit.file];
      return !unit.startLine || !unit.endLine || unit.startLine > unit.endLine
        || (file?.lines && unit.endLine > file.lines);
    });
    if (badRanges.length) {
      issues.push(issue(
        'warn', 'unit-range',
        `${badRanges.length} 个代码单元的行号范围越界或颠倒，代码面板可能定位不到。`,
        badRanges.slice(0, 20).map((unit) => unit.id),
        { count: badRanges.length },
      ));
    }

    const covered = coveredUnitIds(g);
    const uncovered = teachingUnits(g).filter((unit) => !covered.has(unit.id));
    if (uncovered.length) {
      issues.push(issue(
        'info', 'uncovered-units',
        `${uncovered.length}/${teachingUnits(g).length} 个可讲解代码单元还没有讲解，学生视角仍是“未讲”。`,
        uncovered.slice(0, 20).map((unit) => unit.id),
        { count: uncovered.length },
      ));
    }

    const lessons = Object.values(g.lessons || {});
    const stale = lessons.filter((lesson) => lessonStaleFiles(g, lesson).length);
    if (stale.length) {
      issues.push(issue(
        'warn', 'stale-lessons',
        `${stale.length} 个讲解写在旧代码上（文件 hash 已变），建议重新生成再给学生看。`,
        stale.map((lesson) => lesson.id),
        { count: stale.length },
      ));
    }

    const thinLineLessons = lessons.filter((lesson) => lesson.level === 'line' && !(lesson.lineNotes || []).length);
    if (thinLineLessons.length) {
      issues.push(issue(
        'info', 'line-lesson-without-notes',
        `${thinLineLessons.length} 个逐行讲解没有行级批注，代码面板不会出现行内提示。`,
        thinLineLessons.map((lesson) => lesson.id),
        { count: thinLineLessons.length },
      ));
    }

    const answered = new Set(Object.values(g.replies || {}).map((reply) => reply.requestId));
    const openRequests = Object.values(g.requests || {})
      .filter((request) => !answered.has(request.id) && request.status !== 'closed');
    if (openRequests.length) {
      issues.push(issue(
        'info', 'open-requests',
        `${openRequests.length} 条学生提问还没有回答；可用 blackboard requests 查看。`,
        openRequests.map((request) => request.id),
        { count: openRequests.length },
      ));
    }

    const stages = Object.values(g.nodes || {}).filter((node) => node.type === 'stage' && node.status !== 'removed');
    const emptyStages = stages.filter((stage) => !edges.some((edge) => edge.kind === 'implements' && edge.to === stage.id));
    if (emptyStages.length) {
      issues.push(issue(
        'info', 'stage-without-units',
        `${emptyStages.length} 个攻击阶段还没有关联实现代码，学生无法从阶段跳到代码。`,
        emptyStages.map((stage) => stage.id),
        { count: emptyStages.length },
      ));
    }
  }

  return {
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      issues: issues.length,
      warnings: issues.filter((x) => x.level === 'warn').length,
      infos: issues.filter((x) => x.level === 'info').length,
      units: units.length,
      lessons: Object.keys(g.lessons || {}).length,
      requests: Object.keys(g.requests || {}).length,
    },
    issues,
  };
}
