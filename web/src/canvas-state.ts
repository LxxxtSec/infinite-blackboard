import type { BoardNode } from './types';

export type DetailLevel = 'overview' | 'compact' | 'detail';
export const detailLevel = (zoom: number): DetailLevel => zoom < .65 ? 'overview' : zoom < .9 ? 'compact' : 'detail';

export const BOARD_GROUPS = [
  { id: 'purpose', title: '目标与摘要', subtitle: '方向 · 当前结论', color: '#647e72' },
  { id: 'reasoning', title: '推理与证据', subtitle: '观察 · 假设 · 行动', color: '#6b7e95' },
  { id: 'findings', title: '发现', subtitle: '已记录的发现与风险', color: '#af7969' },
  { id: 'code', title: '代码单元', subtitle: '函数 · 结构体', color: '#5b7fa3' },
  { id: 'inbox', title: '未连接记录', subtitle: '尚未建立显式关系', color: '#929088' },
] as const;
export type BoardGroupId = typeof BOARD_GROUPS[number]['id'];
export function groupFor(node: BoardNode, connected: Set<string>): BoardGroupId {
  if (['goal', 'start', 'summary', 'compact', 'stage', 'primitive', 'mitigation', 'concept'].includes(node.type)) return 'purpose';
  if (['finding', 'vuln'].includes(node.type)) return 'findings';
  if (node.type === 'unit') return 'code';
  return connected.has(node.id) ? 'reasoning' : 'inbox';
}

/** Direct neighbours only: highlight real edges, never invent a reasoning path. */
export function focusedIds(selectedId: string | null, edges: { source: string; target: string }[]) {
  const ids = new Set<string>();
  if (!selectedId) return ids;
  ids.add(selectedId);
  for (const edge of edges) {
    if (edge.source === selectedId) ids.add(edge.target);
    if (edge.target === selectedId) ids.add(edge.source);
  }
  return ids;
}

/**
 * Lock-focus neighbourhood: the seed plus `depth` hops along explicit edges.
 * Depth 2 on a stage shows its implementing units and their callers/callees.
 */
export function relatedIds(seedId: string | null, edges: { source: string; target: string }[], depth = 2) {
  const ids = new Set<string>();
  if (!seedId) return ids;
  ids.add(seedId);
  let frontier = [seedId];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const edge of edges) {
      const source = frontier.includes(edge.source) ? edge.source : null;
      const target = frontier.includes(edge.target) ? edge.target : null;
      if (source && !ids.has(edge.target)) { ids.add(edge.target); next.push(edge.target); }
      if (target && !ids.has(edge.source)) { ids.add(edge.source); next.push(edge.source); }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return ids;
}

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
export type Box = { id: string; x: number; y: number; w: number; h: number };

/**
 * Keyboard traversal along explicit edges only: of the selected node's one-hop
 * neighbours, pick the one lying most directly in the pressed direction.
 */
export function neighborInDirection(selectedId: string | null, boxes: Box[], edges: { source: string; target: string }[], key: ArrowKey): string | null {
  if (!selectedId) return null;
  const centre = new Map(boxes.map((box) => [box.id, { x: box.x + box.w / 2, y: box.y + box.h / 2 }]));
  const from = centre.get(selectedId);
  if (!from) return null;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  let best: { id: string; score: number } | null = null;
  const seen = new Set<string>();
  for (const edge of edges) {
    const peer = edge.source === selectedId ? edge.target : edge.target === selectedId ? edge.source : null;
    const at = peer && centre.get(peer);
    if (!peer || !at || seen.has(peer)) continue;
    seen.add(peer);
    const along = ((horizontal ? at.x - from.x : at.y - from.y)) * sign;
    const across = Math.abs(horizontal ? at.y - from.y : at.x - from.x);
    if (along <= 0) continue;
    const score = along + across * 2;
    if (!best || score < best.score) best = { id: peer, score };
  }
  return best?.id ?? null;
}
