import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesInitialized, useNodesState, useReactFlow,
  type Edge, type OnNodeDrag, type NodeMouseHandler, type OnNodesChange,
} from '@xyflow/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Focus, Lock, X } from 'lucide-react';
import { BoardGroup } from './BoardGroup';
import { BrandMark } from './BrandMark';
import { SecurityNode } from './SecurityNode';
import { focusedIds, neighborInDirection, relatedIds, type ArrowKey } from './canvas-state';
import { exportCanvasPng } from './export-image';
import { RoutedEdge } from './RoutedEdge';
import { currentNodeId, hasTeachingData, layoutGraph, NODE_H, NODE_W, orderedStages, project, typeLabel as typeLabelOf, type CanvasNode, type EdgeStyle, type RelationGroup, type TeachingLayout } from './graph';
import { EMPTY_FILTER, filterActive, filterNodes, lessonsForNode, type NodeFilter } from './presentation';
import type { BoardNode, ViewMode } from './types';
import { values } from './types';
import { useGraphStream } from './use-graph-stream';
import { usePref } from './use-pref';
import { CanvasToolbar } from './panels/CanvasToolbar';
import { CommandPalette } from './panels/CommandPalette';
import { DigestDialog } from './panels/DigestDialog';
import { EmptyBoard } from './panels/EmptyBoard';
import { Legend } from './panels/Legend';
import { ShortcutsDialog } from './panels/ShortcutsDialog';
import { Inspector } from './panels/Inspector';
import { Sidebar } from './panels/Sidebar';
import { StudyPanel } from './panels/StudyPanel';
import { AgentChat } from './panels/AgentChat';
import { ManageDialog } from './panels/ManageDialog';
import { MacroLookup } from './panels/MacroLookup';
import { ResizeHandle } from './ResizeHandle';
import { Topbar } from './panels/Topbar';

const nodeTypes = { security: SecurityNode, boardGroup: BoardGroup };
const edgeTypes = { routed: RoutedEdge };
const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const INSPECTOR_W = 372;
/** Colour of a focused edge's arrowhead: its relation family, or ink when unclassified. */
const focusColor = (group?: string) => group && group !== 'link' ? `var(--rel-${group})` : 'var(--ink)';
const THEME_KEY = 'blackboard-theme-v3';

const initialTheme = (): 'light' | 'dark' => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* storage can be unavailable in sandboxed exports */ }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

function Workspace() {
  const { snapshot, connection, syncedAt, isStatic } = useGraphStream();
  const [mode, setMode] = useState<ViewMode>(() => {
    const view = new URLSearchParams(location.search).get('view');
    return view === 'logic' || view === 'all' || view === 'teaching' ? view : 'context';
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [direction, setDirection] = usePref<'RIGHT' | 'DOWN'>('direction', 'RIGHT');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [showMap, setShowMap] = usePref('minimap', false);
  const [showLegend, setShowLegend] = usePref('legend', true);
  const [edgeStyle, setEdgeStyle] = usePref<EdgeStyle>('edge-style', 'curve');
  const layoutFromUrl = useRef(new URLSearchParams(location.search).get('layout'));
  const [teachingLayout, setTeachingLayout] = usePref<TeachingLayout>('teaching-layout', 'hierarchy');
  const [follow, setFollow] = usePref('follow', false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [filter, setFilter] = useState<NodeFilter>(EMPTY_FILTER);
  const [studyId, setStudyId] = useState<string | null>(() => new URLSearchParams(location.search).get('study'));
  const [progressBusy, setProgressBusy] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = usePref('chat-open', window.innerWidth >= 1280);
  const [sidebarWidth, setSidebarWidth] = usePref('sidebar-width', 264);
  const [chatWidth, setChatWidth] = usePref('chat-width', 360);
  const manageParam = useRef(new URLSearchParams(location.search).get('manage')).current;
  const [manageOpen, setManageOpen] = useState(Boolean(manageParam));
  const macrosFromUrl = useRef(new URLSearchParams(location.search).get('macros') === '1').current;
  const [macrosOpen, setMacrosOpen] = useState(macrosFromUrl);
  const [projectsMode, setProjectsMode] = useState(false);
  const [analysisBypass, setAnalysisBypass] = useState(false);
  const [lockId, setLockId] = useState<string | null>(null);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [analysisPrompt, setAnalysisPrompt] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (isStatic) return;
    let alive = true;
    fetch('/api/projects')
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (alive && body) setProjectsMode(Boolean(body.enabled)); })
      .catch(() => { /* single-board server */ });
    return () => { alive = false; };
  }, [isStatic]);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [offlineShown, setOfflineShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [overviewColumns, setOverviewColumns] = useState<1 | 2>(() => window.innerWidth > 1100 ? 2 : 1);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digestTrigger = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const layoutKey = useRef('');
  const pendingFocus = useRef<string | null>(null);
  const framedRevision = useRef(0);
  const stamps = useRef<Map<string, number> | null>(null);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepLink = useRef<string | null>(new URLSearchParams(location.search).get('node'));
  const lastCurrent = useRef<string | null>(null);
  const studyRef = useRef<string | null>(null);
  const dragState = useRef<{ start: { x: number; y: number } | null; dragging: boolean; moved: boolean; suppressUntil: number }>({
    start: null, dragging: false, moved: false, suppressUntil: 0,
  });
  const forceFit = useRef(false);
  const selectTimer = useRef<number | null>(null);
  const promotedTeaching = useRef(false);
  const live = useRef({ follow: false, currentId: null as string | null, selectedId: null as string | null });
  // A board that has code opens in the teaching view unless the URL says otherwise.
  useEffect(() => {
    if (!snapshot || promotedTeaching.current) return;
    promotedTeaching.current = true;
    if (new URLSearchParams(location.search).has('view')) return;
    if (hasTeachingData(snapshot)) setMode('teaching');
  }, [snapshot]);
  const initialized = useNodesInitialized();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350;
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const { fitView, getNode, getNodes, setCenter } = useReactFlow<CanvasNode>();

  const projection = useMemo(
    () => snapshot ? project(snapshot, mode, '', { onlyCode: mode === 'teaching' && (teachingLayout === 'files' || teachingLayout === 'hierarchy') }) : null,
    [snapshot, mode, teachingLayout],
  );

  const allNodes = useMemo(() => (snapshot ? values(snapshot.nodes).filter((node) => node.status !== 'removed') : []), [snapshot]);
  const allEdges = useMemo(() => {
    if (!snapshot) return [];
    const ids = new Set(values(snapshot.nodes).filter((node) => node.status !== 'removed').map((node) => node.id));
    return values(snapshot.edges).filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }, [snapshot]);
  const activities = useMemo(() => snapshot ? values(snapshot.activities).sort((a, b) => Number(b.at || 0) - Number(a.at || 0)) : [], [snapshot]);
  const byId = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes]);
  const selected = selectedId ? byId.get(selectedId) || null : null;
  const currentId = snapshot ? currentNodeId(snapshot) : null;
  const current = currentId ? byId.get(currentId) || null : null;
  const findings = useMemo(() => allNodes
    .filter((node) => node.id !== currentId && ['finding', 'vuln'].includes(node.type) && node.status !== 'superseded')
    .sort((a, b) => (severityOrder[a.severity || 'info'] ?? 5) - (severityOrder[b.severity || 'info'] ?? 5)), [allNodes, currentId]);
  const openItems = useMemo(() => allNodes
    .filter((node) => node.id !== currentId && ['intent', 'hypothesis', 'question'].includes(node.type) && !['done', 'dead', 'refuted', 'superseded', 'confirmed'].includes(node.status || ''))
    .slice(-8).reverse(), [allNodes, currentId]);
  const macros = useMemo(() => (snapshot ? values(snapshot.nodes) : [])
    .filter((node) => node.type === 'unit' && node.kind === 'macro' && node.status !== 'removed')
    .sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')) || Number(a.startLine || 0) - Number(b.startLine || 0)), [snapshot]);
  const lessons = useMemo(() => snapshot ? values(snapshot.lessons) : [], [snapshot]);
  const requests = useMemo(() => snapshot ? values(snapshot.requests) : [], [snapshot]);
  const replies = useMemo(() => snapshot ? values(snapshot.replies) : [], [snapshot]);
  const teaching = useMemo(() => {
    if (!snapshot || !hasTeachingData(snapshot)) return null;
    const units = allNodes.filter((node) => node.type === 'unit' && node.status !== 'removed' && node.kind !== 'macro');
    const covered = new Set(units.filter((unit) => lessonsForNode(lessons, unit).length > 0).map((unit) => unit.id));
    const fileDeps = new Map<string, { from: string; to: string; count: number; kind: 'calls' | 'include' }>();
    for (const edge of allEdges) {
      if (edge.kind !== 'calls') continue;
      const from = byId.get(edge.from)?.file;
      const to = byId.get(edge.to)?.file;
      if (!from || !to || from === to) continue;
      const key = `calls:${from}->${to}`;
      const entry = fileDeps.get(key) || { from, to, count: 0, kind: 'calls' as const };
      entry.count += 1;
      fileDeps.set(key, entry);
    }
    // #include is the other half of "this file uses that file"; resolve header
    // basenames against the imported files.
    const imported = Object.values(snapshot.files || {});
    const byBase = new Map(imported.map((file) => [String(file.path).split('/').pop(), file.path]));
    for (const file of imported) {
      for (const include of file.includes || []) {
        const target = byBase.get(String(include).split('/').pop());
        if (!target || target === file.path) continue;
        const key = `include:${file.path}->${target}`;
        if (!fileDeps.has(key)) fileDeps.set(key, { from: file.path, to: target, count: 1, kind: 'include' as const });
      }
    }
    return {
      stages: orderedStages(allNodes, allEdges),
      fileDeps: [...fileDeps.values()].sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === 'calls' ? -1 : 1)),
      uncovered: units.filter((unit) => !covered.has(unit.id))
        .sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')) || Number(a.startLine || 0) - Number(b.startLine || 0)),
      requests,
      answers: replies,
      coverage: snapshot.coverage || null,
    };
  }, [snapshot, allNodes, allEdges, lessons, requests, replies, byId]);
  const inbox = useMemo(() => {
    const linked = new Set(allEdges.flatMap((edge) => [edge.from, edge.to]));
    return allNodes.filter((node) => !linked.has(node.id) && !(teaching && node.type === 'unit')).reverse();
  }, [allNodes, allEdges, teaching]);
  const studyNode = studyId ? byId.get(studyId) || null : null;
  const selectedLessons = useMemo(() => lessonsForNode(lessons, selected), [lessons, selected]);
  const paletteNodes = useMemo(() => [...allNodes].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)), [allNodes]);

  const filterOptions = useMemo(() => {
    const tally = (pick: (node: typeof allNodes[number]) => string) => {
      const counts = new Map<string, number>();
      allNodes.forEach((node) => counts.set(pick(node), (counts.get(pick(node)) || 0) + 1));
      return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    };
    return {
      types: tally((node) => node.type),
      statuses: tally((node) => node.status || ''),
      confidences: tally((node) => node.confidence || ''),
      riskCount: allNodes.filter((node) => node.severity === 'critical' || node.severity === 'high').length,
    };
  }, [allNodes]);
  const results = useMemo(() => filterActive(filter) ? filterNodes(paletteNodes, filter) : null, [paletteNodes, filter]);

  const legend = useMemo(() => {
    const types = new Set<string>();
    projection?.nodes.forEach((node) => { if (!node.data.group) types.add(node.data.item.type); });
    const groups = new Set<RelationGroup>();
    projection?.edges.forEach((edge) => groups.add((edge.data as { group: RelationGroup }).group));
    return { types: [...types].sort(), groups: [...groups] };
  }, [projection]);

  const highlighted = useMemo(() => lockId ? relatedIds(lockId, edges, 2) : focusedIds(selectedId, edges), [lockId, selectedId, edges]);
  const lockNode = lockId ? byId.get(lockId) || null : null;
  const displayNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    selected: !node.data.group && node.id === selectedId,
    data: { ...node.data, muted: !node.data.group && Boolean(lockId || selectedId) && !highlighted.has(node.id), fresh: fresh.has(node.id) },
  })), [nodes, lockId, selectedId, highlighted, fresh]);
  const displayEdges = useMemo(() => edges.map((edge) => {
    const focusSeed = lockId || selectedId;
    const active = lockId
      ? highlighted.has(edge.source) && highlighted.has(edge.target)
      : Boolean(selectedId) && (edge.source === selectedId || edge.target === selectedId);
    const meta = edge.data as { cross?: boolean; crossFile?: unknown } | undefined;
    const cross = Boolean(meta?.cross);
    const crossFile = Boolean(meta?.crossFile);
    return {
      ...edge,
      type: 'routed',
      data: { ...edge.data, style: edgeStyle },
      // Arrowheads live outside the path, so they are recoloured here to follow focus and muting.
      markerEnd: crossFile
        ? { ...(edge.markerEnd as object), color: active ? 'var(--rel-derive)' : 'var(--line-strong)' } as Edge['markerEnd']
        : focusSeed ? { ...(edge.markerEnd as object), color: active ? focusColor((edge.data as { group?: string } | undefined)?.group) : 'var(--line)' } as Edge['markerEnd'] : edge.markerEnd,
      className: `${edge.className || ''} ${crossFile ? 'is-cross-file' : ''} ${active ? 'is-focused' : focusSeed ? 'is-muted' : ''}`,
      zIndex: active ? 10 : 0,
      style: { ...edge.style, opacity: focusSeed ? active ? 1 : .08 : crossFile ? .95 : cross ? .55 : mode === 'all' ? .3 : 1, strokeWidth: active ? 1.75 : crossFile ? 1.35 : cross ? 1 : 1.25 },
    };
  }), [edges, selectedId, lockId, highlighted, mode, edgeStyle]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  live.current = { follow: follow && mode !== 'all', currentId, selectedId };
  studyRef.current = studyId;

  // Mark nodes the Agent just wrote or changed, so a live board shows where work happened.
  useEffect(() => {
    if (!snapshot) return;
    const next = new Map(allNodes.map((node) => [node.id, Number(node.updated || node.ts || 0)]));
    const previous = stamps.current;
    stamps.current = next;
    if (!previous) return;
    const changed = new Set<string>();
    next.forEach((stamp, id) => { if (previous.get(id) !== stamp) changed.add(id); });
    if (!changed.size) return;
    setFresh(changed);
    if (freshTimer.current) clearTimeout(freshTimer.current);
    freshTimer.current = setTimeout(() => setFresh(new Set()), 4000);
  }, [snapshot, allNodes]);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('view', mode);
    if (mode === 'teaching') url.searchParams.set('layout', teachingLayout);
    else url.searchParams.delete('layout');
    history.replaceState(null, '', url);
  }, [mode, teachingLayout]);

  // A shared link can pin the teaching layout as well as the view. Read the
  // value captured at mount, before the URL-sync effect normalises the query.
  useEffect(() => {
    const layout = layoutFromUrl.current;
    if (layout === 'chain' || layout === 'files' || layout === 'hierarchy') setTeachingLayout(layout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selected node in the address so the view can be shared and survives reloads.
  useEffect(() => {
    if (deepLink.current && !selectedId) return; // wait for the deep link to be applied
    const url = new URL(location.href);
    if (selectedId) url.searchParams.set('node', selectedId); else url.searchParams.delete('node');
    history.replaceState(null, '', url);
  }, [selectedId]);

  // Keep the open code/lesson panel in the address so it can be shared too.
  useEffect(() => {
    const url = new URL(location.href);
    if (studyId) url.searchParams.set('study', studyId); else url.searchParams.delete('study');
    history.replaceState(null, '', url);
  }, [studyId]);

  useEffect(() => {
    const target = deepLink.current;
    if (!target || !snapshot) return;
    deepLink.current = null;
    if (!byId.has(target)) { const url = new URL(location.href); url.searchParams.delete('node'); history.replaceState(null, '', url); return; }
    pendingFocus.current = target;
    setSelectedId(target);
    if (!projection?.nodes.some((node) => node.id === target)) {
      const targetNode = byId.get(target);
      setMode(targetNode && hasTeachingData(snapshot) && ['unit', 'stage'].includes(targetNode.type) ? 'teaching' : 'all');
    }
  }, [snapshot, byId, projection]);

  // A dropped connection is only worth announcing if it lasts; EventSource usually recovers within a second.
  useEffect(() => {
    if (connection !== 'offline' || isStatic) { setOfflineShown(false); return; }
    const timer = setTimeout(() => setOfflineShown(true), 1500);
    return () => clearTimeout(timer);
  }, [connection, isStatic]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  }, []);

  const exportImage = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportCanvasPng(getNodes(), `blackboard-${mode}-${new Date().toISOString().slice(0, 10)}.png`);
      flash('已导出画布图片');
    } catch { flash('导出图片失败'); }
    finally { setExporting(false); }
  }, [exporting, getNodes, mode, flash]);

  const copyNodeLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setLinkCopied(true);
      if (linkTimer.current) clearTimeout(linkTimer.current);
      linkTimer.current = setTimeout(() => setLinkCopied(false), 2000);
    } catch { flash('无法写入剪贴板'); }
  };

  const toggleLearned = useCallback(async (node: BoardNode) => {
    if (!snapshot?.requestToken || isStatic) { flash('离线导出为只读，不能记录学习进度'); return; }
    setProgressBusy(node.id);
    try {
      const response = await fetch('/api/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-blackboard-request': snapshot.requestToken },
        body: JSON.stringify({ unitId: node.id, learned: !node.learned }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `HTTP ${response.status}`);
      flash(body.unit?.learned ? '已标记学习完毕' : '已取消学习标记');
    } catch (error) {
      flash(`更新学习进度失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setProgressBusy(null);
    }
  }, [snapshot, isStatic, flash]);

  useEffect(() => {
    const resize = () => setOverviewColumns(window.innerWidth > 1100 ? 2 : 1);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const handleNodesChange: OnNodesChange<CanvasNode> = useCallback((changes) => {
    onNodesChange(changes);
    const selectedChange = changes.find((change) => change.type === 'select' && change.selected);
    if (selectedChange?.type === 'select' && !selectedChange.id.startsWith('__display_group_')) {
      const drag = dragState.current;
      // Dragging selects the node internally; only a real click should open the
      // Inspector, so ignore the selection while dragging (and right after).
      if (drag.dragging || drag.moved || Date.now() < drag.suppressUntil) return;
      // Wait one short beat: a pointer-down that turns into a drag must not
      // flash the Inspector open first.
      if (selectTimer.current) window.clearTimeout(selectTimer.current);
      const id = selectedChange.id;
      selectTimer.current = window.setTimeout(() => {
        selectTimer.current = null;
        setSelectedId(id);
      }, 150);
    }
    // Deselect notifications can arrive from a previous layout. Pane click and
    // Escape are the explicit clear actions; do not let stale events clear focus.
  }, [onNodesChange]);

  useEffect(() => () => {
    if (selectTimer.current) window.clearTimeout(selectTimer.current);
  }, []);

  const centerOnNode = useCallback((id: string, reserveInspector = true, duration = motion) => {
    const node = getNode(id);
    if (!node) return;
    const width = viewportRef.current?.clientWidth || 700;
    // The inspector floats over the right edge; centre inside the remaining space.
    const overlay = reserveInspector && width >= 640 ? Math.min(INSPECTOR_W, width * .5) : 0;
    const zoom = Math.min(1, Math.max(.55, (width - overlay) / (NODE_W + 48)));
    const parent = node.parentId ? getNode(node.parentId) : null;
    setCenter(
      node.position.x + (parent?.position.x || 0) + (node.data.compact ? 120 : NODE_W / 2) + overlay / (2 * zoom),
      node.position.y + (parent?.position.y || 0) + Number(node.style?.height || NODE_H) / 2,
      { zoom, duration },
    );
  }, [getNode, setCenter, motion]);

  const focusNode = useCallback((id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) setSidebarOpen(false);
    if (!projection?.nodes.some((node) => node.id === id)) {
      pendingFocus.current = id;
      setMode('all');
    } else requestAnimationFrame(() => centerOnNode(id));
  }, [projection, centerOnNode]);

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_event, node) => {
    if (node.data.group) return;
    // Dragging also emits a click; only a real click may focus a node and open
    // its implementation.
    if (dragState.current.dragging || dragState.current.moved || Date.now() < dragState.current.suppressUntil) return;
    focusNode(node.id);
    // Keep the Inspector as the single-click landing. The code panel opens via
    // Inspector's 查看实现, the sidebar, or a double click.
  }, [focusNode]);

  const onNodeDragStart: OnNodeDrag<CanvasNode> = useCallback((_event, node) => {
    dragState.current.start = { x: node.position.x, y: node.position.y };
    dragState.current.dragging = true;
    dragState.current.moved = false;
    if (selectTimer.current) window.clearTimeout(selectTimer.current);
    // Pointer-down selects the node inside React Flow before we know whether
    // this is a click or a drag; hide the Inspector until the gesture is known.
    setSelectedId(null);
  }, []);

  const onNodeDrag: OnNodeDrag<CanvasNode> = useCallback((_event, node) => {
    const start = dragState.current.start;
    if (!start) return;
    if (Math.abs(node.position.x - start.x) > 3 || Math.abs(node.position.y - start.y) > 3) {
      dragState.current.moved = true;
    }
  }, []);

  const onNodeDragStop: OnNodeDrag<CanvasNode> = useCallback(() => {
    dragState.current.dragging = false;
    if (dragState.current.moved) {
      // Keep suppressing the synthetic click that follows a drag release.
      dragState.current.suppressUntil = Date.now() + 300;
      window.setTimeout(() => { dragState.current.moved = false; }, 300);
    }
    dragState.current.start = null;
  }, []);

  const selectFromSidebar = useCallback((id: string) => {
    const node = byId.get(id);
    if (node?.type === 'unit') setStudyId(id);
    focusNode(id);
  }, [byId, focusNode]);

  useEffect(() => {
    if (!projection) return;
    const key = JSON.stringify([mode, direction, overviewColumns, teachingLayout, layoutEpoch, projection.nodes.map((node) => node.id), projection.edges.map((edge) => [edge.id, edge.source, edge.target])]);
    // Content-only stream updates must not discard dragged positions or reset zoom.
    if (layoutKey.current === key) {
      const fresh = new Map(projection.nodes.map((node) => [node.id, node.data]));
      setNodes((previous) => previous.map((node) => ({ ...node, data: { ...node.data, ...fresh.get(node.id) } })));
      // Keep each edge's computed route; only content changed, not the layout.
      setEdges((previous) => {
        const routes = new Map(previous.map((edge) => [edge.id, (edge.data as { route?: unknown } | undefined)?.route]));
        return projection.edges.map((edge) => ({ ...edge, data: { ...edge.data, route: routes.get(edge.id) } }));
      });
      return;
    }
    let cancelled = false;
    layoutGraph(projection.nodes, projection.edges, direction, mode === 'all', overviewColumns, mode === 'teaching' ? teachingLayout : null).then((layouted) => {
      if (cancelled) return;
      layoutKey.current = key;
      setNodes(layouted.nodes);
      setEdges(layouted.edges);
      setLayoutRevision((revision) => revision + 1);
    });
    return () => { cancelled = true; };
  }, [projection, mode, direction, overviewColumns, teachingLayout, layoutEpoch, setNodes, setEdges]);

  useEffect(() => {
    if (!initialized || !layoutRevision || framedRevision.current === layoutRevision) return;
    const frame = requestAnimationFrame(() => {
      // The first framing of a page load jumps into place; only later re-framings animate.
      const duration = framedRevision.current === 0 ? 0 : motion;
      framedRevision.current = layoutRevision;
      if (forceFit.current) {
        // A manual reset should always show the whole freshly laid-out board,
        // even when "follow the Agent" is enabled.
        forceFit.current = false;
        fitView({ padding: .14, duration, minZoom: .08, maxZoom: 1 });
        return;
      }
      const following = live.current.follow && live.current.currentId && getNode(live.current.currentId) ? live.current.currentId : null;
      // A requested node that this layout does not contain yet (a view switch is pending) stays queued.
      const requested = pendingFocus.current && getNode(pendingFocus.current) ? pendingFocus.current : null;
      if (requested) {
        centerOnNode(requested, true, duration);
        pendingFocus.current = null;
      } else if (following) centerOnNode(following, Boolean(live.current.selectedId), duration);
      else fitView({ padding: .14, duration, minZoom: .08, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, layoutRevision, centerOnNode, fitView, getNode, mode, motion]);

  // Follow mode: when the Agent's cursor moves, bring the new position into view.
  useEffect(() => {
    const previous = lastCurrent.current;
    lastCurrent.current = currentId;
    if (!currentId || previous === null || previous === currentId || !follow || mode === 'all') return;
    const frame = requestAnimationFrame(() => centerOnNode(currentId, Boolean(live.current.selectedId)));
    return () => cancelAnimationFrame(frame);
  }, [currentId, follow, mode, centerOnNode]);

  // Arrow keys walk the explicit one-hop neighbours of the selected node.
  useEffect(() => {
    const onArrow = (event: KeyboardEvent) => {
      if (!selectedId || event.metaKey || event.ctrlKey || event.altKey || !event.key.startsWith('Arrow')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="slider"], [role="menu"]')) return;
      const boxes = nodes.filter((node) => !node.data.group).map((node) => {
        const parent = node.parentId ? nodes.find((candidate) => candidate.id === node.parentId) : null;
        return { id: node.id, x: node.position.x + (parent?.position.x || 0), y: node.position.y + (parent?.position.y || 0), w: Number(node.style?.width || NODE_W), h: Number(node.style?.height || NODE_H) };
      });
      const next = neighborInDirection(selectedId, boxes, edges, event.key as ArrowKey);
      // Capture phase, and also when there is no neighbour: React Flow would otherwise nudge the focused node by a few pixels.
      event.preventDefault();
      event.stopPropagation();
      if (!next) return;
      focusNode(next);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(next)}"]`)?.focus({ preventScroll: true }));
    };
    window.addEventListener('keydown', onArrow, true);
    return () => window.removeEventListener('keydown', onArrow, true);
  }, [selectedId, nodes, edges, focusNode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !(event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]') && !document.querySelector('[role="dialog"]') && (event.key === '/' || event.key === '[' || event.key === '?')) {
        event.preventDefault();
        if (event.key === '/') setPaletteOpen(true); else if (event.key === '?') setShortcutsOpen(true); else setSidebarOpen((open) => !open);
      } else if (event.key === 'Escape' && !document.querySelector('[role="dialog"], [role="menu"]')) {
        if (lockId) setLockId(null);
        else if (studyRef.current) setStudyId(null);
        else setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (freshTimer.current) clearTimeout(freshTimer.current);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (linkTimer.current) clearTimeout(linkTimer.current);
    };
  }, [lockId]);

  const copyDigest = async () => {
    try {
      await navigator.clipboard.writeText(snapshot?.digest || '');
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setCopied(false); }
  };

  const resetLayout = useCallback(() => {
    pendingFocus.current = null;
    layoutKey.current = '';
    forceFit.current = true;
    setLayoutEpoch((epoch) => epoch + 1);
    flash('已恢复自动布局');
  }, [flash]);

  const switchMode = (next: ViewMode) => {
    if (next === mode) return;
    if (next === 'teaching' && !teaching) return;
    pendingFocus.current = null;
    setSelectedId(null);
    setMode(next);
  };

  if (!snapshot) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <BrandMark size={32} />
        <strong className="text-sm font-semibold text-foreground">blackboard</strong>
        <span className="text-xs">{connection === 'offline' ? '等待黑板服务…' : '正在恢复 Agent 现场…'}</span>
      </main>
    );
  }

  const stats = snapshot.stats || {};
  const risk = Number(stats.vulns?.critical || 0) + Number(stats.vulns?.high || 0);
  const counts = {
    nodes: allNodes.length,
    edges: allEdges.length,
    risk,
    open: Number(stats.frontier || 0),
    candidates: Number(stats.candidates || 0),
    learned: Number(stats.learned || 0),
  };
  const hidden = projection?.hidden || 0;
  const annotatedUnits = allNodes.filter((node) => node.type === 'unit' && node.status !== 'removed' && node.kind !== 'macro' && node.role).length;
  const analysisReady = Number(stats.stages || 0) > 0 || lessons.length > 0 || annotatedUnits > 0;
  const needsAnalysis = projectsMode && Number(stats.units || 0) > 0 && !analysisReady;
  const requestMacroNotes = (missing: BoardNode[]) => {
    if (!snapshot?.requestToken || isStatic || !missing.length) return;
    const list = missing.slice(0, 120).map((macro) => `${macro.id} ${macro.symbol || macro.title} (${macro.file}:${macro.startLine})`).join('\n');
    const text = `以下宏还没有标注。请用 annotate --file macronotes.json 给每个宏写 role（它代表什么）和 detail（来源/讲解）；include guard、编译器/架构宏也写一句，不要编造。键用 id 或 文件:符号。\n\n${list}`;
    setChatOpen(true);
    setAnalysisPrompt({ id: Date.now(), text });
    flash('已让 Agent 补全宏标注；写回后宏查询会自动刷新');
  };

  const requestAnalysis = () => {
    if (!snapshot?.requestToken || isStatic) return;
    const text = `请分析/更新当前项目的代码。你已经在项目根目录：1) 先读取源码和 code ls；2) 给每个函数和宏用 annotate --file roles.json 写作用（宏请用 {role, detail} 对象，写清来源）；3) 按这个 PoC 的真实路径用 chain import --replace 写攻击阶段；4) 用 teach import 补讲解。黑板 CLI 路径、项目目录见上下文；没有把握的部分宁可少写，不要编造。完成后回复分析摘要。`;
    setChatOpen(true);
    setAnalysisRequested(true);
    setAnalysisPrompt({ id: Date.now(), text });
    flash('已把分析任务交给右侧 Agent；本地 CLI 会直接开始运行');
  };
  // NOTE: no hook here — this sits after the `if (!snapshot)` early return.

  return (
    <div className="flex h-full flex-col">
      <Topbar
        title={snapshot.meta.title || '未命名任务'}
        mode={mode}
        onMode={switchMode}
        theme={theme}
        onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        connection={connection}
        isStatic={isStatic}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onSearch={() => setPaletteOpen(true)}
        onDigest={() => setDigestOpen(true)}
        digestRef={digestTrigger}
        activities={activities}
        activityTotal={stats.activities || activities.length}
        hasTeaching={Boolean(teaching)}
        coverage={snapshot.coverage?.units.ratio ?? stats.coverage?.ratio ?? null}
        openRequests={teaching ? requests.filter((request) => !replies.some((reply) => reply.requestId === request.id)).length : 0}
        learned={Number(stats.learned || 0)}
        units={Number(stats.units || 0)}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((open) => !open)}
        onManage={() => setManageOpen(true)}
        macroCount={macros.length}
        onOpenMacros={() => setMacrosOpen(true)}
        requestToken={snapshot.requestToken}
        canEdit={!isStatic}
        canAnalyze={!isStatic && Number(stats.units || 0) > 0}
        onAnalyze={requestAnalysis}
      />

      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <button className="absolute inset-0 z-20 bg-black/20 lg:hidden" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />
            <aside style={{ width: sidebarWidth }} className="z-30 shrink-0 border-r bg-background max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:shadow-float">
              <Sidebar
                current={current}
                openItems={openItems}
                findings={findings}
                inbox={inbox}
                selectedId={selectedId}
                counts={counts}
                onSelect={selectFromSidebar}
                onSearch={() => { setPaletteOpen(true); if (window.innerWidth < 1024) setSidebarOpen(false); }}
                onShortcuts={() => setShortcutsOpen(true)}
                filter={filter}
                onFilter={setFilter}
                filterOptions={filterOptions}
                results={results}
                teaching={teaching}
                onOpenStudy={setStudyId}
              />
            </aside>
            <ResizeHandle side="left" width={sidebarWidth} min={220} max={480} defaultValue={264} onChange={setSidebarWidth} label="调整左侧导航宽度" />
          </>
        )}

        <main ref={viewportRef} className="relative min-w-0 flex-1" aria-label="思考画布">
          {needsAnalysis && !analysisBypass && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 p-6 backdrop-blur-[1px]">
              <div className="w-[min(520px,100%)] rounded-xl border bg-card p-5 shadow-float">
                <p className="m-0 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">项目分析中</p>
                <h2 className="m-0 mt-1 text-[16px] font-semibold">代码已导入，等待 Agent 分析</h2>
                <p className="m-0 mt-2 text-[12.5px] leading-6 text-subtle">
                  这个项目目前只有 {stats.units || 0} 个代码单元。Agent 写完函数作用、攻击链和讲解后，黑板才会展开。
                </p>
                <ol className="m-0 mt-3 flex list-decimal flex-col gap-1 pl-5 text-[11.5px] leading-5 text-muted-foreground">
                  <li>Agent 通读源码（项目根目录就是当前黑板目录）</li>
                  <li>annotate 写函数作用 + chain 写攻击链 + teach 写讲解</li>
                  <li>事件日志更新后本页自动显示内容</li>
                </ol>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={requestAnalysis}><Focus className="size-3.5" />让 Agent 分析</Button>
                  <Button size="sm" variant="outline" onClick={() => setAnalysisBypass(true)}>先查看代码</Button>
                  <span className="text-[10.5px] text-muted-foreground">或直接在右侧对话里让 Agent 分析</span>
                </div>
              </div>
            </div>
          )}
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={handleNodesChange}
            onNodeClick={onNodeClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={(_event, node) => { if (!node.data.group) setStudyId(node.id); }}
            onPaneClick={() => setSelectedId(null)}
            nodesConnectable={false}
            deleteKeyCode={null}
            autoPanOnNodeFocus={false}
            minZoom={0.08}
            maxZoom={1.8}
            colorMode={theme}
            fitView
            fitViewOptions={{ padding: .14, minZoom: .08, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <CanvasToolbar
              hasCurrent={Boolean(currentId)}
              canFollow={!isStatic}
              canExport={nodes.length > 0 && !exporting}
              onExport={exportImage}
              grouped={mode === 'all'}
              direction={direction}
              showMap={showMap}
              follow={follow}
              onToggleFollow={() => setFollow((value) => !value)}
              motion={motion}
              onLocate={() => currentId && focusNode(currentId)}
              onDirection={() => setDirection(direction === 'RIGHT' ? 'DOWN' : 'RIGHT')}
              onToggleMap={() => setShowMap((open) => !open)}
              showLegend={showLegend}
              onToggleLegend={() => setShowLegend((open) => !open)}
              edgeStyle={edgeStyle}
              onEdgeStyle={setEdgeStyle}
              teaching={mode === 'teaching'}
              teachingLayout={teachingLayout}
              onTeachingLayout={setTeachingLayout}
              onResetLayout={resetLayout}
              hasSelection={Boolean(selectedId)}
              locked={Boolean(lockId)}
              onToggleLock={() => setLockId((current) => current ? null : selectedId)}
            />
            {showMap && (
              <MiniMap
                position="bottom-left"
                style={{ marginBottom: 64 }}
                pannable
                zoomable
                nodeStrokeWidth={2}
                nodeColor={(node) => (node.data as CanvasNode['data']).group ? 'transparent' : 'var(--ink-3)'}
                nodeStrokeColor={(node) => (node.data as CanvasNode['data']).group ? 'var(--line-strong)' : 'transparent'}
              />
            )}
          </ReactFlow>

          {showLegend && nodes.length > 0 && <Legend types={legend.types} groups={legend.groups} onClose={() => setShowLegend(false)} />}

          {projection && projection.nodes.length === 0 && (
            <EmptyBoard viewEmpty={allNodes.length > 0} isStatic={isStatic} onShowAll={() => switchMode('all')} />
          )}

          {needsAnalysis && analysisBypass && (
            <div className="absolute bottom-16 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-3 py-1.5 shadow-float">
              <span className="text-[11.5px] text-muted-foreground">
                {analysisRequested ? '分析请求已提交，等待 Agent 写回…' : '代码已导入 · 等待 Agent 分析'}
              </span>
              <Button size="sm" onClick={requestAnalysis} disabled={analysisRequested}>
                <Focus className="size-3.5" />{analysisRequested ? '等待分析' : '让 Agent 分析'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAnalysisBypass(false)}>回到等待页</Button>
            </div>
          )}

          {mode === 'context' && !currentId && teaching && (
            <div className="pointer-events-auto absolute left-1/2 top-14 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-3 py-1 text-[11px] shadow-float">
              <span className="text-muted-foreground">Agent 尚未设置游标 · 现场显示攻击链骨架</span>
              <button onClick={() => switchMode('teaching')} className="rounded-full border px-2 py-0.5 text-[10.5px] hover:border-strong">教学视图</button>
              <button onClick={() => switchMode('all')} className="rounded-full border px-2 py-0.5 text-[10.5px] hover:border-strong">全局</button>
            </div>
          )}

          {lockNode && (
            <button
              onClick={() => setLockId(null)}
              className="pointer-events-auto absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-strong bg-card px-3 py-1 text-[11.5px] shadow-float"
              title="退出锁定聚焦"
            >
              <Lock className="size-3.5 text-live" />
              <span className="max-w-[40vw] truncate">聚焦：{lockNode.title}</span>
              <X className="size-3.5 text-muted-foreground" />
            </button>
          )}

          <div className={`pointer-events-none absolute left-1/2 ${lockNode ? 'top-14' : 'top-3'} flex -translate-x-1/2 flex-col items-center gap-2`}>
            {offlineShown && (
              <div role="alert" className="whitespace-nowrap rounded-full border border-destructive/40 bg-danger-soft px-3 py-1 text-xs text-destructive shadow-xs">
                与黑板服务断开，正在重连{syncedAt ? ` · 画布停留在 ${new Date(syncedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
              </div>
            )}
            {hidden > 0 && (
              <button
                className="pointer-events-auto whitespace-nowrap rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-xs transition-colors hover:border-strong hover:text-foreground"
                onClick={() => switchMode('all')}
              >
                另有 {hidden} 个节点未显示 · 查看全部
              </button>
            )}
            {notice && <div role="status" className="whitespace-nowrap rounded-full border bg-card px-3 py-1 text-xs shadow-float">{notice}</div>}
          </div>

          <p className="sr-only" role="status" aria-live="polite">{selected ? `已选中${typeLabelOf(selected.type)}：${selected.title}` : ''}</p>

          {selected && <Inspector node={selected} edges={allEdges} byId={byId} lessons={selectedLessons} onClose={() => setSelectedId(null)} onFocus={focusNode} onOpenStudy={setStudyId} onCopyLink={isStatic ? undefined : copyNodeLink} linkCopied={linkCopied} canEdit={!isStatic} progressBusy={progressBusy === selected.id} onToggleLearned={toggleLearned} locked={lockId === selected?.id} onToggleLock={() => setLockId((current) => current === selected?.id ? null : selected?.id || null)} />}
          {studyNode && <StudyPanel snapshot={snapshot} node={studyNode} onClose={() => { setStudyId(null); studyRef.current = null; }} canEdit={!isStatic} progressBusy={progressBusy === studyNode.id} onToggleLearned={toggleLearned} />}
        </main>

        {chatOpen && (
          <ResizeHandle side="right" width={chatWidth} min={300} max={640} defaultValue={360} onChange={setChatWidth} label="调整对话栏宽度" />
        )}
        {chatOpen && (
          <AgentChat
            snapshot={snapshot}
            selected={selected}
            canEdit={!isStatic}
            width={chatWidth}
            injectedPrompt={analysisPrompt}
            onInjected={() => setAnalysisPrompt(null)}
            onClose={() => setChatOpen(false)}
            onFocus={focusNode}
          />
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        nodes={paletteNodes}
        theme={theme}
        copied={copied}
        onSelect={selectFromSidebar}
        onMode={switchMode}
        onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        onCopyDigest={copyDigest}
        onExport={nodes.length > 0 ? exportImage : null}
        onShortcuts={() => setShortcutsOpen(true)}
      />
      {snapshot && (
        <MacroLookup
          open={macrosOpen}
          onOpenChange={setMacrosOpen}
          snapshot={snapshot}
          macros={macros}
          onOpenMacro={(id) => setStudyId(id)}
          onRequestNotes={requestMacroNotes}
        />
      )}
      {snapshot && (
        <ManageDialog
          open={manageOpen}
          onOpenChange={setManageOpen}
          snapshot={snapshot}
          initialTab={manageParam || undefined}
          onDone={(action, message) => {
            flash(message);
            if (action === 'import') {
              setMode('teaching');
              setTeachingLayout('hierarchy');
              setChatOpen(true);
            }
          }}
        />
      )}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <DigestDialog open={digestOpen} onOpenChange={setDigestOpen} digest={snapshot.digest || ''} copied={copied} onCopy={copyDigest} returnFocus={digestTrigger} />
    </div>
  );
}

export function App() {
  return <TooltipProvider delayDuration={300}><ReactFlowProvider><Workspace /></ReactFlowProvider></TooltipProvider>;
}
