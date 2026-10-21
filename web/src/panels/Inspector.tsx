import { Collapsible } from 'radix-ui';
import { Check, CheckCircle2, ArrowDownLeft, ArrowUpRight, ChevronRight, FileText, Link2, Lock, LockOpen, Target, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { NodeTypeIcon, TypeDot } from '../SecurityNode';
import { formatTime, relationLabel, typeLabel } from '../graph';
import { confidenceLabel, difficultyLabel, lessonLevelLabel, phaseLabel, presentNode, severityLabel, statusLabel, unitKindLabel } from '../presentation';
import type { BoardEdge, BoardNode, Lesson } from '../types';

type Props = {
  node: BoardNode;
  edges: BoardEdge[];
  byId: Map<string, BoardNode>;
  onClose: () => void;
  onFocus: (id: string) => void;
  onCopyLink?: () => void;
  linkCopied?: boolean;
  onOpenStudy?: (id: string) => void;
  lessons?: Lesson[];
  canEdit?: boolean;
  progressBusy?: boolean;
  onToggleLearned?: (node: BoardNode) => void;
  locked?: boolean;
  onToggleLock?: () => void;
  onStudyStage?: (id: string) => void;
};

export function Inspector({ node, edges, byId, onClose, onFocus, onCopyLink, linkCopied, onOpenStudy, lessons = [], canEdit = false, progressBusy = false, onToggleLearned, locked = false, onToggleLock, onStudyStage }: Props) {
  const relations = edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  const text = presentNode(node);
  const severe = node.severity === 'critical' || node.severity === 'high';
  const isUnit = node.type === 'unit';
  const isStage = node.type === 'stage';
  return (
    <aside
      aria-label="节点详情"
      className="anim-slide-in absolute inset-x-3 bottom-3 top-auto z-20 flex max-h-[62%] flex-col rounded-xl border bg-card shadow-float sm:inset-x-auto sm:right-3 sm:top-3 sm:max-h-none sm:w-[360px]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
        <span className="text-muted-foreground"><NodeTypeIcon type={node.type} size={14} /></span>
        <span className="text-[13px] font-medium">{typeLabel(node.type)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={node.id}>{node.id}</span>
        {onOpenStudy && (
          <IconButton label="打开代码与讲解" onClick={() => onOpenStudy(node.id)}><FileText /></IconButton>
        )}
        {onCopyLink && <IconButton label={linkCopied ? '链接已复制' : '复制节点链接'} onClick={onCopyLink}>{linkCopied ? <Check /> : <Link2 />}</IconButton>}
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
        <IconButton label="关闭详情" onClick={onClose}><X /></IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <h2 className="m-0 text-[17px] font-semibold leading-snug tracking-[-0.01em]">{text.headline}</h2>
        {isUnit && (
          <p className="mt-1.5 mb-0 font-mono text-[11px] text-muted-foreground">
            {unitKindLabel(node.kind)} · {node.file}:{node.startLine}-{node.endLine}
          </p>
        )}
        {isUnit && node.role && (
          <p className="mt-2 mb-0 rounded-md bg-secondary/70 px-2 py-1 text-[12px] leading-5 text-subtle">{node.role}</p>
        )}
        {text.summary && <p className="mt-2 mb-0 text-[13px] leading-[22px] text-subtle">{text.summary}</p>}
        {text.detail && <p className="mt-2 mb-0 text-[13px] leading-[22px] text-subtle">{text.detail}</p>}

        {isStage && onStudyStage && (
          <Button size="sm" className="mt-3" onClick={() => onStudyStage(node.id)}>
            <Target className="size-3.5" />只显示本阶段函数
          </Button>
        )}

        {onToggleLock && (
          <Button size="sm" variant={locked ? 'default' : 'outline'} className="mt-3" onClick={onToggleLock}>
            {locked ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
            {locked ? '解除锁定聚焦' : '锁定聚焦'}
          </Button>
        )}

        {isUnit && (
          <>
            <div className="mt-3 flex items-center gap-2">
              {onOpenStudy && (
                <Button size="sm" variant="outline" onClick={() => onOpenStudy(node.id)}>
                  <FileText className="size-3.5" />查看实现
                </Button>
              )}
              <Button
                size="sm"
                variant={node.learned ? 'outline' : 'default'}
                className="flex-1"
                disabled={!canEdit || progressBusy}
                onClick={() => onToggleLearned?.(node)}
              >
                <CheckCircle2 className={node.learned ? 'size-3.5 text-live' : 'size-3.5'} />
                {node.learned ? '已学习，点击取消' : '标记学习完毕'}
              </Button>
            </div>
            {node.learned && node.learnedAt && (
              <p className="mt-1 text-right text-[10.5px] text-muted-foreground">学习于 {formatTime(Number(node.learnedAt))}</p>
            )}
          </>
        )}

        <dl className="mt-5 mb-0 divide-y rounded-lg border text-[13px]">
          {isUnit ? (
            <>
              <Prop label="类型" value={unitKindLabel(node.kind)} />
              <Prop label="位置" value={`${node.file}:${node.startLine}-${node.endLine}`} />
              <Prop label="作用" value={node.role || '未标注'} />
              <Prop label="难度" value={difficultyLabel(node.difficulty) || '未标注'} />
              <Prop label="标签" value={node.tags?.length ? node.tags.join(', ') : '无'} />
            </>
          ) : isStage ? (
            <>
              <Prop label="阶段" value={phaseLabel(node.phase)} />
              <Prop label="状态" value={statusLabel(node.status)} />
              <Prop label="实现单元" value={String(relations.filter((edge) => edge.kind === 'implements' && edge.to === node.id).length)} />
            </>
          ) : (
            <>
              <Prop label="状态" value={statusLabel(node.status)} />
              <Prop label="风险" value={severityLabel(node.severity)} tone={severe ? 'danger' : undefined} />
              <Prop label="可信度" value={confidenceLabel(node.confidence)} />
            </>
          )}
          <Prop label="创建" value={formatTime(Number(node.ts || 0))} />
          <Prop label="更新" value={formatTime(Number(node.updated || node.ts || 0))} />
        </dl>

        {isUnit && node.signature && (
          <pre className="mt-3 mb-0 overflow-x-auto rounded-lg border bg-secondary p-2.5 font-mono text-[11px] leading-[18px] text-subtle">{node.signature}</pre>
        )}

        {lessons.length > 0 && onOpenStudy && (
          <section className="mt-5">
            <h3 className="m-0 mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              讲解<span className="tabular-nums font-normal">{lessons.length}</span>
            </h3>
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {lessons.map((lesson) => (
                <li key={lesson.id}>
                  <button onClick={() => onOpenStudy(node.id)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent">
                    <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] leading-5">{lesson.title}</span>
                      <span className="text-[11px] leading-4 text-muted-foreground">{lessonLevelLabel(lesson.level)}{lesson.lineNotes.length ? ` · ${lesson.lineNotes.length} 行批注` : ''}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-6">
          <h3 className="m-0 mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            关系<span className="tabular-nums font-normal">{relations.length}</span>
          </h3>
          {relations.length ? (
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {relations.map((edge) => {
                const incoming = edge.to === node.id;
                const peer = byId.get(incoming ? edge.from : edge.to);
                const Arrow = incoming ? ArrowDownLeft : ArrowUpRight;
                return (
                  <li key={edge.id}>
                    <button
                      onClick={() => peer && onFocus(peer.id)}
                      className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <Arrow className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={incoming ? '来自' : '指向'} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                          {relationLabel(edge.kind)}
                          {peer && <><span aria-hidden>·</span><TypeDot type={peer.type} className="size-1.5" />{typeLabel(peer.type)}{peer.type === 'unit' && peer.file ? <span className="truncate"> · {peer.file}</span> : null}</>}
                        </span>
                        <span className="line-clamp-2 text-[13px] leading-5">{peer ? presentNode(peer).headline : incoming ? edge.from : edge.to}</span>
                      </span>
                      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">这个节点尚未建立逻辑关系。</p>
          )}
        </section>

        <Collapsible.Root key={node.id} className="mt-6">
          <Collapsible.Trigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />原始数据
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre className="mt-2 mb-0 max-h-64 overflow-auto rounded-lg border bg-secondary p-3 font-mono text-[11px] leading-[18px] text-subtle">{JSON.stringify(node, null, 2)}</pre>
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
    </aside>
  );
}

function Prop({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 min-w-0 truncate tabular-nums', tone === 'danger' && 'font-medium text-destructive')}>{value}</dd>
    </div>
  );
}
