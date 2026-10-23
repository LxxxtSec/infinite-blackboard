import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, FileText, MessageSquareText, Send, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/icon-button';
import { Markdown } from '../markdown';
import {
  difficultyLabel, lessonLevelLabel, lessonsForNode, lineNotesForFile,
  phaseLabel, typeLabel, unitKindLabel,
} from '../presentation';
import type { BoardNode, GraphSnapshot, Lesson } from '../types';
import { values } from '../types';

const TABS = [
  { id: 'split', label: '代码 + 讲解' },
  { id: 'ask', label: '提问' },
] as const;
type TabId = typeof TABS[number]['id'];

type Props = {
  snapshot: GraphSnapshot;
  node: BoardNode;
  onClose: () => void;
  canEdit?: boolean;
  progressBusy?: boolean;
  onToggleLearned?: (node: BoardNode) => void;
};

type LessonScope = 'unit' | 'range' | 'file' | 'board';

function lessonScope(lesson: Lesson, node: BoardNode): LessonScope {
  if (lesson.target?.unit === node.id) return 'unit';
  if (lesson.target?.board) return 'board';
  if (node.type !== 'unit' || !node.file) return 'file';
  const overlaps = (lesson.target?.lines || []).filter((range) => range.file === node.file
    && range.start <= (node.endLine || node.startLine || 0) && range.end >= (node.startLine || 0));
  const unitLines = Math.max(1, (node.endLine || node.startLine || 1) - (node.startLine || 1) + 1);
  const narrow = overlaps.some((range) => range.end - range.start + 1 <= Math.max(80, unitLines * 3));
  return narrow ? 'range' : 'file';
}

const SCOPE_LABEL: Record<LessonScope, string> = { unit: '本函数', range: '行范围', file: '文件级', board: '全局' };
const SCOPE_RANK: Record<LessonScope, number> = { unit: 0, range: 1, file: 2, board: 3 };

type CodeState = { file: string; start: number; lines: string[]; truncated?: boolean; loading?: boolean; error?: string };

function useCode(snapshot: GraphSnapshot, file: string | null) {
  const embedded = file ? snapshot.code?.[file] : undefined;
  const [state, setState] = useState<CodeState | null>(null);
  useEffect(() => {
    if (!file) { setState(null); return; }
    if (embedded) {
      setState({ file, start: 1, lines: embedded.content, truncated: embedded.truncated });
      return;
    }
    let alive = true;
    setState({ file, start: 1, lines: [], loading: true });
    fetch(`/api/file?path=${encodeURIComponent(file)}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((body: { start: number; slice: { line: number; text: string }[]; end: number; lines: number }) => {
        if (!alive) return;
        setState({ file, start: body.start, lines: body.slice.map((item) => item.text), truncated: body.end < body.lines });
      })
      .catch((error: Error) => { if (alive) setState({ file, start: 1, lines: [], error: error.message }); });
    return () => { alive = false; };
  }, [file, embedded]);
  return state;
}

/** Code + lessons + student questions for one selected node. */
export function StudyPanel({ snapshot, node, onClose, canEdit = false, progressBusy = false, onToggleLearned }: Props) {
  const lessons = values(snapshot.lessons);
  const nodeLessons = useMemo(() => lessonsForNode(lessons, node), [lessons, node]);
  const overviewLessons = useMemo(() => lessons.filter((lesson) => lesson.target?.board), [lessons]);
  const available = useMemo(() => {
    const seen = new Set<string>();
    return [...nodeLessons, ...overviewLessons]
      .filter((lesson) => {
        if (seen.has(lesson.id)) return false;
        seen.add(lesson.id);
        return true;
      })
      .sort((a, b) => SCOPE_RANK[lessonScope(a, node)] - SCOPE_RANK[lessonScope(b, node)] || (a.ts || 0) - (b.ts || 0));
  }, [nodeLessons, overviewLessons, node]);
  const hasUnitLesson = available.some((lesson) => lessonScope(lesson, node) === 'unit');

  const file = node.file || nodeLessons.find((lesson) => lesson.target?.file)?.target.file
    || nodeLessons.flatMap((lesson) => lesson.target?.lines || [])[0]?.file || null;
  const code = useCode(snapshot, file);
  const scrollRef = useRef<HTMLDivElement>(null);
  const notes = useMemo<Map<number, Lesson['lineNotes'][number][]>>(
    () => (file ? lineNotesForFile(lessons, file) : new Map()),
    [lessons, file],
  );

  const unitRange = node.type === 'unit' && node.startLine
    ? { start: node.startLine, end: node.endLine || node.startLine }
    : null;
  const [selection, setSelection] = useState(unitRange);
  const [showWholeFile, setShowWholeFile] = useState(false);
  useEffect(() => { setSelection(unitRange); setShowWholeFile(false); }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const displayLines = useMemo(() => {
    if (!code) return [];
    return code.lines
      .map((text, index) => ({ lineNo: code.start + index, text }))
      .filter((item) => showWholeFile || !unitRange || (item.lineNo >= unitRange.start && item.lineNo <= unitRange.end));
  }, [code, showWholeFile, unitRange?.start, unitRange?.end]);

  const [tab, setTab] = useState<TabId>('split');
  const [activeLessonId, setActiveLessonId] = useState<string | null>(available[0]?.id || null);
  useEffect(() => { setActiveLessonId(available[0]?.id || null); }, [node.id, available[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeLesson = available.find((lesson) => lesson.id === activeLessonId) || available[0] || null;

  const requests = values(snapshot.requests).filter((request) => request.unitId === node.id
    || (request.file && file && request.file === file && request.startLine && selection
      && request.startLine <= selection.end && (request.endLine || request.startLine) >= selection.start));
  const replies = values(snapshot.replies);
  const staticMode = Boolean(snapshot.code) || !snapshot.requestToken;

  const [question, setQuestion] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const sendQuestion = async (text: string) => {
    if (!text.trim() || !snapshot.requestToken) return false;
    setSending(true);
    setError(null);
    try {
      const response = await fetch('/api/request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-blackboard-request': snapshot.requestToken,
        },
        body: JSON.stringify({
          question: text.trim(),
          unitId: node.type === 'unit' ? node.id : undefined,
          file: node.type === 'unit' ? undefined : file || undefined,
          startLine: selection?.start,
          endLine: selection?.end,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `HTTP ${response.status}`);
      setNotice(`已记录提问 ${body.request.id}，Agent 会在 digest/context 里看到它。`);
      return true;
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '提交失败');
      return false;
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    const text = question.trim();
    if (!text) return;
    const ok = await sendQuestion(text);
    if (ok) setQuestion('');
  };

  const requestUnitLesson = async () => {
    if (node.type !== 'unit') return;
    const target = `${node.symbol || node.title || node.id}（unit ${node.id}，${node.file || '无文件'}:${node.startLine || '?'}-${node.endLine || '?'}）`;
    await sendQuestion(`请只针对当前函数 ${target} 生成详细讲解，并用 teach import 写入 target.unit="${node.id}" 的 lesson；不要使用覆盖整个文件的 target.lines。讲解要落到本函数的控制流、关键变量和它在利用链里的作用。`);
  };

  // Jump the code pane to the unit's first line when it opens; manual selection
  // must not re-scroll on every click.
  useEffect(() => {
    if (tab === 'ask' || !code || code.loading || !selection) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-line="${selection.start}"]`);
    element?.scrollIntoView({ block: 'center' });
  }, [code?.file, code?.lines.length, node.id, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickLine = (line: number, shift: boolean) => {
    if (unitRange && (line < unitRange.start || line > unitRange.end)) setShowWholeFile(true);
    setSelection((current) => (shift && current
      ? { start: Math.min(current.start, line), end: Math.max(current.start, line) }
      : { start: line, end: line }));
  };

  return (
    <aside
      aria-label="代码与讲解"
      className="anim-slide-in absolute inset-x-2 bottom-2 top-auto z-30 flex max-h-[78%] flex-col rounded-xl border bg-card shadow-float sm:inset-y-3 sm:left-auto sm:right-3 sm:w-[min(900px,calc(100vw-24px))] sm:max-h-none"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3.5 py-2.5">
        <FileText className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium">{typeLabel(node.type)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={node.file || node.id}>
          {node.file ? `${node.file}:${node.startLine}-${node.endLine}` : node.title}
        </span>
        <IconButton label="关闭代码与讲解" onClick={onClose}><X /></IconButton>
      </header>

      {node.type === 'unit' && node.kind === 'macro' && (
        <div className="shrink-0 border-b px-3.5 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono">{node.file}:{node.startLine}-{node.endLine}</span>
          <span> · {node.detail || '还没有来源说明；可在宏查询里补上它来自哪个头文件 / ABI。'}</span>
        </div>
      )}
      {node.type === 'unit' && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-subtle" title={node.role || undefined}>
            {node.role || 'Agent 还没标注这个' + (node.kind === 'macro' ? '宏' : '函数') + '的作用'}
          </span>
          <Button
            size="sm"
            variant={node.learned ? 'outline' : 'default'}
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={!canEdit || progressBusy}
            onClick={() => onToggleLearned?.(node)}
          >
            <CheckCircle2 className={node.learned ? 'size-3.5 text-live' : 'size-3.5'} />
            {node.learned ? '已学' : '学习完毕'}
          </Button>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        {TABS.map((item) => {
          const count = item.id === 'ask' ? requests.length : 0;
          return (
            <button
              key={item.id}
              aria-pressed={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] transition-colors ${tab === item.id ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {item.label}{count > 0 ? <span className="tabular-nums text-muted-foreground">{count}</span> : null}
            </button>
          );
        })}
        <span className="ml-2 text-[10.5px] text-muted-foreground">左侧代码 · 右侧讲解，同时可见</span>
        {node.type === 'unit' && (
          <span className="ml-auto truncate text-[11px] text-muted-foreground">
            {unitKindLabel(node.kind)} · {difficultyLabel(node.difficulty) || '未标注难度'}
          </span>
        )}
        {node.type === 'stage' && <span className="ml-auto text-[11px] text-muted-foreground">{phaseLabel(node.phase)}</span>}
      </div>

      <div className={`min-h-0 flex-1 ${tab === 'ask' ? 'overflow-y-auto' : 'grid grid-cols-1 overflow-y-auto lg:grid-cols-2 lg:overflow-hidden'}`}>
        {tab !== 'ask' && (
          <div ref={scrollRef} className="min-h-0 p-2 lg:overflow-y-auto">
            <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
              <h4 className="m-0 text-[11px] font-medium text-muted-foreground">代码</h4>
              {unitRange && code && !code.loading && !code.error && (
                <div className="flex items-center gap-1 rounded-md border p-0.5 text-[10px]">
                  <button onClick={() => setShowWholeFile(false)} className={`rounded px-1.5 py-0.5 ${!showWholeFile ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>当前函数</button>
                  <button onClick={() => setShowWholeFile(true)} className={`rounded px-1.5 py-0.5 ${showWholeFile ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>整文件</button>
                </div>
              )}
            </div>
            {!file && <p className="m-0 px-2 py-6 text-xs text-muted-foreground">这个节点没有代码锚点。选中一个代码单元，或先用 <code className="font-mono">blackboard code import</code> 导入代码。</p>}
            {file && code?.loading && <p className="m-0 px-2 py-6 text-xs text-muted-foreground">读取代码…</p>}
            {file && code?.error && <p className="m-0 px-2 py-6 text-xs text-destructive">代码读取失败：{code.error}</p>}
            {file && code && !code.loading && !code.error && (
              <>
                <div className="rounded-lg border bg-secondary/40 py-1 font-mono text-[11.5px] leading-[19px]">
                  {displayLines.map(({ lineNo, text }) => {
                    const lineNotes = notes.get(lineNo) || [];
                    const selected = selection ? lineNo >= selection.start && lineNo <= selection.end : false;
                    return (
                      <button
                        key={lineNo}
                        data-line={lineNo}
                        onClick={(event) => pickLine(lineNo, event.shiftKey)}
                        title={lineNotes.map((note) => note.note).join('\n') || undefined}
                        className={`flex w-full items-start gap-2 px-2 text-left transition-colors ${selected ? 'bg-accent text-foreground' : 'hover:bg-accent/60'}`}
                      >
                        <span className="w-9 shrink-0 select-none text-right text-muted-foreground">{lineNo}</span>
                        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${lineNotes.length ? 'bg-node-unit' : 'bg-transparent'}`} />
                        <span className="whitespace-pre-wrap break-all text-subtle">{text || ' '}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="m-0 mt-2 px-1 text-[11px] text-muted-foreground">
                  {selection ? `已选 ${selection.start}-${selection.end} 行` : '点击行号选择范围'} · Shift 点击扩展 · {unitRange && !showWholeFile ? `当前函数 ${unitRange.start}-${unitRange.end}` : code.truncated ? '文件较长已截断' : `${code.lines.length} 行`}
                </p>
                {file && notes.size > 0 && (
                  <div className="mt-3">
                    <h4 className="m-0 mb-1.5 px-1 text-xs font-medium text-muted-foreground">行内批注</h4>
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {[...notes.entries()].sort((a, b) => a[0] - b[0]).map(([lineNo, list]) => (
                        <li key={lineNo}>
                          <button onClick={() => pickLine(lineNo, false)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-accent">
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{lineNo}</span>
                            <span className="min-w-0 flex-1 text-subtle">{list.map((note) => note.note).join(' / ')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab !== 'ask' && (
          <div className="min-h-0 border-t p-3 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <h4 className="m-0 mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">讲解</h4>
            {!available.length && (
              <div className="px-1 py-6">
                <p className="m-0 text-xs text-muted-foreground">
                  这个节点还没有讲解。导入一个 <code className="font-mono">blackboard.lesson.v1</code> JSON，或让 Agent 生成。
                </p>
                {node.type === 'unit' && (
                  <Button size="sm" className="mt-3 h-7 text-[11px]" disabled={sending || staticMode} onClick={() => void requestUnitLesson()}>
                    <Sparkles className="size-3.5" />{sending ? '提交中…' : '让 Agent 讲解本函数'}
                  </Button>
                )}
              </div>
            )}
            {!hasUnitLesson && activeLesson && (
              <div className="mb-3 rounded-lg border border-live/30 bg-live/5 p-2.5 text-[11px] leading-5 text-subtle">
                当前函数还没有单独的 unit 级讲解；下面显示的是「{SCOPE_LABEL[lessonScope(activeLesson, node)]}」背景内容。
                {node.type === 'unit' && (
                  <Button size="sm" variant="outline" className="ml-2 h-6 px-2 text-[10.5px]" disabled={sending || staticMode} onClick={() => void requestUnitLesson()}>
                    {sending ? '提交中…' : '让 Agent 讲解本函数'}
                  </Button>
                )}
              </div>
            )}
            {available.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {available.map((lesson) => (
                  <button
                    key={lesson.id}
                    onClick={() => setActiveLessonId(lesson.id)}
                    aria-pressed={activeLesson?.id === lesson.id}
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors ${activeLesson?.id === lesson.id ? 'border-foreground bg-accent font-medium' : 'text-subtle hover:border-strong'}`}
                  >
                    {SCOPE_LABEL[lessonScope(lesson, node)]} · {lessonLevelLabel(lesson.level)} · {lesson.title}
                  </button>
                ))}
              </div>
            )}
            {activeLesson && <LessonView lesson={activeLesson} scope={lessonScope(activeLesson, node)} onPickLine={pickLine} />}
          </div>
        )}

        {tab === 'ask' && (
          <div className="p-3">
            <div className="rounded-lg border bg-secondary/40 p-3">
              <p className="m-0 text-xs text-muted-foreground">
                目标：{node.file ? `${node.file}:${selection?.start ?? node.startLine}-${selection?.end ?? node.endLine}` : node.title}
              </p>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={4}
                placeholder="例如：这里的竞态窗口为什么在锁内还会出问题？"
                className="mt-2 w-full resize-y rounded-md border bg-card px-2.5 py-2 text-[13px] outline-none focus-visible:border-strong"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" onClick={submit} disabled={!question.trim() || sending || staticMode}>
                  <Send className="size-3.5" />{sending ? '提交中…' : '提交给 Agent'}
                </Button>
                {staticMode && <span className="text-[11px] text-muted-foreground">离线导出为只读，不能提问</span>}
              </div>
              {notice && <p className="m-0 mt-2 text-[12px] text-live">{notice}</p>}
              {error && <p className="m-0 mt-2 text-[12px] text-destructive">{error}</p>}
            </div>

            <h4 className="m-0 mb-1.5 mt-4 px-1 text-xs font-medium text-muted-foreground">相关提问 {requests.length}</h4>
            {!requests.length && <p className="m-0 px-1 text-xs text-muted-foreground">这个节点还没有学生提问。</p>}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {requests.map((request) => {
                const answers = replies.filter((reply) => reply.requestId === request.id);
                return (
                  <li key={request.id} className="rounded-lg border p-2.5">
                    <div className="flex items-start gap-2 text-[12px]">
                      <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">{request.question}</span>
                      <span className={`shrink-0 text-[11px] ${answers.length ? 'text-live' : 'text-muted-foreground'}`}>{answers.length ? '已答' : '待答'}</span>
                    </div>
                    {answers.map((reply) => (
                      <div key={reply.id} className="mt-2 border-l-2 border-live/40 pl-2.5 text-[12px] text-subtle">
                        <span className="font-medium text-foreground">{reply.author}</span>
                        <Markdown text={reply.text} />
                      </div>
                    ))}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}

function LessonView({ lesson, scope, onPickLine }: { lesson: Lesson; scope: LessonScope; onPickLine: (line: number, shift: boolean) => void }) {
  return (
    <article>
      <h3 className="m-0 text-[15px] font-semibold leading-snug">{lesson.title}</h3>
      <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px]">{SCOPE_LABEL[scope]}</span>
        <span>{lessonLevelLabel(lesson.level)}</span>
        {lesson.difficulty && <span>· {difficultyLabel(lesson.difficulty)}</span>}
        {lesson.skill?.name && <span>· {lesson.skill.name}</span>}
        {lesson.lineNotes.length > 0 && <span>· {lesson.lineNotes.length} 行批注</span>}
      </p>
      {lesson.summary && <div className="mt-2"><Markdown text={lesson.summary} /></div>}
      {lesson.sections.map((section, index) => (
        <section key={`${lesson.id}-s${index}`} className="mt-3">
          {section.heading && <h4 className="m-0 mb-1 text-[13px] font-semibold text-foreground">{section.heading}</h4>}
          <Markdown text={section.body} />
          {section.refs?.length ? <p className="m-0 mt-1 text-[11px] text-muted-foreground">引用：{section.refs.join(', ')}</p> : null}
        </section>
      ))}
      {lesson.concepts.length > 0 && (
        <section className="mt-4">
          <h4 className="m-0 mb-1 text-[13px] font-semibold">概念</h4>
          <dl className="m-0 flex flex-col gap-1.5">
            {lesson.concepts.map((concept, index) => (
              <div key={`${lesson.id}-c${index}`} className="rounded-md border px-2.5 py-2">
                <dt className="text-[12px] font-medium">{concept.term}</dt>
                <dd className="m-0 text-[12px] text-subtle">{concept.explain}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {lesson.lineNotes.length > 0 && (
        <section className="mt-4">
          <h4 className="m-0 mb-1 text-[13px] font-semibold">逐行批注</h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {lesson.lineNotes.map((note, index) => (
              <li key={`${lesson.id}-n${index}`}>
                <button onClick={() => onPickLine(note.line, false)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent">
                  <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{note.file}:{note.line}</span>
                  <span className="min-w-0 flex-1 text-[12px] text-subtle">{note.note}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {lesson.exercises.length > 0 && (
        <section className="mt-4">
          <h4 className="m-0 mb-1 text-[13px] font-semibold">练习</h4>
          <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[12px]">
            {lesson.exercises.map((exercise, index) => (
              <li key={`${lesson.id}-e${index}`}>
                <p className="m-0">{exercise.prompt}</p>
                {exercise.answer && (
                  <details className="mt-1 text-muted-foreground">
                    <summary className="cursor-pointer text-[11px]">参考答案</summary>
                    <Markdown text={exercise.answer} />
                  </details>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {lesson.prerequisites.length > 0 && (
        <section className="mt-4">
          <h4 className="m-0 mb-1 text-[13px] font-semibold">前置知识</h4>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12px] text-subtle">
            {lesson.prerequisites.map((item, index) => <li key={`${lesson.id}-p${index}`}>{item}</li>)}
          </ul>
        </section>
      )}
    </article>
  );
}
