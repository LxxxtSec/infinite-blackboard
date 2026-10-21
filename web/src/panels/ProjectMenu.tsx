import { useEffect, useState } from 'react';
import { FolderTree, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/icon-button';
import { formatTime } from '../graph';

type Project = {
  id: string;
  title: string;
  units: number;
  annotated: number;
  stages: number;
  lessons: number;
  status: 'empty' | 'pending' | 'analyzed';
  updatedAt: number;
  active?: boolean;
};

type Response = { enabled: boolean; active?: string; projects: Project[] };

const STATUS = {
  empty: { label: '空', className: 'bg-secondary text-muted-foreground' },
  pending: { label: '待分析', className: 'bg-live/10 text-live' },
  analyzed: { label: '已分析', className: 'bg-secondary text-foreground' },
};

export function ProjectMenu({ token, canEdit }: { token?: string; canEdit: boolean }) {
  const [data, setData] = useState<Response | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = async () => {
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) { setData({ enabled: false, projects: [] }); return; }
      const body = await response.json() as Response;
      setData(body);
    } catch { setData({ enabled: false, projects: [] }); }
  };
  useEffect(() => { void load(); }, []);

  if (!data?.enabled) return null;

  const post = async (url: string, body: object) => {
    if (!token) throw new Error('离线导出为只读');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
    return payload;
  };

  const switchTo = async (id: string) => {
    setBusy(true); setError(null);
    try { await post('/api/projects/switch', { id }); window.location.reload(); }
    catch (switchError) { setError(switchError instanceof Error ? switchError.message : '切换失败'); setBusy(false); }
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try { await post('/api/projects', { name: name.trim() }); window.location.reload(); }
    catch (createError) { setError(createError instanceof Error ? createError.message : '创建失败'); setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setError(null);
    try { await post('/api/projects/delete', { id }); window.location.reload(); }
    catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : '删除失败'); setBusy(false); setConfirmId(null); }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => { setOpen(true); void load(); }} aria-label="项目列表">
        <FolderTree className="size-3.5" /><span className="max-md:hidden">项目</span>
        <span className="tabular-nums text-muted-foreground">{data.projects.length}</span>
      </Button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" onClick={() => setOpen(false)}>
          <div className="w-[min(620px,100%)] rounded-xl border bg-popover p-0 shadow-float" onClick={(event) => event.stopPropagation()}>
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <span className="text-[14px] font-semibold">项目</span>
              <span className="text-[10.5px] text-muted-foreground">每个项目一个独立黑板；新建项目是空的，导入代码后由 Agent 分析</span>
              <IconButton label="关闭项目列表" className="ml-auto" onClick={() => setOpen(false)}><X /></IconButton>
            </header>
            <div className="max-h-[46vh] overflow-y-auto p-2">
              {!data.projects.length && <p className="m-0 px-2 py-6 text-center text-[12px] text-muted-foreground">还没有项目</p>}
              {data.projects.map((project) => {
                const status = STATUS[project.status];
                return (
                  <div key={project.id} className="mb-1">
                    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${project.active ? 'border-strong bg-secondary/50' : 'bg-card'}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[12.5px] font-medium">{project.title}</span>
                        <span className={`shrink-0 rounded-full px-1.5 text-[10px] ${status.className}`}>{status.label}</span>
                        {project.active && <span className="shrink-0 text-[10px] text-muted-foreground">当前</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] text-muted-foreground">
                        <span className="font-mono">{project.id}</span>
                        <span>{project.units} 函数</span>
                        <span>{project.annotated} 已标注</span>
                        <span>{project.stages} 阶段</span>
                        <span>{project.lessons} 讲解</span>
                        {project.updatedAt ? <span>{formatTime(project.updatedAt)}</span> : null}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={busy || project.active || !canEdit} onClick={() => switchTo(project.id)}>
                      {project.active ? '当前' : '切换'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`删除项目 ${project.title}`}
                      title={data.projects.length <= 1 ? '至少保留一个项目' : '删除项目'}
                      disabled={busy || !canEdit || data.projects.length <= 1}
                      onClick={() => setConfirmId(project.id)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                    </div>
                    {confirmId === project.id && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-danger-soft px-3 py-2">
                        <span className="min-w-0 flex-1 text-[11px] leading-5 text-destructive">
                          删除「{project.title}」会移除整个项目目录（源码 + 事件日志 + 讲解），无法恢复。
                          {project.active && data.projects.length > 1 ? ' 当前项目会切换到另一个项目。' : ''}
                        </span>
                        <Button size="sm" variant="outline" onClick={() => setConfirmId(null)}>取消</Button>
                        <Button size="sm" className="bg-destructive text-white hover:bg-destructive/90" disabled={busy} onClick={() => remove(project.id)}>确认删除</Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <footer className="flex items-center gap-2 border-t px-4 py-3">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void create(); }}
                placeholder="新项目名称"
                disabled={!canEdit || busy}
                className="h-9 min-w-0 flex-1 rounded-md border bg-card px-2.5 text-[12px] outline-none focus-visible:border-strong disabled:opacity-60"
              />
              <Button size="sm" onClick={create} disabled={!canEdit || busy || !name.trim()}>
                <Plus className="size-3.5" />新建空项目
              </Button>
            </footer>
            {error && <p className="m-0 border-t px-4 py-2 text-[11.5px] text-destructive">{error}</p>}
          </div>
        </div>
      )}
    </>
  );
}
