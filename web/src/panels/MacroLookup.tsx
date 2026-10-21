import { useEffect, useMemo, useState } from 'react';
import { FileText, Search, Sparkles } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { BoardNode, GraphSnapshot } from '../types';
import { values } from '../types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: GraphSnapshot;
  macros: BoardNode[];
  onOpenMacro: (id: string) => void;
  onRequestNotes?: (missing: BoardNode[]) => void;
};

type Slice = { file: string; start: number; end: number; lines: { line: number; text: string }[]; loading?: boolean; error?: string };

function sliceOf(snapshot: GraphSnapshot, file: string, start: number, end: number): Slice | null {
  const embedded = snapshot.code?.[file];
  if (!embedded) return null;
  const from = Math.max(1, start);
  const to = Math.min(embedded.content.length, end);
  return {
    file,
    start: from,
    end: to,
    lines: embedded.content.slice(from - 1, to).map((text, index) => ({ line: from + index, text })),
  };
}

function fallbackMeaning(macro: BoardNode): { role?: string; detail?: string; auto: boolean } {
  const name = String(macro.symbol || macro.title || '');
  const file = String(macro.file || '').split('/').pop() || '';
  if (name === '_GNU_SOURCE') {
    return { auto: true, role: '启用 GNU/POSIX 扩展', detail: '必须出现在任何系统头之前；没有它，memfd_create、pselect 等 GNU 扩展可能不可用。' };
  }
  if (['__ARM', '__aarch64__', '__x86_64__', '__INTEL', '__linux__'].includes(name)) {
    return { auto: true, role: '目标架构 / 平台条件编译宏', detail: '由编译器预定义，用来选择当前架构或平台对应的代码分支；不是 PoC 自己实现的逻辑。' };
  }
  if (/^[A-Z0-9_]+_H$/.test(name) && /\.[hH]$/.test(file)) {
    return { auto: true, role: '头文件包含保护宏', detail: `防止 ${file} 被重复 include；通常配合 #ifndef/#define/#endif 使用，不参与漏洞逻辑。` };
  }
  if (name === 'fallthrough') {
    return { auto: true, role: '编译器提示：故意贯穿 switch case', detail: '告诉编译器这个 case 不 break 是有意的，避免 -Wimplicit-fallthrough 警告。' };
  }
  if (/^pr_(error|warning|warn|info|success|debug)$/.test(name)) {
    return { auto: true, role: '日志辅助宏', detail: '统一格式化并输出带位置信息的日志，常包一层 printf/fprintf；不是利用原语。' };
  }
  return { auto: false };
}

export function MacroLookup({ open, onOpenChange, snapshot, macros, onOpenMacro, onRequestNotes }: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => (macros.find((macro) => macro.detail || macro.role) || macros[0])?.id || null);
  const [code, setCode] = useState<Slice | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const missing = useMemo(() => macros.filter((macro) => !macro.role), [macros]);
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return macros
      .filter((macro) => {
        if (onlyMissing && macro.role) return false;
        if (!terms.length) return true;
        const hay = `${macro.symbol || macro.title} ${macro.role || ''} ${macro.detail || ''} ${macro.file || ''} ${macro.signature || ''}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
      .sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')) || Number(a.startLine || 0) - Number(b.startLine || 0));
  }, [macros, query, onlyMissing]);

  useEffect(() => {
    if (!open) return;
    setSelectedId((current) => (current && macros.some((macro) => macro.id === current)
      ? current
      : (macros.find((macro) => macro.detail || macro.role) || macros[0])?.id || null));
    setQuery('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = macros.find((macro) => macro.id === selectedId) || null;
  const fallback = selected ? fallbackMeaning(selected) : null;

  useEffect(() => {
    if (!open || !selected) { setCode(null); return; }
    const start = Math.max(1, Number(selected.startLine || 1) - 2);
    const end = Number(selected.endLine || selected.startLine || start) + 2;
    const embedded = sliceOf(snapshot, String(selected.file), start, end);
    if (embedded) { setCode(embedded); return; }
    let alive = true;
    setCode({ file: String(selected.file), start, end, lines: [], loading: true });
    fetch(`/api/file?path=${encodeURIComponent(String(selected.file))}&start=${start}&end=${end}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((body: { start: number; end: number; slice: { line: number; text: string }[] }) => {
        if (!alive) return;
        setCode({ file: String(selected.file), start: body.start, end: body.end, lines: body.slice });
      })
      .catch((error: Error) => { if (alive) setCode({ file: String(selected.file), start, end, lines: [], error: error.message }); });
    return () => { alive = false; };
  }, [open, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent position="top" className="max-h-[82vh] w-[min(980px,calc(100vw-32px))] overflow-hidden p-0">
        <DialogTitle className="sr-only">宏查询</DialogTitle>
        <DialogDescription className="sr-only">宏定义、作用与来源说明</DialogDescription>
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <span className="text-[14px] font-semibold">宏查询</span>
          <span className="text-[11px] text-muted-foreground">宏不画在画布上；点一行查看定义代码、意义和来源</span>
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">已标注 {macros.length - missing.length}/{macros.length}</span>
          <Button size="sm" variant={onlyMissing ? 'default' : 'outline'} onClick={() => setOnlyMissing((value) => !value)}>
            只看未标注 {missing.length}
          </Button>
          {onRequestNotes && missing.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => { onRequestNotes(missing); onOpenChange(false); }}>
              <Sparkles className="size-3.5" />让 Agent 补全
            </Button>
          )}
        </header>

        <div className="flex h-[min(620px,70vh)]">
          <div className="flex w-[320px] shrink-0 flex-col border-r">
            <div className="border-b p-2">
              <label className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2">
                <Search className="size-3.5 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索宏名 / 作用 / 来源"
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {!filtered.length && <p className="m-0 px-2 py-6 text-center text-[12px] text-muted-foreground">没有匹配的宏</p>}
              {filtered.map((macro) => {
                const active = macro.id === selectedId;
                return (
                  <button
                    key={macro.id}
                    onClick={() => setSelectedId(macro.id)}
                    className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${active ? 'bg-secondary' : 'hover:bg-accent'}`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-[12px] font-medium">{macro.symbol || macro.title}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{macro.file?.split('/').pop()}</span>
                    </span>
                    <span className="line-clamp-1 text-[10.5px] text-muted-foreground">{macro.role || fallbackMeaning(macro).role || '未标注作用'}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto">
            {!selected ? (
              <p className="m-0 px-4 py-8 text-center text-[12px] text-muted-foreground">这个黑板还没有宏</p>
            ) : (
              <div className="flex flex-col gap-4 p-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0">
                    <h3 className="m-0 font-mono text-[16px] font-semibold">{selected.symbol || selected.title}</h3>
                    <p className="m-0 mt-1 text-[11px] text-muted-foreground">
                      {selected.file}:{selected.startLine}-{selected.endLine}
                      {selected.kind ? ` · ${selected.kind}` : ''}
                    </p>
                  </div>
                  <Button size="sm" className="ml-auto" onClick={() => { onOpenMacro(selected.id); onOpenChange(false); }}>
                    <FileText className="size-3.5" />在代码面板打开
                  </Button>
                </div>

                <section>
                  <h4 className="m-0 mb-1 text-[11px] font-medium text-muted-foreground">定义（含上下文）</h4>
                  <div className="overflow-x-auto rounded-lg border bg-secondary/40 py-1 font-mono text-[11.5px] leading-[19px]">
                    {code?.loading && <p className="m-0 px-3 py-2 text-[11px] text-muted-foreground">读取代码…</p>}
                    {code?.error && <p className="m-0 px-3 py-2 text-[11px] text-destructive">代码读取失败：{code.error}</p>}
                    {code?.lines.map((line) => {
                      const inMacro = line.line >= Number(selected.startLine) && line.line <= Number(selected.endLine);
                      return (
                        <div key={line.line} className={`flex gap-2 px-2 ${inMacro ? 'bg-accent/70 text-foreground' : 'text-subtle'}`}>
                          <span className="w-9 shrink-0 select-none text-right text-muted-foreground">{line.line}</span>
                          <span className="whitespace-pre-wrap break-all">{line.text || ' '}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <h4 className="m-0 mb-1 text-[11px] font-medium text-muted-foreground">它代表什么</h4>
                  <p className="m-0 text-[12.5px] leading-[21px] text-subtle">
                    {selected.role || fallback?.role || '还没有标注作用。可以让 Agent 执行 annotate 写上 role。'}
                    {!selected.role && fallback?.auto && <span className="ml-2 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">自动识别，待 Agent 确认</span>}
                  </p>
                </section>

                <section>
                  <h4 className="m-0 mb-1 text-[11px] font-medium text-muted-foreground">来源 / 讲解</h4>
                  <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-[21px] text-subtle">
                    {selected.detail || fallback?.detail || `定义在 ${selected.file}:${selected.startLine}。还没有来源说明；可以用 annotate 的 detail 字段补充它来自哪个头文件、对应哪条 ABI 或需要按什么目标核对。`}
                  </p>
                </section>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
