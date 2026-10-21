import ELK, { type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';
import type { EdgeRoute } from './edge-route';
import type { BoardEdge, BoardNode, GraphSnapshot, ViewMode } from './types';
import { values } from './types';
import { matchesNode, presentNode } from './presentation';
import { BOARD_GROUPS, groupFor } from './canvas-state';
export { typeLabel } from './presentation';

export const NODE_W = 288;
export const NODE_H = 128;
export const NODE_H_TITLE = 88;

const elk = new ELK();

export type CanvasNodeData = Record<string, unknown> & {
  item: BoardNode;
  current: boolean;
  dimmed: boolean;
  degree: number;
  compact?: boolean;
  group?: boolean;
  muted?: boolean;
  fresh?: boolean;
  groupCount?: number;
  groupSubtitle?: string;
  groupColor?: string;
  direction?: 'RIGHT' | 'DOWN';
};

export type CanvasNode = Node<CanvasNodeData, 'security' | 'boardGroup'>;

/** Node types that belong to the teaching overlay; empty on pentest boards. */
export const TEACHING_TYPES = new Set([
  'unit', 'stage', 'primitive', 'mitigation', 'concept',
  'goal', 'question', 'answer', 'note', 'summary', 'finding', 'vuln',
]);

export const hasTeachingData = (snapshot: GraphSnapshot | null | undefined): boolean =>
  Boolean(snapshot && (Object.keys(snapshot.files || {}).length
    || values(snapshot.nodes).some((node) => node.type === 'unit' || node.type === 'stage')));

export const currentNodeId = (snapshot: GraphSnapshot): string | null =>
  snapshot.cursors?.['agent:primary']?.to ||
  snapshot.meta?.focus ||
  Object.values(snapshot.cursors || {})[0]?.to ||
  null;

function contextIds(snapshot: GraphSnapshot, nodes: BoardNode[], edges: BoardEdge[]) {
  const ids = new Set<string>();
  const current = currentNodeId(snapshot);
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }

  if (current && adjacency.has(current)) {
    ids.add(current);
    let wave = [current];
    for (let depth = 0; depth < 1; depth += 1) {
      const next: string[] = [];
      for (const id of wave) {
        for (const neighbor of adjacency.get(id) || []) {
          if (!ids.has(neighbor)) {
            ids.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      wave = next;
    }
  }

  nodes.forEach((node) => {
    if (node.type === 'goal') ids.add(node.id);
    if (['intent', 'hypothesis', 'question'].includes(node.type) &&
      ['open', 'active', 'blocked', undefined].includes(node.status)) ids.add(node.id);
  });

  // 现场只展开当前节点的一跳邻域；完整推理路径留给逻辑视图。
  // “当前现场”必须是一张可读的工作台，而不是缩小版全局图。仅补充最高风险
  // 发现和少量最近节点；完整发现仍可从左栏或“全局图”进入。
  nodes
    .filter((node) => ['finding', 'vuln'].includes(node.type) && ['critical', 'high'].includes(node.severity || ''))
    .slice(0, 3)
    .forEach((node) => ids.add(node.id));
  // A teaching board often has no Agent cursor yet. Showing the three most
  // recently written nodes produced a confusing partial chain (usually the last
  // three stages); show the chain skeleton so "现场" still makes sense.
  const stages = nodes.filter((node) => node.type === 'stage' && node.status !== 'removed');
  if (!current && stages.length) {
    stages.forEach((node) => ids.add(node.id));
  } else {
    [...nodes].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 3).forEach((node) => ids.add(node.id));
  }
  return ids;
}

/**
 * Chain order from explicit `step-before` edges (fallback: creation time).
 * Kept in the projection layer so the viewer never invents an ordering.
 */
export function orderedStages(nodes: BoardNode[], edges: { from: string; to: string; kind: string }[]): BoardNode[] {
  const stages = nodes.filter((node) => node.type === 'stage' && node.status !== 'removed');
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const next = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'step-before' || !byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (!next.has(edge.from)) next.set(edge.from, []);
    next.get(edge.from)!.push(edge.to);
    incoming.add(edge.to);
  }
  const starts = stages.filter((stage) => !incoming.has(stage.id)).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const seen = new Set<string>();
  const result: BoardNode[] = [];
  // Depth-first so one exploit chain stays contiguous, then disconnected stages.
  const visit = (stage: BoardNode) => {
    if (seen.has(stage.id)) return;
    seen.add(stage.id);
    result.push(stage);
    for (const id of next.get(stage.id) || []) {
      const node = byId.get(id);
      if (node) visit(node);
    }
  };
  for (const stage of starts) visit(stage);
  for (const stage of stages.slice().sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))) visit(stage);
  return result;
}


export type TeachingLayout = 'hierarchy' | 'chain' | 'files';

const TREE_GAP_X = 96;
const TREE_GAP_Y = 20;
const FILE_PAD = 26;
const FILE_HEADER = 42;
const FILE_COLORS = ['#647e72', '#6b7e95', '#af7969', '#5b7fa3', '#8a7b9b', '#7d8b6a'];

const edgeKind = (edge: Edge): string =>
  String((edge.data as { kind?: string } | undefined)?.kind || 'related-to');
const heightOf = (node: CanvasNode): number => Number(node.style?.height || NODE_H);

function markCross(edges: Edge[], isTree: (edge: Edge) => boolean): Edge[] {
  return edges.map((edge) => ({
    ...edge,
    data: { ...(edge.data as Record<string, unknown> | undefined), cross: !isTree(edge) },
  }));
}

function fileFrame(file: string, index: number, width: number, height: number, count: number, lang: string, deps = ''): CanvasNode {
  const id = `__file_${index}`;
  return {
    id,
    type: 'boardGroup',
    position: { x: 0, y: 0 },
    style: { width, height },
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -1,
    data: {
      item: { id, type: 'fileGroup', title: file, kind: 'file', lang },
      current: false,
      dimmed: false,
      degree: 0,
      group: true,
      groupCount: count,
      groupSubtitle: `${lang || 'text'}${deps ? ` · ${deps}` : ''}`,
      groupColor: FILE_COLORS[index % FILE_COLORS.length],
    },
  } as CanvasNode;
}


/**
 * Learning hierarchy: overall entry functions start top-left, callees move to
 * the right (and progressively lower), so the right/bottom edge of the board is
 * the most basic code to learn first. Each layer is packed into a few rows so a
 * flat call graph does not become a two-kilometre vertical strip.
 */
export function layoutTeachingHierarchy(nodes: CanvasNode[], edges: Edge[]): { nodes: CanvasNode[]; edges: Edge[] } {
  const units = nodes.filter((node) => node.data.item.type === 'unit');
  if (!units.length) return { nodes, edges };
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unitIds = new Set(units.map((unit) => unit.id));
  const calls = edges.filter((edge) => edgeKind(edge) === 'calls' && unitIds.has(edge.source) && unitIds.has(edge.target));
  // Macros are declarations, not call-tree nodes: keep them visible, but park
  // them in a trailing right-hand column instead of letting them become roots.
  const macros = units.filter((unit) => unit.data.item.kind === 'macro');
  const graphUnits = units.filter((unit) => unit.data.item.kind !== 'macro');

  const rank = (node: CanvasNode) => {
    const item = node.data.item;
    if (item.symbol === 'main') return 0;
    if ((item.tags || []).includes('entry')) return 1;
    return 2;
  };
  const order = (a: CanvasNode, b: CanvasNode) => rank(a) - rank(b)
    || String(a.data.item.file || '').localeCompare(String(b.data.item.file || ''))
    || Number(a.data.item.startLine || 0) - Number(b.data.item.startLine || 0);

  const depth = new Map(graphUnits.map((unit) => [unit.id, 0]));
  for (let round = 0; round < 10; round += 1) {
    let changed = false;
    for (const edge of calls) {
      const next = Math.min(8, (depth.get(edge.source) || 0) + 1);
      if ((depth.get(edge.target) || 0) < next) {
        depth.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const layers = new Map<number, CanvasNode[]>();
  for (const unit of graphUnits) {
    const level = depth.get(unit.id) || 0;
    if (!layers.has(level)) layers.set(level, []);
    layers.get(level)!.push(unit);
  }
  const MAX_ROWS = 6;
  let baseX = 0;
  let height = 0;
  const positions = new Map<string, { x: number; y: number }>();
  for (const level of [...layers.keys()].sort((a, b) => a - b)) {
    const list = layers.get(level)!.sort(order);
    const columns = Math.ceil(list.length / MAX_ROWS);
    list.forEach((node, index) => {
      const column = Math.floor(index / MAX_ROWS);
      const row = index % MAX_ROWS;
      positions.set(node.id, {
        x: baseX + column * (NODE_W + TREE_GAP_X),
        // Deeper layers sit a little lower, so overall is top-left and basics
        // drift to the bottom-right instead of only to the right.
        y: level * 46 + row * (heightOf(node) + TREE_GAP_Y),
      });
    });
    baseX += columns * (NODE_W + TREE_GAP_X) + TREE_GAP_X;
    height = Math.max(height, Math.min(MAX_ROWS, list.length) * (NODE_H + TREE_GAP_Y));
  }

  // Macro column: right of every call layer, below the entry rows.
  if (macros.length) {
    const macroY = ((depth.size ? Math.max(...depth.values()) : 0) + 1) * 46;
    macros.sort((a, b) => String(a.data.item.file || '').localeCompare(String(b.data.item.file || ''))
      || Number(a.data.item.startLine || 0) - Number(b.data.item.startLine || 0));
    macros.forEach((node, index) => {
      positions.set(node.id, {
        x: baseX + Math.floor(index / MAX_ROWS) * (NODE_W + TREE_GAP_X),
        y: macroY + (index % MAX_ROWS) * (heightOf(node) + TREE_GAP_Y),
      });
    });
  }

  const laidOut = units.map((node) => ({
    ...node,
    position: positions.get(node.id)!,
    data: { ...node.data, direction: 'RIGHT' as const },
  }));

  // Tree edge = first caller→callee relation; everything else is a cross link.
  const parentOf = new Map<string, string>();
  for (const edge of calls) {
    if (!parentOf.has(edge.target)) parentOf.set(edge.target, edge.source);
  }
  const tree = new Map<string, string>();
  for (const [child, parent] of parentOf) tree.set(`${parent}|${child}`, child);
  const fileOf = (id: string) => byId.get(id)?.data.item.file;
  return {
    nodes: laidOut,
    edges: markCross(edges.filter((edge) => unitIds.has(edge.source) && unitIds.has(edge.target)),
      (edge) => tree.has(`${edge.source}|${edge.target}`))
      .map((edge) => {
        const from = fileOf(edge.source);
        const to = fileOf(edge.target);
        if (edgeKind(edge) !== 'calls' || !from || !to || from === to) return edge;
        const target = byId.get(edge.target)?.data.item;
        return {
          ...edge,
          label: String(target?.symbol || target?.title || ''),
          data: { ...(edge.data as Record<string, unknown> | undefined), crossFile: { from, to } },
        };
      }),
  };
}

/**
 * Exploit-chain tree: stages form a vertical spine in the first column, their
 * implementing units branch to the right, and callees branch again. A node is
 * placed once (first parent wins); later relations stay as cross links.
 */
export function layoutTeachingChain(nodes: CanvasNode[], edges: Edge[]): { nodes: CanvasNode[]; edges: Edge[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stages = orderedStages(
    nodes.map((node) => node.data.item),
    edges.map((edge) => ({ from: edge.source, to: edge.target, kind: edgeKind(edge) })),
  ).map((stage) => stage.id).filter((id) => byId.has(id));

  const next = new Map<string, string[]>();
  const link = (parent: string, child: string) => {
    if (!byId.has(child) || child === parent) return;
    if (!next.has(parent)) next.set(parent, []);
    if (!next.get(parent)!.includes(child)) next.get(parent)!.push(child);
  };
  const treePairs = new Set<string>();
  for (const edge of edges) {
    const kind = edgeKind(edge);
    const targetIsStage = byId.get(edge.target)?.data.item.type === 'stage';
    const sourceIsStage = byId.get(edge.source)?.data.item.type === 'stage';
    if (['implements', 'enables', 'bypasses', 'supports', 'related-to', 'data-flow'].includes(kind) && (targetIsStage || sourceIsStage)) {
      const parent = targetIsStage ? edge.target : edge.source;
      const child = targetIsStage ? edge.source : edge.target;
      link(parent, child);
      treePairs.add(`${parent}|${child}`);
    }
    if (kind === 'calls') {
      link(edge.source, edge.target);
      treePairs.add(`${edge.source}|${edge.target}`);
    }
    if (kind === 'step-before' && sourceIsStage && targetIsStage) treePairs.add(`${edge.source}|${edge.target}`);
  }

  // Units read in file/line order; other nodes by creation time.
  for (const list of next.values()) {
    list.sort((a, b) => {
      const na = byId.get(a)!.data.item;
      const nb = byId.get(b)!.data.item;
      if (na.type === 'unit' && nb.type === 'unit') {
        return String(na.file || '').localeCompare(String(nb.file || '')) || Number(na.startLine || 0) - Number(nb.startLine || 0);
      }
      if (na.type === 'unit') return -1;
      if (nb.type === 'unit') return 1;
      return Number(na.ts || 0) - Number(nb.ts || 0);
    });
  }

  const placed = new Set<string>();
  const spot = new Map<string, { depth: number; y: number }>();
  let maxDepth = 0;
  const place = (id: string, depth: number, yTop: number): number => {
    const node = byId.get(id);
    if (!node || placed.has(id)) return 0;
    placed.add(id);
    maxDepth = Math.max(maxDepth, depth);
    const nodeH = heightOf(node);
    spot.set(id, { depth, y: yTop });
    const kids = (next.get(id) || []).filter((child) => !placed.has(child));
    if (!kids.length) return nodeH;
    let cursor = yTop;
    for (const child of kids) {
      const used = place(child, depth + 1, cursor);
      if (!used) continue;
      cursor += used + TREE_GAP_Y;
    }
    const total = Math.max(nodeH, cursor - yTop - TREE_GAP_Y);
    spot.get(id)!.y = yTop + (total - nodeH) / 2;
    return total;
  };

  const roots = [
    ...nodes.filter((node) => node.data.item.type === 'goal'),
    ...stages.map((id) => byId.get(id)!),
  ];
  let cursorY = 0;
  for (const root of roots) {
    if (placed.has(root.id)) continue;
    cursorY += place(root.id, 0, cursorY) + TREE_GAP_Y * 2;
  }

  // Anything the chain/call tree did not reach goes into one trailing column,
  // so no node silently disappears from the canvas.
  let leftoverY = 0;
  for (const node of nodes) {
    if (placed.has(node.id)) continue;
    placed.add(node.id);
    spot.set(node.id, { depth: maxDepth + 2, y: leftoverY });
    leftoverY += heightOf(node) + TREE_GAP_Y;
  }

  const laidOut = nodes.map((node) => {
    const at = spot.get(node.id)!;
    return {
      ...node,
      position: { x: at.depth * (NODE_W + TREE_GAP_X), y: at.y },
      data: { ...node.data, direction: 'RIGHT' as const },
    };
  });
  const fileOf = (id: string) => byId.get(id)?.data.item.file;
  return {
    nodes: laidOut,
    edges: markCross(edges, (edge) => treePairs.has(`${edge.source}|${edge.target}`) || treePairs.has(`${edge.target}|${edge.source}`))
      .map((edge) => {
        if (edgeKind(edge) !== 'calls') return edge;
        const from = fileOf(edge.source);
        const to = fileOf(edge.target);
        if (!from || !to || from === to) return edge;
        const target = byId.get(edge.target)?.data.item;
        return {
          ...edge,
          label: String(target?.symbol || target?.title || ''),
          data: { ...(edge.data as Record<string, unknown> | undefined), crossFile: { from, to } },
        };
      }),
  };
}

/**
 * File tree: one frame per source file, functions packed into a compact grid
 * inside their own frame. Frames are packed into rows instead of one endless
 * column, and cross-file calls keep a labelled dashed link so a folder with many
 * .c/.h files still shows which file calls which.
 */
export function layoutTeachingFiles(nodes: CanvasNode[], edges: Edge[]): { nodes: CanvasNode[]; edges: Edge[] } {
  const units = nodes.filter((node) => node.data.item.type === 'unit');
  if (!units.length) return { nodes, edges };
  const unitIds = new Set(units.map((unit) => unit.id));
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const fileOf = new Map(units.map((unit) => [unit.id, String(unit.data.item.file || '(unknown)')]));
  const calls = edges.filter((edge) => edgeKind(edge) === 'calls' && unitIds.has(edge.source) && unitIds.has(edge.target));
  const kept = edges.filter((edge) => unitIds.has(edge.source) && unitIds.has(edge.target));

  const files = new Map<string, CanvasNode[]>();
  for (const unit of units) {
    const file = fileOf.get(unit.id)!;
    if (!files.has(file)) files.set(file, []);
    files.get(file)!.push(unit);
  }

  // Aggregate cross-file calls for the frame subtitle and the sidebar summary.
  const outgoing = new Map<string, Map<string, number>>();
  for (const edge of calls) {
    const from = fileOf.get(edge.source)!;
    const to = fileOf.get(edge.target)!;
    if (from === to) continue;
    if (!outgoing.has(from)) outgoing.set(from, new Map());
    const targets = outgoing.get(from)!;
    targets.set(to, (targets.get(to) || 0) + 1);
  }
  const depsOf = (file: string) => {
    const targets = outgoing.get(file);
    if (!targets) return '';
    const parts = [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([to, count]) => `→ ${to.split('/').pop()} ×${count}`);
    const extra = targets.size > 2 ? ` +${targets.size - 2}` : '';
    return `${parts.join(' ')}${extra}`;
  };

  const MAX_ROWS = 4;
  const MAX_ROW_WIDTH = 2600;
  const laidOut: CanvasNode[] = [];
  let fileIndex = 0;
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const [file, list] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const inFile = new Set(list.map((node) => node.id));
    const depth = new Map(list.map((node) => [node.id, 0]));
    // Longest-path relaxation inside the file, capped to keep wild call graphs sane.
    for (let round = 0; round < 8; round += 1) {
      let changed = false;
      for (const edge of calls) {
        if (!inFile.has(edge.source) || !inFile.has(edge.target)) continue;
        const nextDepth = Math.min(6, (depth.get(edge.source) || 0) + 1);
        if ((depth.get(edge.target) || 0) < nextDepth) {
          depth.set(edge.target, nextDepth);
          changed = true;
        }
      }
      if (!changed) break;
    }
    // Read order: callers before callees, then source order.
    const ordered = list.slice().sort((a, b) =>
      (depth.get(a.id) || 0) - (depth.get(b.id) || 0)
      || Number(a.data.item.startLine || 0) - Number(b.data.item.startLine || 0));
    const rows = Math.min(MAX_ROWS, Math.max(1, ordered.length));
    const columns = Math.ceil(ordered.length / rows);
    const width = FILE_PAD * 2 + columns * NODE_W + Math.max(0, columns - 1) * TREE_GAP_X;
    const height = FILE_HEADER + FILE_PAD * 2 + rows * NODE_H + Math.max(0, rows - 1) * TREE_GAP_Y;

    if (cursorX > 0 && cursorX + width > MAX_ROW_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + TREE_GAP_Y * 3;
      rowHeight = 0;
    }
    const frame = fileFrame(file, fileIndex, width, height, ordered.length, String(ordered[0].data.item.lang || 'text'), depsOf(file));
    frame.position = { x: cursorX, y: cursorY };
    laidOut.push(frame);
    ordered.forEach((node, index) => {
      laidOut.push({
        ...node,
        parentId: frame.id,
        extent: 'parent',
        position: {
          x: FILE_PAD + Math.floor(index / rows) * (NODE_W + TREE_GAP_X),
          y: FILE_HEADER + FILE_PAD + (index % rows) * (NODE_H + TREE_GAP_Y),
        },
        style: { ...node.style, width: NODE_W, height: NODE_H },
        data: { ...node.data, direction: 'RIGHT' as const },
      });
    });
    cursorX += width + TREE_GAP_X * 2;
    rowHeight = Math.max(rowHeight, height);
    fileIndex += 1;
  }

  return {
    nodes: laidOut,
    edges: kept.map((edge) => {
      const fromFile = fileOf.get(edge.source)!;
      const toFile = fileOf.get(edge.target)!;
      const cross = fromFile !== toFile;
      const target = byId.get(edge.target)?.data.item;
      return {
        ...edge,
        // The label names the referenced function, so a cross-file call reads as
        // "heap.c --spray_msg()--> utils.c" instead of an anonymous line.
        label: cross ? String(target?.symbol || target?.title || '') : edge.label,
        data: {
          ...(edge.data as Record<string, unknown> | undefined),
          cross,
          crossFile: cross ? { from: fromFile, to: toFile } : null,
        },
      };
    }),
  };
}

export function project(snapshot: GraphSnapshot, mode: ViewMode, query: string, options: { onlyCode?: boolean } = {}) {
  // Retired nodes (chain replacement, removed units) stay in the log but are
  // no longer part of the live canvas.
  // Macros are looked up through the dedicated macro table, not drawn on the
  // canvas: they have no call edges and would sit there as isolated cards.
  const allNodes = values(snapshot.nodes).filter((node) => node.status !== 'removed'
    && !(node.type === 'unit' && node.kind === 'macro'));
  const existing = new Set(allNodes.map((node) => node.id));
  const allEdges = values(snapshot.edges).filter((edge) => existing.has(edge.from) && existing.has(edge.to));
  const linked = new Set(allEdges.flatMap((edge) => [edge.from, edge.to]));
  const visibleIds = mode === 'all'
    ? new Set(allNodes.map((node) => node.id))
    : mode === 'teaching'
      // Teaching view: chain + code + lessons' anchors, no pentest-only noise.
      ? new Set(allNodes.filter((node) => TEACHING_TYPES.has(node.type)
        && (!options.onlyCode || node.type === 'unit')).map((node) => node.id))
      : mode === 'logic'
        ? linked
        : contextIds(snapshot, allNodes, allEdges);
  const nodes = allNodes.filter((node) => visibleIds.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = allEdges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const degree = new Map<string, number>();
  edges.forEach((edge) => {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  });
  const q = query.trim();
  const current = currentNodeId(snapshot);

  const flowNodes: CanvasNode[] = nodes.map((item) => ({
    id: item.id,
    type: 'security',
    position: { x: 0, y: 0 },
    style: { width: NODE_W, height: presentNode(item).summary || item.role ? NODE_H : NODE_H_TITLE },
    data: {
      item,
      current: item.id === current,
      dimmed: Boolean(q) && !matchesNode(item, q),
      degree: degree.get(item.id) || 0,
    },
  }));

  const flowEdges: Edge[] = edges.map((edge) => {
    const important = ['proves', 'supports', 'contradicts', 'supersedes', 'resolves', 'implements'].includes(edge.kind);
    const group = relationGroup(edge.kind);
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'default',
      label: important ? relationLabel(edge.kind) : undefined,
      className: `edge edge-${edge.kind} edge-g-${group}`,
      data: { kind: edge.kind, group },
      animated: false,
      markerEnd: { type: 'arrowclosed' as const, width: 12, height: 12, color: `var(--edge-${group})` },
      style: { strokeWidth: important ? 1.5 : 1.25 },
    };
  });

  return { nodes: flowNodes, edges: flowEdges, hidden: allNodes.length - nodes.length };
}

/**
 * Stage-only teaching: the stage becomes a header card, its implementing units
 * sit in a compact grid below. The one-to-many `implements` edges are redundant
 * here (they would fan out from a single point), so the caller hides them; only
 * real calls/data-flow between the units remain.
 */
export function layoutTeachingStage(nodes: CanvasNode[], edges: Edge[]): { nodes: CanvasNode[]; edges: Edge[] } {
  const stage = nodes.find((node) => node.data.item.type === 'stage');
  const units = nodes.filter((node) => node.data.item.type === 'unit');
  const columns = units.length > 18 ? 4 : units.length > 9 ? 3 : units.length > 3 ? 2 : 1;
  const gapX = TREE_GAP_X;
  const gapY = TREE_GAP_Y;
  const gridW = columns * NODE_W + (columns - 1) * gapX;
  // A two-column-wide header reads as the parent of the grid without becoming
  // a full-width banner that dwarfs the function cards.
  const stageW = Math.max(NODE_W, Math.min(gridW, NODE_W * 2 + gapX));
  const stageX = Math.max(0, (gridW - stageW) / 2);
  const stageH = NODE_H;
  const laid = nodes.map((node) => {
    if (node.data.item.type === 'stage') {
      return {
        ...node,
        position: { x: stageX, y: 0 },
        style: { ...node.style, width: stageW },
        data: { ...node.data, direction: 'RIGHT' as const },
      };
    }
    const index = units.findIndex((unit) => unit.id === node.id);
    const column = Math.max(0, index) % columns;
    const row = Math.floor(Math.max(0, index) / columns);
    return {
      ...node,
      position: { x: column * (NODE_W + gapX), y: stageH + 48 + row * (heightOf(node) + gapY) },
      data: { ...node.data, direction: 'RIGHT' as const },
    };
  });
  // The stage→unit binding is represented by the header + count, not by 22
  // crossing arrows. Keep only relations between the implementing units.
  return {
    nodes: laid,
    edges: edges.filter((edge) => edgeKind(edge) !== 'implements'),
  };
}

export async function layoutGraph(nodes: CanvasNode[], edges: Edge[], direction: 'RIGHT' | 'DOWN' = 'RIGHT', grouped = false, overviewColumns: 1 | 2 = 2, teaching: TeachingLayout | null = null) {
  if (!nodes.length) return { nodes, edges };
  if (grouped) return layoutOverview(nodes, edges, overviewColumns);
  if (teaching === 'files') return layoutTeachingFiles(nodes, edges);
  if (teaching === 'chain') return layoutTeachingChain(nodes, edges);
  if (teaching === 'hierarchy') return layoutTeachingHierarchy(nodes, edges);
  try {
    return await elkLayout(nodes, edges, direction);
  } catch {
    // A layout engine failure must never leave the board blank.
    return gridLayout(nodes, edges, direction);
  }
}

/** Plain left-to-right grid; used only when ELK cannot lay the graph out. */
export function gridLayout(nodes: CanvasNode[], edges: Edge[], direction: 'RIGHT' | 'DOWN' = 'RIGHT') {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const rowHeight = NODE_H + 40;
  return {
    nodes: nodes.map((node, index) => ({
      ...node,
      data: { ...node.data, direction },
      position: { x: (index % columns) * (NODE_W + 48), y: Math.floor(index / columns) * rowHeight },
    })),
    edges,
  };
}

async function elkLayout(nodes: CanvasNode[], edges: Edge[], direction: 'RIGHT' | 'DOWN') {
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': '36',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: nodes.map((node) => {
      const type = node.data.item.type;
      const layerConstraint = ['goal', 'stage', 'start'].includes(type)
        ? 'FIRST'
        : ['finding', 'vuln', 'unit', 'primitive'].includes(type) ? 'LAST' : undefined;
      return {
        id: node.id,
        width: NODE_W,
        height: Number(node.style?.height || NODE_H),
        ...(layerConstraint ? { layoutOptions: { 'org.eclipse.elk.layered.layering.layerConstraint': layerConstraint } } : {}),
      };
    }),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const positions = new Map((result.children || []).map((node) => [node.id, node]));
  const sections = new Map(((result.edges || []) as ElkExtendedEdge[]).map((edge) => [edge.id, edge.sections?.[0]]));
  const at = (id: string) => ({ x: positions.get(id)?.x || 0, y: positions.get(id)?.y || 0 });
  return {
    nodes: nodes.map((node) => ({ ...node, data: { ...node.data, direction }, position: at(node.id) })),
    // ELK's own routes keep long edges clear of the nodes between their ends.
    edges: edges.map((edge) => {
      const section = sections.get(edge.id);
      if (!section) return edge;
      const route: EdgeRoute = {
        points: [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(({ x, y }) => ({ x, y })),
        source: at(edge.source), target: at(edge.target), direction,
      };
      return { ...edge, data: { ...edge.data, route } };
    }),
  };
}

/** Relation kinds fall into six families; each family has one colour and stroke in the UI. */
export type RelationGroup = 'support' | 'oppose' | 'derive' | 'produce' | 'replace' | 'link';
export const RELATION_GROUPS: { id: RelationGroup; label: string }[] = [
  { id: 'support', label: '证实' }, { id: 'oppose', label: '反驳' }, { id: 'derive', label: '推导' },
  { id: 'produce', label: '产出' }, { id: 'replace', label: '取代' }, { id: 'link', label: '关联' },
];
const GROUP_OF: Record<string, RelationGroup> = {
  proves: 'support', prove: 'support', supports: 'support', enables: 'support',
  contradicts: 'oppose', bypasses: 'oppose',
  'derived-from': 'derive', derive: 'derive', refines: 'derive', 'caused-by': 'derive',
  'depends-on': 'derive', 'intent-chain': 'derive', calls: 'derive', 'data-flow': 'derive',
  produce: 'produce', resolves: 'produce', implements: 'produce', explains: 'produce',
  supersedes: 'replace', duplicates: 'replace',
  'step-before': 'link', 'part-of': 'link', 'related-to': 'link', includes: 'link',
};
export const relationGroup = (kind: string): RelationGroup => GROUP_OF[kind] || 'link';

/** How connections are drawn; the layout itself is unaffected. */
export type EdgeStyle = 'curve' | 'step' | 'straight';

export function relationLabel(kind: string) {
  return ({
    proves: '证明', prove: '证明', supports: '支持', contradicts: '反驳',
    supersedes: '取代', resolves: '解决', 'derived-from': '派生',
    'depends-on': '依赖', 'caused-by': '因果', refines: '细化',
    'related-to': '相关', produce: '产出',
    calls: '调用', includes: '包含', 'data-flow': '数据流', implements: '实现',
    enables: '使能', bypasses: '绕过', 'step-before': '先于', 'part-of': '属于',
  } as Record<string, string>)[kind] || kind;
}

export function formatTime(value?: number) {
  if (!value || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

/** A display-only catalogue. Group frames never enter the persisted graph. */
export function layoutOverview(nodes: CanvasNode[], edges: Edge[], overviewColumns: 1 | 2 = 2) {
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const groups = BOARD_GROUPS.map((group) => ({ ...group, nodes: nodes.filter((node) => groupFor(node.data.item, connected) === group.id) })).filter((group) => group.nodes.length);
  const W = 240, H = 112, gap = 22, pad = 28, top = 90;
  const frames: CanvasNode[] = [], children: CanvasNode[] = [];
  const columns = [0, 0];
  const groupColumns = (size: number) => Math.min(4, Math.max(2, Math.ceil(Math.sqrt(size))));
  const widths = [0, 0];
  groups.forEach((group, i) => { const count = groupColumns(group.nodes.length); widths[i % overviewColumns] = Math.max(widths[i % overviewColumns], pad * 2 + count * W + (count - 1) * gap); });
  for (const [index, group] of groups.entries()) {
    const col = index % overviewColumns;
    const count = groupColumns(group.nodes.length);
    const width = widths[col];
    const height = top + Math.ceil(group.nodes.length / count) * (H + gap) - gap + pad;
    const id = `__display_group_${group.id}`;
    frames.push({ id, type: 'boardGroup', position: { x: col ? widths[0] + 56 : 0, y: columns[col] }, style: { width, height }, draggable: false, selectable: false, focusable: false,
      data: { item: { id, type: 'display-group', title: group.title }, current: false, dimmed: false, degree: 0, group: true, groupCount: group.nodes.length, groupSubtitle: group.subtitle, groupColor: group.color }, zIndex: -1 });
    group.nodes.forEach((node, i) => children.push({ ...node, parentId: id, extent: 'parent', position: { x: pad + (i % count) * (W + gap), y: top + Math.floor(i / count) * (H + gap) }, style: { width: W, height: H }, data: { ...node.data, compact: true, direction: 'RIGHT' } }));
    columns[col] += height + 56;
  }
  return { nodes: [...frames, ...children], edges };
}
