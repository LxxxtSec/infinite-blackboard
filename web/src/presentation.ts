import type { BoardNode, Lesson } from './types';

const TYPE_LABELS: Record<string, string> = {
  goal: '目标', intent: '意图', hypothesis: '假设', question: '问题',
  fact: '事实', observation: '观察', action: '行动', result: '结果',
  finding: '发现', vuln: '漏洞', hint: '提示', summary: '摘要',
  note: '记录', compact: '压缩', start: '起点',
  unit: '代码单元', stage: '攻击阶段', primitive: '利用原语',
  mitigation: '缓解措施', concept: '概念', answer: '回答',
};
const STATUS_LABELS: Record<string, string> = {
  active: '进行中', open: '待验证', done: '已完成', confirmed: '已确认',
  dead: '已排除', refuted: '已反驳', blocked: '受阻', superseded: '已取代', deferred: '暂缓', pending: '待处理',
  removed: '已移除',
};
const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息',
};
const CONFIDENCE_LABELS: Record<string, string> = {
  suspected: '待验证', 'static-confirmed': '静态确认', reproduced: '已复现', confirmed: '已确认',
};
export const PHASE_LABELS: Record<string, string> = {
  entry: '入口', surface: '攻击面', trigger: '触发', primitive: '原语',
  leak: '泄露', spray: '喷洒', overwrite: '覆写', bypass: '绕过',
  escalate: '提权', impact: '影响', cleanup: '清理',
};
export const UNIT_KIND_LABELS: Record<string, string> = {
  function: '函数', struct: '结构体', enum: '枚举', macro: '宏', file: '文件',
};
export const DIFFICULTY_LABELS: Record<string, string> = {
  starter: '入门', advanced: '进阶', expert: '硬核',
};
export const LESSON_LEVEL_LABELS: Record<string, string> = {
  overview: '大局讲解', unit: '分步讲解', line: '逐行讲解',
};
export const LINE_NOTE_LABELS: Record<string, string> = {
  note: '说明', key: '关键', danger: '危险点', payload: '载荷', check: '检查点',
};

export const typeLabel = (type: string) => TYPE_LABELS[type] || type;
export const statusLabel = (status?: string) => status ? STATUS_LABELS[status] || status : '未设置';
export const severityLabel = (severity?: string) => severity ? SEVERITY_LABELS[severity] || severity : '未评估';
export const confidenceLabel = (confidence?: string) => confidence ? CONFIDENCE_LABELS[confidence] || confidence : '未声明';
export const phaseLabel = (phase?: string) => phase ? PHASE_LABELS[phase] || phase : '未设置';
export const unitKindLabel = (kind?: string) => kind ? UNIT_KIND_LABELS[kind] || kind : '单元';
export const difficultyLabel = (difficulty?: string | null) => difficulty ? DIFFICULTY_LABELS[difficulty] || difficulty : '';
export const lessonLevelLabel = (level?: string) => level ? LESSON_LEVEL_LABELS[level] || level : '讲解';

/** Preserve the authored text: only split the first sentence from its evidence. */
export function presentNode(node: Pick<BoardNode, 'title' | 'detail'>) {
  const title = node.title.trim() || '未命名节点';
  const boundary = title.search(/[。！？\n]/u);
  const headline = boundary > 0 ? title.slice(0, boundary) : title;
  const continuation = boundary > 0 ? title.slice(boundary + 1).trim() : '';
  const detail = node.detail?.trim() || '';
  return { headline, summary: continuation || detail, detail: continuation && detail && continuation !== detail ? detail : '' };
}

/** Search the full board, including details and human-readable type/status labels. */
export function matchesNode(node: BoardNode, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${node.id} ${node.title} ${node.detail || ''} ${node.type} ${node.file || ''} ${node.symbol || ''} ${(node.tags || []).join(' ')} ${typeLabel(node.type)} ${statusLabel(node.status)} ${severityLabel(node.severity)} ${confidenceLabel(node.confidence)}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Code anchors are shown next to the symbol; pentest nodes keep their old line. */
export function unitLocation(node: Pick<BoardNode, 'type' | 'file' | 'startLine' | 'endLine'>) {
  if (node.type !== 'unit' || !node.file) return '';
  return `${node.file}:${node.startLine ?? '?'}-${node.endLine ?? '?'}`;
}

export type NodeFilter = { types: string[]; statuses: string[]; confidences: string[]; riskOnly: boolean };
export const EMPTY_FILTER: NodeFilter = { types: [], statuses: [], confidences: [], riskOnly: false };
export const filterActive = (filter: NodeFilter) => filter.types.length > 0 || filter.statuses.length > 0 || filter.confidences.length > 0 || filter.riskOnly;

/** Values within one facet are alternatives (OR); facets narrow each other (AND). */
export function filterNodes(nodes: BoardNode[], filter: NodeFilter) {
  return nodes.filter((node) =>
    (!filter.types.length || filter.types.includes(node.type)) &&
    (!filter.statuses.length || filter.statuses.includes(node.status || '')) &&
    (!filter.confidences.length || filter.confidences.includes(node.confidence || '')) &&
    (!filter.riskOnly || node.severity === 'critical' || node.severity === 'high'));
}

/** Which lessons explain this node (unit target or overlapping lines). */
export function lessonsForNode(lessons: Lesson[], node: BoardNode | null | undefined): Lesson[] {
  if (!node) return [];
  return lessons.filter((lesson) => {
    if (lesson.target?.unit === node.id) return true;
    if (node.type !== 'unit' || !node.file) return false;
    return (lesson.target?.lines || []).some((range) => range.file === node.file
      && range.start <= (node.endLine || node.startLine || 0)
      && range.end >= (node.startLine || 0));
  });
}

/** file → line → line notes, for the code panel gutter. */
export function lineNotesForFile(lessons: Lesson[], file: string) {
  const index = new Map<number, Lesson['lineNotes'][number][]>();
  for (const lesson of lessons) {
    for (const note of lesson.lineNotes || []) {
      if (note.file !== file) continue;
      const annotated = { ...note, lessonId: lesson.id, lessonTitle: lesson.title };
      if (!index.has(note.line)) index.set(note.line, []);
      index.get(note.line)!.push(annotated);
    }
  }
  return index;
}
