import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { orderedStages } from '../graph';
import type { BoardNode, BoardEdge, GraphSnapshot } from '../types';
import { values } from '../types';

type Tab = 'source' | 'roles' | 'chain' | 'lesson';
type Action = 'import' | 'roles' | 'chain' | 'lesson';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: GraphSnapshot;
  onDone: (action: Action, message: string) => void;
  initialTab?: string;
};

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'source', label: '源码', hint: '给 zip 或 git 仓库地址，Agent/黑板会放到 .flow/sources 后解析' },
  { id: 'roles', label: '函数作用', hint: '每个函数一行作用，key 支持 u12 / 唯一符号 / 文件:符号' },
  { id: 'chain', label: '攻击链', hint: '按这份 PoC 的实际路径写阶段；标题和 phase 自由，不套固定十步' },
  { id: 'lesson', label: '讲解', hint: '粘贴或上传 blackboard.lesson.v1 JSON' },
];

function unitRef(unit: BoardNode, duplicates: Set<string>): string {
  const symbol = String(unit.symbol || unit.title || unit.id);
  return duplicates.has(symbol) ? `${unit.file}:${symbol}` : symbol;
}

export function ManageDialog({ open, onOpenChange, snapshot, onDone, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>('source');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [source, setSource] = useState('');
  const [dest, setDest] = useState('');
  const [rolesText, setRolesText] = useState('{\n  \n}');
  const [chainText, setChainText] = useState('{\n  "stages": []\n}');
  const [replaceChain, setReplaceChain] = useState(true);
  const [lessonText, setLessonText] = useState('');

  const { units, duplicates, stageJson } = useMemo(() => {
    const all = values(snapshot.nodes).filter((node) => node.status !== 'removed');
    const list = all.filter((node) => node.type === 'unit');
    const counts = new Map<string, number>();
    for (const unit of list) {
      const symbol = String(unit.symbol || unit.title || '');
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    }
    const dup = new Set([...counts].filter(([, count]) => count > 1).map(([symbol]) => symbol));
    const roles: Record<string, string> = {};
    for (const unit of list) {
      if (unit.role) roles[unitRef(unit, dup)] = String(unit.role);
    }
    const edges = values(snapshot.edges);
    const stages = orderedStages(all as BoardNode[], edges as BoardEdge[]);
    const byId = new Map(all.map((node) => [node.id, node]));
    const chain = {
      stages: stages.map((stage) => ({
        title: stage.title,
        ...(stage.phase ? { phase: String(stage.phase) } : {}),
        ...(stage.detail ? { detail: String(stage.detail) } : {}),
        units: edges
          .filter((edge) => edge.kind === 'implements' && edge.to === stage.id)
          .map((edge) => byId.get(edge.from))
          .filter(Boolean)
          .map((unit) => unitRef(unit as BoardNode, dup)),
      })),
    };
    return { units: list, duplicates: dup, stageJson: JSON.stringify(chain, null, 2), roleJson: roles };
  }, [snapshot]);

  const rolesInitial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const unit of units) if (unit.role) map[unitRef(unit, duplicates)] = String(unit.role);
    return JSON.stringify(map, null, 2);
  }, [units, duplicates]);

  useEffect(() => {
    if (!open) return;
    if (initialTab && TABS.some((item) => item.id === initialTab)) setTab(initialTab as Tab);
    setError(null);
    setNotice(null);
    setRolesText(rolesInitial);
    setChainText(stageJson);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const token = snapshot.requestToken;
  const canWrite = Boolean(token);

  const postJson = async (url: string, body: unknown) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-blackboard-request': String(token) },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
    return payload;
  };

  const run = async (action: Action, work: () => Promise<string>) => {
    if (!canWrite) { setError('离线导出为只读，请在 serve 打开的页面操作'); return; }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      setNotice(message);
      onDone(action, message);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const importSource = () => run('import', async () => {
    if (!source.trim()) throw new Error('请输入 zip 路径或 git 仓库地址');
    const payload = await postJson('/api/import', { source: source.trim(), dest: dest.trim() || undefined });
    const count = payload.files?.length || 0;
    return `已导入 ${count} 个文件 · ${payload.stats?.units || 0} 个代码单元；来源 ${payload.source?.path || ''}`;
  });

  const uploadArchive = (file: File | null) => {
    if (!file) return;
    void run('import', async () => {
      const response = await fetch('/api/import/upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/zip',
          'x-filename': file.name,
          'x-blackboard-request': String(token),
        },
        body: file,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
      return `已上传并导入 ${file.name} · ${payload.stats?.units || 0} 个代码单元`;
    });
  };

  const saveRoles = () => run('roles', async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(rolesText); } catch (parseError) { throw new Error(`角色 JSON 不合法：${(parseError as Error).message}`); }
    if (!parsed || typeof parsed !== 'object') throw new Error('角色 JSON 需要是 { "u12": "作用" }');
    const payload = await postJson('/api/roles', { roles: parsed });
    return `已更新 ${payload.updated?.length || 0} 个函数作用`;
  });

  const saveChain = () => run('chain', async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(chainText); } catch (parseError) { throw new Error(`攻击链 JSON 不合法：${(parseError as Error).message}`); }
    const stages = Array.isArray(parsed) ? parsed : (parsed as { stages?: unknown })?.stages;
    if (!Array.isArray(stages)) throw new Error('需要一个 { "stages": [...] } 对象');
    const payload = await postJson('/api/chain', { stages, replace: replaceChain });
    return `已写入攻击链 ${payload.stages?.length || 0} 个阶段${replaceChain ? '（已替换旧链）' : ''}`;
  });

  const saveLesson = () => run('lesson', async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(lessonText); } catch (parseError) { throw new Error(`讲解 JSON 不合法：${(parseError as Error).message}`); }
    const payload = await postJson('/api/lesson', { lesson: parsed });
    return `已导入讲解 ${payload.lesson?.id || ''}：${payload.lesson?.title || ''}`;
  });

  const uploadLesson = (file: File | null) => {
    if (!file) return;
    void file.text().then((text) => {
      setLessonText(text);
      setNotice(`已读取 ${file.name}，检查后点「导入讲解」`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent position="top" className="max-h-[80vh] max-w-[820px] overflow-y-auto p-0">
        <DialogTitle className="sr-only">导入与编辑</DialogTitle>
        <DialogDescription className="sr-only">导入 PoC 源码、写函数作用、攻击链和讲解。</DialogDescription>
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <span className="text-[14px] font-semibold">导入与编辑</span>
          <span className="text-[11px] text-muted-foreground">全部在页面完成，无需命令行；数据仍写入事件日志</span>
          {canWrite && (
            <a
              href="/api/export"
              download="blackboard.html"
              className="ml-auto inline-flex h-7 items-center rounded-md border bg-card px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-strong hover:text-foreground"
            >
              导出单文件 HTML
            </a>
          )}
        </header>

        <div className="flex gap-1 border-b px-3 py-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => { setTab(item.id); setError(null); setNotice(null); }}
              aria-pressed={tab === item.id}
              className={`h-7 rounded-md px-2.5 text-[12px] transition-colors ${tab === item.id ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="px-4 py-3">
          <p className="m-0 mb-3 text-[11px] text-muted-foreground">{TABS.find((item) => item.id === tab)?.hint}</p>

          {tab === 'source' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">PoC 地址 / 本地路径</span>
                <input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="https://github.com/acme/poc.git 或 /Users/you/poc.zip"
                  className="h-9 rounded-md border bg-card px-2.5 font-mono text-[12px] outline-none focus-visible:border-strong"
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">保存目录名（可选，默认按仓库/压缩包名）</span>
                <input
                  value={dest}
                  onChange={(event) => setDest(event.target.value)}
                  placeholder="poc-android"
                  className="h-9 rounded-md border bg-card px-2.5 font-mono text-[12px] outline-none focus-visible:border-strong"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={importSource} disabled={busy || !canWrite}>导入源码</Button>
                <label className="inline-flex h-8 cursor-pointer items-center rounded-md border bg-card px-2.5 text-[12px] hover:border-strong">
                  上传 zip / tar.gz
                  <input type="file" accept=".zip,.tar.gz,.tgz" className="hidden" disabled={busy || !canWrite}
                    onChange={(event) => { uploadArchive(event.target.files?.[0] || null); event.target.value = ''; }} />
                </label>
                {busy && <span className="text-[11px] text-muted-foreground">正在下载/解压并解析…</span>}
              </div>
              <p className="m-0 text-[11px] leading-5 text-muted-foreground">
                源码会放在 <code className="font-mono">.flow/sources/</code>（默认不进版本库），不会执行。导入后可继续在「角色 / 攻击链 / 讲解」里编辑。
              </p>
            </div>
          )}

          {tab === 'roles' && (
            <div className="flex flex-col gap-2">
              <textarea
                value={rolesText}
                onChange={(event) => setRolesText(event.target.value)}
                rows={14}
                spellCheck={false}
                className="w-full resize-y rounded-md border bg-card p-2.5 font-mono text-[11.5px] leading-5 outline-none focus-visible:border-strong"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveRoles} disabled={busy || !canWrite}>保存函数作用</Button>
                <Button size="sm" variant="outline" disabled={busy || !canWrite}
                  onClick={() => {
                    setRolesText(JSON.stringify(Object.fromEntries(units.slice(0, 8).map((unit) => [unitRef(unit, duplicates), unit.role || ''])), null, 2));
                  }}>
                  生成模板（前 8 个）
                </Button>
                <span className="text-[11px] text-muted-foreground">共 {units.length} 个函数，已有 {units.filter((unit) => unit.role).length} 个作用</span>
              </div>
            </div>
          )}

          {tab === 'chain' && (
            <div className="flex flex-col gap-2">
              <textarea
                value={chainText}
                onChange={(event) => setChainText(event.target.value)}
                rows={16}
                spellCheck={false}
                className="w-full resize-y rounded-md border bg-card p-2.5 font-mono text-[11.5px] leading-5 outline-none focus-visible:border-strong"
              />
              <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <input type="checkbox" checked={replaceChain} onChange={(event) => setReplaceChain(event.target.checked)} />
                替换现有攻击链（旧的阶段会标记 removed）
              </label>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveChain} disabled={busy || !canWrite}>保存攻击链</Button>
                <Button size="sm" variant="outline" disabled={busy || !canWrite} onClick={() => setChainText(stageJson)}>恢复当前链</Button>
              </div>
            </div>
          )}

          {tab === 'lesson' && (
            <div className="flex flex-col gap-2">
              <textarea
                value={lessonText}
                onChange={(event) => setLessonText(event.target.value)}
                rows={14}
                spellCheck={false}
                placeholder='{ "schema": "blackboard.lesson.v1", "level": "unit", "title": "…", "target": { "unit": "u12" } }'
                className="w-full resize-y rounded-md border bg-card p-2.5 font-mono text-[11.5px] leading-5 outline-none focus-visible:border-strong"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={saveLesson} disabled={busy || !canWrite || !lessonText.trim()}>导入讲解</Button>
                <label className="inline-flex h-8 cursor-pointer items-center rounded-md border bg-card px-2.5 text-[12px] hover:border-strong">
                  读取 lesson.json
                  <input type="file" accept=".json,application/json" className="hidden" disabled={busy || !canWrite}
                    onChange={(event) => { uploadLesson(event.target.files?.[0] || null); event.target.value = ''; }} />
                </label>
              </div>
            </div>
          )}

          {error && <p className="m-0 mt-3 rounded-md border border-destructive/30 bg-danger-soft px-2.5 py-1.5 text-[12px] text-destructive">{error}</p>}
          {notice && <p className="m-0 mt-3 rounded-md border border-live/30 bg-live/5 px-2.5 py-1.5 text-[12px] text-live">{notice}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
