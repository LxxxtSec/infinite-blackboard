import { useState, type ReactNode } from 'react';
import { Collapsible } from 'radix-ui';
import { ChevronRight, Crosshair, MessageSquareText, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { TypeDot } from '../SecurityNode';
import { FilterPopover } from './FilterPopover';
import { confidenceLabel, phaseLabel, presentNode, severityLabel } from '../presentation';
import { typeLabel } from '../graph';
import type { NodeFilter } from '../presentation';
import type { BoardNode, Reply, StudentRequest, TeachingCoverage } from '../types';

type TeachingSection = {
  stages: BoardNode[];
  fileDeps: { from: string; to: string; count: number; kind: 'calls' | 'include' }[];
  uncovered: BoardNode[];
  requests: StudentRequest[];
  answers: Reply[];
  coverage?: TeachingCoverage | null;
};

type Props = {
  current: BoardNode | null;
  openItems: BoardNode[];
  findings: BoardNode[];
  inbox: BoardNode[];
  selectedId: string | null;
  counts: { nodes: number; edges: number; risk: number; open: number; candidates: number; learned?: number };
  onSelect: (id: string) => void;
  onSearch: () => void;
  onShortcuts: () => void;
  filter: NodeFilter;
  onFilter: (filter: NodeFilter) => void;
  filterOptions: { types: { value: string; count: number }[]; statuses: { value: string; count: number }[]; confidences: { value: string; count: number }[]; riskCount: number };
  results: BoardNode[] | null;
  teaching?: TeachingSection | null;
  onOpenStudy?: (id: string) => void;
};

export function Sidebar({ current, openItems, findings, inbox, selectedId, counts, onSelect, onSearch, onShortcuts, filter, onFilter, filterOptions, results, teaching, onOpenStudy }: Props) {
  const answered = new Set((teaching?.answers || []).map((reply) => reply.requestId));
  const openRequests = (teaching?.requests || []).filter((request) => !answered.has(request.id));
  return (
    <div className="flex h-full w-full flex-col" aria-label="任务导航">
      <div className="flex gap-2 p-3 pb-2">
        <button
          onClick={onSearch}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-card px-2.5 text-[13px] text-muted-foreground shadow-xs transition-colors hover:border-strong hover:text-foreground"
        >
          <Search className="size-3.5" />搜索节点<Kbd className="ml-auto">⌘K</Kbd>
        </button>
        <FilterPopover filter={filter} onChange={onFilter} {...filterOptions} />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {results ? (
          <>
            <div className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">
              筛选结果<span className="ml-1.5 tabular-nums font-normal">{results.length}</span>
              <Button variant="ghost" size="sm" className="ml-auto -mr-1 h-6 px-1.5 text-xs" onClick={() => onFilter({ types: [], statuses: [], confidences: [], riskOnly: false })}><X className="size-3" />清除</Button>
            </div>
            <div className="flex flex-col gap-px pt-0.5">
              {results.length
                ? results.map((node) => <Row key={node.id} node={node} selected={selectedId === node.id} current={node.id === current?.id} onSelect={onSelect} onOpenStudy={onOpenStudy} />)
                : <Empty>没有符合条件的节点，放宽一个条件试试。</Empty>}
            </div>
          </>
        ) : (<>
          <Section title="正在关注" count={current ? 1 : 0}>
            {current ? <Row node={current} selected={selectedId === current.id} current onSelect={onSelect} onOpenStudy={onOpenStudy} /> : <Empty>Agent 尚未设置游标</Empty>}
          </Section>

          {teaching && teaching.fileDeps.length > 0 && (
            <Section title="文件依赖" count={teaching.fileDeps.length}>
              {teaching.fileDeps.slice(0, 10).map((dep) => (
                <div key={`${dep.kind}:${dep.from}->${dep.to}`} className="flex items-baseline gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="shrink-0 rounded bg-secondary px-1 text-[10px]">{dep.kind === 'include' ? '引用' : '调用'}</span>
                  <span className="truncate font-mono text-foreground" title={dep.from}>{dep.from.split('/').pop()}</span>
                  <span aria-hidden>→</span>
                  <span className="truncate font-mono text-foreground" title={dep.to}>{dep.to.split('/').pop()}</span>
                  {dep.kind === 'calls' && <span className="ml-auto tabular-nums">×{dep.count}</span>}
                </div>
              ))}
            </Section>
          )}

          {teaching && teaching.stages.length > 0 && (
            <Section title="攻击链" count={teaching.stages.length}>
              {teaching.stages.map((stage) => (
                <Row key={stage.id} node={stage} selected={selectedId === stage.id} onSelect={onSelect} onOpenStudy={onOpenStudy} subtitle={stage.phase ? phaseLabel(stage.phase) : undefined} />
              ))}
            </Section>
          )}

          {teaching && (
            <Section title="未讲解单元" count={teaching.uncovered.length} defaultOpen>
              {teaching.uncovered.length
                ? teaching.uncovered.slice(0, 10).map((unit) => (
                  <Row key={unit.id} node={unit} selected={selectedId === unit.id} onSelect={onSelect} onOpenStudy={onOpenStudy} subtitle={unit.file ? `${unit.file}:${unit.startLine}` : undefined} />
                ))
                : <Empty>所有代码单元都有讲解</Empty>}
            </Section>
          )}

          {teaching && (
            <Section title="学生提问" count={openRequests.length} defaultOpen={openRequests.length > 0}>
              {openRequests.length
                ? openRequests.slice(0, 8).map((request) => (
                  <button
                    key={request.id}
                    onClick={() => request.unitId && onSelect(request.unitId)}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    title={request.question}
                  >
                    <MessageSquareText className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] leading-5 text-foreground">{request.question}</span>
                      <span className="text-[11px] leading-4 text-muted-foreground">
                        {request.unitId || request.file || '整块黑板'}
                      </span>
                    </span>
                  </button>
                ))
                : <Empty>没有待回答的提问</Empty>}
            </Section>
          )}

          {!teaching && (
            <Section title="待验证" count={openItems.length}>
              {openItems.length ? openItems.map((node) => <Row key={node.id} node={node} selected={selectedId === node.id} onSelect={onSelect} onOpenStudy={onOpenStudy} />) : <Empty>当前没有开放假设</Empty>}
            </Section>
          )}

          <Section title="发现" count={findings.length}>
            {findings.length ? findings.slice(0, 8).map((node) => <Row key={node.id} node={node} selected={selectedId === node.id} onSelect={onSelect} onOpenStudy={onOpenStudy} />) : <Empty>还没有记录发现</Empty>}
          </Section>

          <Section title="未连接" count={inbox.length} defaultOpen={false}>
            {inbox.slice(0, 10).map((node) => <Row key={node.id} node={node} selected={selectedId === node.id} onSelect={onSelect} onOpenStudy={onOpenStudy} />)}
          </Section>
        </>)}
      </nav>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
        <span className="whitespace-nowrap">{counts.nodes} 节点</span>
        <span className="whitespace-nowrap">{counts.edges} 关系</span>
        {counts.open > 0 && <span className="whitespace-nowrap">{counts.open} 待验证</span>}
        {teaching?.coverage && <span className="whitespace-nowrap">{Math.round(teaching.coverage.units.ratio * 100)}% 覆盖</span>}
        {Boolean(counts.learned) && <span className="whitespace-nowrap text-live">{counts.learned} 已学</span>}
        {counts.risk > 0 && <span className="whitespace-nowrap text-destructive">{counts.risk} 高风险</span>}
        <button className="ml-auto inline-flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground" onClick={onShortcuts} aria-label="键盘快捷键">
          <Kbd>?</Kbd>
        </button>
      </footer>
    </div>
  );
}

function Section({ title, count, defaultOpen = true, children }: { title: string; count: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-1">
      <Collapsible.Trigger className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        {title}
        <span className="ml-auto tabular-nums font-normal">{count}</span>
      </Collapsible.Trigger>
      <Collapsible.Content className="flex flex-col gap-px pt-0.5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

function Row({ node, current = false, selected, onSelect, onOpenStudy, subtitle }: { node: BoardNode; current?: boolean; selected: boolean; onSelect: (id: string) => void; onOpenStudy?: (id: string) => void; subtitle?: string }) {
  const severe = node.severity === 'critical' || node.severity === 'high';
  return (
    <button
      onClick={() => onSelect(node.id)}
      onDoubleClick={() => onOpenStudy?.(node.id)}
      aria-pressed={selected}
      title={node.title}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
        selected && 'bg-accent',
      )}
    >
      <TypeDot type={node.type} className="mt-[7px]" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] leading-5 text-foreground">{presentNode(node).headline}</span>
        <span className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
          {typeLabel(node.type)}
          {subtitle && <span className="truncate">· {subtitle}</span>}
          {!subtitle && severe && <span className="text-destructive">· {severityLabel(node.severity)}</span>}
          {!subtitle && node.confidence && <span>· {confidenceLabel(node.confidence)}</span>}
          {node.learned && <span className="text-live">✓ 已学</span>}
        </span>
      </span>
      {current && <Crosshair className="mt-1 size-3.5 shrink-0 text-live" />}
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">{children}</p>;
}
