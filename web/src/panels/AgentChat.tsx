import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, MessageSquareText, RotateCcw, Send, Settings2, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/icon-button';
import { Markdown } from '../markdown';
import { formatTime } from '../graph';
import { presentNode } from '../presentation';
import type { BoardNode, GraphSnapshot } from '../types';
import { values } from '../types';

type Props = {
  snapshot: GraphSnapshot;
  selected: BoardNode | null;
  canEdit: boolean;
  width?: number;
  injectedPrompt?: { id: number; text: string } | null;
  onInjected?: () => void;
  onClose: () => void;
  onFocus: (id: string) => void;
};

type AgentConfig = {
  runtime: 'external' | 'openai' | 'cli';
  api: { baseUrl: string; model: string; apiKey: string; hasApiKey?: boolean; systemPrompt: string; temperature: number; maxTokens: number };
  cli: { commandLine: string; preset?: string; timeoutMs: number };
};

type Live = {
  question: string;
  sessionId?: string;
  requestId?: string;
  text: string;
  thinking: string;
  tools: { name: string; detail: string }[];
  status: 'connecting' | 'streaming' | 'done' | 'stopped' | 'error';
  reason?: string;
  error?: string;
};

const CLI_PRESETS: Record<string, string> = {
  claude: 'claude -p {prompt} --output-format stream-json --verbose --include-partial-messages',
  codex: 'codex exec --json {prompt}',
  pi: 'pi -p --mode json --thinking high --no-session {prompt}',
};

export function AgentChat({ snapshot, selected, canEdit, width, injectedPrompt, onInjected, onClose, onFocus }: Props) {
  const nodes = useMemo(() => new Map(values(snapshot.nodes).filter((node) => node.status !== 'removed').map((node) => [node.id, node])), [snapshot]);
  const requests = useMemo(() => values(snapshot.requests).sort((a, b) => Number(a.at || 0) - Number(b.at || 0)), [snapshot]);
  const replies = useMemo(() => values(snapshot.replies).sort((a, b) => Number(a.at || 0) - Number(b.at || 0)), [snapshot]);

  const [settings, setSettings] = useState<AgentConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [question, setQuestion] = useState('');
  const [attach, setAttach] = useState(Boolean(selected?.type === 'unit'));
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stick, setStick] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const injectedRef = useRef<number | null>(null);
  const attachable = selected?.type === 'unit' ? selected : null;

  useEffect(() => { setAttach(Boolean(attachable)); }, [attachable?.id]);
  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    fetch('/api/agent/settings')
      .then((response) => response.json())
      .then((config: AgentConfig) => { if (alive) setSettings(config); })
      .catch(() => { if (alive) setConfigError('读取 Agent 设置失败'); });
    return () => { alive = false; };
  }, [canEdit]);
  useEffect(() => {
    const node = scrollRef.current;
    if (node && stick) node.scrollTop = node.scrollHeight;
  }, [requests.length, replies.length, live?.text, live?.status, stick]);

  const token = snapshot.requestToken;
  const runtime = settings?.runtime || 'external';
  const configured = runtime === 'external'
    || (runtime === 'openai' ? Boolean(settings?.api.model) : Boolean(settings?.cli.commandLine));

  const openRequests = requests.filter((request) => !replies.some((reply) => reply.requestId === request.id)).length;
  const livePersisted = Boolean(live?.requestId && replies.some((reply) => reply.requestId === live.requestId));
  const showLive = Boolean(live) && !livePersisted;

  const stop = async () => {
    if (!live?.sessionId || !token) return;
    setLive((current) => current ? { ...current, status: 'stopped' } : current);
    try {
      await fetch('/api/agent/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
        body: JSON.stringify({ sessionId: live.sessionId }),
      });
    } catch { /* stream teardown is the fallback */ }
    abortRef.current?.abort();
  };

  const send = async (override?: string, forceNoTarget = false, targetOverride?: { unitId?: string; file?: string; startLine?: number | null; endLine?: number | null } | null) => {
    const text = (override ?? question).trim();
    if (!text || !canEdit) return;
    if (!token) { setConfigError('离线导出为只读'); return; }
    const target = targetOverride !== undefined
      ? (targetOverride || undefined)
      : !forceNoTarget && attach && attachable
        ? { unitId: attachable.id, file: attachable.file, startLine: attachable.startLine, endLine: attachable.endLine }
        : undefined;
    const history = requests.slice(-6).flatMap((request) => {
      const answers = replies.filter((reply) => reply.requestId === request.id);
      return [
        { role: 'student', text: request.question },
        ...answers.map((reply) => ({ role: 'agent', text: reply.text })),
      ];
    });

    setSending(true);
    if (!override) setQuestion('');
    setNotice(null);
    setConfigError(null);
    setLive({ question: text, text: '', thinking: '', tools: [], status: 'connecting' });

    if (!settings || settings.runtime === 'external') {
      try {
        const response = await fetch('/api/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
          body: JSON.stringify({ question: text, ...target }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.detail || body.error || `HTTP ${response.status}`);
        setLive(null);
        setNotice('已进入外部 Agent 队列；Agent 用 blackboard requests 读取并 reply。');
      } catch (error) {
        setLive({ question: text, text: '', thinking: '', tools: [], status: 'error', error: error instanceof Error ? error.message : '发送失败' });
      } finally {
        setSending(false);
      }
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const response = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
        body: JSON.stringify({ question: text, ...target, history }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('没有流式响应');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let closed = false;
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const eventLine = frame.split('\n').find((line) => line.startsWith('event:'));
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (!eventLine) continue;
          const event = eventLine.slice(6).trim();
          const payload = dataLine ? JSON.parse(dataLine.slice(5).trim() || '{}') : {};
          setLive((current) => {
            if (!current) return current;
            if (event === 'start') return { ...current, status: 'streaming', sessionId: payload.sessionId, requestId: payload.requestId };
            if (event === 'text') return { ...current, text: current.text + (payload.delta || '') };
            if (event === 'thinking') return { ...current, thinking: current.thinking + (payload.delta || '') };
            if (event === 'tool') return { ...current, tools: [...current.tools, { name: payload.name || 'tool', detail: payload.detail || '' }] };
            if (event === 'done') return { ...current, status: 'done', text: payload.text || current.text };
            if (event === 'stopped') return { ...current, status: 'stopped', text: payload.text || current.text, reason: payload.reason };
            if (event === 'error') return { ...current, status: 'error', error: payload.error || 'Agent 失败' };
            return current;
          });
          if (event === 'done' || event === 'stopped' || event === 'error') closed = true;
        }
      }
      setLive((current) => current && current.status === 'streaming' ? { ...current, status: 'done' } : current);
    } catch (error) {
      if (abort.signal.aborted) setLive((current) => current ? { ...current, status: 'stopped' } : current);
      else setLive((current) => current ? { ...current, status: 'error', error: error instanceof Error ? error.message : '请求失败' } : current);
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  useEffect(() => {
    if (!injectedPrompt || !settings || !canEdit) return;
    if (injectedRef.current === injectedPrompt.id) return;
    injectedRef.current = injectedPrompt.id;
    void send(injectedPrompt.text, true).finally(() => onInjected?.());
  }, [injectedPrompt, settings, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelRequest = async (id: string) => {
    if (!token) return;
    try {
      await fetch('/api/request/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
        body: JSON.stringify({ id }),
      });
    } catch { /* the reply stream will refresh if it did complete */ }
  };

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1600);
    } catch { setCopiedId(null); }
  };

  const regenerate = async (requestId: string) => {
    const request = requests.find((item) => item.id === requestId);
    if (!request || !canEdit || sending || live?.status === 'streaming') return;
    const target = request.unitId || request.file
      ? { unitId: request.unitId || undefined, file: request.file || undefined, startLine: request.startLine, endLine: request.endLine }
      : null;
    await send(request.question, false, target);
  };

  const actions = (id: string, text: string, requestId?: string, system = false) => (
    <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
      <button onClick={() => void copyText(id, text)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground">
        {copiedId === id ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copiedId === id ? '已复制' : '复制'}
      </button>
      {!system && requestId && (
        <button
          onClick={() => void regenerate(requestId)}
          disabled={sending || live?.status === 'streaming'}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={runtime === 'external' ? '外部模式会重新入队，由外部 Agent 回复' : '用同一个问题重新生成'}
        >
          <RotateCcw className="size-3" />重新生成
        </button>
      )}
    </div>
  );

  return (
    <aside aria-label="Agent 对话" style={{ width }} className="flex h-full shrink-0 flex-col border-l bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-float">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
        <MessageSquareText className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium">Agent 对话</span>
        <span className="rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">
          {runtime === 'external' ? '外部轮询' : runtime === 'cli' ? '本地 CLI' : '模型 API'}
        </span>
        {openRequests > 0 && <span className="rounded-full bg-live/10 px-1.5 text-[10px] tabular-nums text-live">待答 {openRequests}</span>}
        {canEdit && <IconButton label="Agent 设置" className="ml-auto" onClick={() => setSettingsOpen(true)}><Settings2 /></IconButton>}
        {!canEdit && <span className="ml-auto" />}
        <IconButton label="收起对话" onClick={onClose}><X /></IconButton>
      </header>

      <div ref={scrollRef} onScroll={(event) => { const el = event.currentTarget; setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!requests.length && !showLive && (
          <div className="rounded-lg border border-dashed bg-secondary/40 p-3 text-[12px] leading-5 text-muted-foreground">
            <p className="m-0 font-medium text-foreground">把 PoC 交给 Agent</p>
            <p className="m-0 mt-1">顶栏「导入」传 zip / 仓库地址；然后点右上角设置选「模型 API」或「本地 CLI」，就能像普通 Agent 一样对话、看思考步骤、随时停止。</p>
            <p className="m-0 mt-2 text-[11px]">默认是外部轮询：问题会写进黑板，由 Claude Code / Codex 用 blackboard requests 读取。</p>
          </div>
        )}

        {requests.filter((request) => !(showLive && request.id === live?.requestId)).map((request) => {
          const target = request.unitId ? nodes.get(request.unitId) : null;
          const answers = replies.filter((reply) => reply.requestId === request.id);
          return (
            <div key={request.id} className="space-y-1.5">
              <div className="flex justify-end">
                <div className="max-w-[92%] rounded-xl rounded-br-sm border bg-secondary/70 px-3 py-2 text-[12.5px] leading-5">
                  {target && (
                    <button onClick={() => onFocus(target.id)} className="mb-1 flex w-full items-center gap-1 text-left text-[10.5px] text-muted-foreground hover:text-foreground" title="定位这个代码单元">
                      <span className="rounded bg-card px-1 font-mono">{target.id}</span>
                      <span className="truncate">{presentNode(target).headline}</span>
                    </button>
                  )}
                  <p className="m-0 whitespace-pre-wrap">{request.question}</p>
                  <span className="mt-1 block text-right text-[10px] text-muted-foreground">{formatTime(Number(request.at || 0))}</span>
                </div>
              </div>
              {!answers.length && (
                <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
                  <i className="size-1.5 animate-pulse rounded-full bg-live" />等待 Agent 回复…
                  <button onClick={() => void cancelRequest(request.id)} className="ml-1 rounded px-1 text-[10.5px] underline-offset-2 hover:text-foreground hover:underline">取消等待</button>
                </div>
              )}
              {answers.map((reply) => (
                <div key={reply.id} className="flex justify-start">
                  <div className="max-w-[95%] rounded-xl rounded-bl-sm border bg-card px-3 py-2 shadow-xs">
                    <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                      <span className="font-medium text-foreground">{reply.author}</span>
                      {reply.runtime && <span>{reply.runtime}</span>}
                      {reply.stopped
                        ? <span className="text-destructive">{reply.stopReason === 'timeout' ? '已超时' : reply.stopReason === 'disconnected' ? '已中断' : '已停止'}</span>
                        : reply.runtime ? <span className="text-live">完成</span> : null}
                      <span>{formatTime(Number(reply.at || 0))}</span>
                    </div>
                    {reply.thinking && <ThinkingBlock text={reply.thinking} />}
                    {reply.tools?.length ? <ToolSteps tools={reply.tools} /> : null}
                    <Markdown text={cleanStreamText(reply.text)} />
                    {actions(reply.id, reply.text, reply.requestId, reply.author === 'system')}
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        {showLive && live && (
          <div className="space-y-1.5">
            <div className="flex justify-end">
              <div className="max-w-[92%] rounded-xl rounded-br-sm border bg-secondary/70 px-3 py-2 text-[12.5px] leading-5">
                <p className="m-0 whitespace-pre-wrap">{live.question}</p>
              </div>
            </div>
            <div className="flex justify-start">
              <div className="w-full max-w-[95%] rounded-xl rounded-bl-sm border bg-card px-3 py-2 shadow-xs">
                <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                  <span className="font-medium text-foreground">Agent</span>
                  <span>{live.status === 'streaming' || live.status === 'connecting' ? '生成中…' : live.status === 'stopped' ? (live.reason === 'timeout' ? '已超时' : live.reason === 'disconnected' ? '已中断' : '已停止') : live.status === 'error' ? '失败' : '完成'}</span>
                </div>
                {live.thinking && <ThinkingBlock text={live.thinking} />}
                {live.tools.length > 0 && <ToolSteps tools={live.tools} />}
                {live.text && <Markdown text={cleanStreamText(live.text)} />}
                {(live.status === 'streaming' || live.status === 'connecting') && !live.text && !live.thinking && (
                  <p className="m-0 flex items-center gap-1.5 text-[11px] text-muted-foreground"><i className="size-1.5 animate-pulse rounded-full bg-live" />思考中…</p>
                )}
                {live.status === 'streaming' && (
                  <div className="mt-2"><Button size="sm" variant="outline" onClick={stop}><Square className="size-3" />停止</Button></div>
                )}
                {live.text && live.status !== 'streaming' && live.status !== 'connecting' && actions('live', live.text, live.requestId)}
                {live.status === 'done' && live.text && (
                  <div className="mt-2 flex items-center gap-1 border-t pt-1.5 text-[10px] text-live">
                    <CheckCircle2 className="size-3" />回复完成
                  </div>
                )}
                {live.status === 'done' && !live.thinking && (
                  <p className="m-0 mt-1 text-[10.5px] leading-4 text-muted-foreground">
                    本次没有思考输出：模型/CLI 没有返回 reasoning。Pi 需要命令里带 <code className="font-mono">--mode json --thinking high</code>，并且模型支持 reasoning（`pi --list-models` 的 thinking 列）。
                  </p>
                )}
                {live.error && <p className="m-0 mt-1 text-[11.5px] text-destructive">{live.error}</p>}
              </div>
            </div>
          </div>
        )}
        {notice && <p className="m-0 rounded-md border border-live/30 bg-live/5 px-2.5 py-1.5 text-[11.5px] text-live">{notice}</p>}
        {configError && <p className="m-0 rounded-md border border-destructive/30 bg-danger-soft px-2.5 py-1.5 text-[11.5px] text-destructive">{configError}</p>}
        {requests.length > 0 && !showLive && openRequests === 0 && (
          <div className="flex items-center gap-2 py-1.5 text-[10.5px] text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <CheckCircle2 className="size-3.5 text-live" />
            <span>对话已全部回复</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        )}
        {!stick && (
          <button
            onClick={() => {
              setStick(true);
              const node = scrollRef.current;
              if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
            }}
            className="sticky bottom-2 ml-auto flex rounded-full border bg-card px-2.5 py-1 text-[10.5px] text-muted-foreground shadow-float hover:border-strong hover:text-foreground"
          >
            回到底部
          </button>
        )}
      </div>

      <div className="shrink-0 border-t p-3">
        {!configured && canEdit && (
          <button onClick={() => setSettingsOpen(true)} className="mb-2 flex w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:border-strong hover:text-foreground">
            <Settings2 className="size-3.5" />当前是外部轮询；点这里配置模型 API 或本地 CLI，获得流式回答 / 停止
          </button>
        )}
        {attach && attachable ? (
          <div className="mb-2 flex items-center gap-1.5 rounded-md border bg-secondary/50 px-2 py-1 text-[11px]">
            <span className="rounded bg-card px-1 font-mono">{attachable.id}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{presentNode(attachable).headline}</span>
            <button onClick={() => setAttach(false)} aria-label="不附带当前函数" className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
          </div>
        ) : null}
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send(); } }}
          rows={3}
          disabled={!canEdit || sending || live?.status === 'streaming'}
          placeholder={canEdit ? '向 Agent 提问，例如：这个函数在整条利用链里负责什么？' : '离线导出为只读，不能提问'}
          className="w-full resize-none rounded-lg border bg-card px-2.5 py-2 text-[12.5px] leading-5 outline-none focus-visible:border-strong disabled:opacity-60"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10.5px] text-muted-foreground">⌘/Ctrl + Enter 发送</span>
          <Button size="sm" className="ml-auto" onClick={() => void send()} disabled={!canEdit || sending || live?.status === 'streaming' || !question.trim()}>
            <Send className="size-3.5" />{sending ? '发送中…' : '发送'}
          </Button>
        </div>
        <p className="m-0 mt-1.5 text-[10px] leading-4 text-muted-foreground">
          {runtime === 'external'
            ? '外部模式：问题写入 blackboard requests，由外部 Agent reply；换会话可恢复。'
            : '回答会写入黑板；密钥只存在本机 .flow/agent.json，不下发浏览器。'}
        </p>
      </div>

      {settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          config={settings}
          onClose={() => setSettingsOpen(false)}
          token={token}
          onSaved={(config) => { setSettings(config); setSettingsOpen(false); setNotice('Agent 设置已保存'); }}
        />
      )}
    </aside>
  );
}

function cleanStreamText(text: string): string {
  return String(text || '').split('\n').filter((line) => {
    const value = line.trim();
    if (!/^(tool|bash|read|write|edit|grep|rg|ls|cat|sed|node|cd)\s+\{/.test(value)) return true;
    // Drop leaked CLI event JSON, but keep ordinary prose that happens to start
    // with a command name.
    return !/"(type|toolName|command|path|input|partial|contentIndex)"/.test(value);
  }).join('\n').trim();
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Some CLIs leak raw tool-call JSON into the reasoning stream; keep it out of
  // the human-readable thought text.
  const shown = cleanStreamText(text) || '（没有可读的思考文本）';
  return (
    <div className="mb-2 rounded-md border bg-secondary/40">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground">
        <span className="min-w-0 flex-1 truncate">思考过程 · {shown.length} 字</span>
        <span className="shrink-0">{open ? '收起' : '展开'}</span>
      </button>
      {open && <pre className="m-0 max-h-48 overflow-y-auto whitespace-pre-wrap border-t px-2 py-1.5 font-mono text-[10.5px] leading-4 text-subtle">{shown}</pre>}
    </div>
  );
}

function ToolSteps({ tools }: { tools: { name: string; detail: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 rounded-md border bg-secondary/30">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground">
        <span className="min-w-0 flex-1 truncate">工具步骤 · {tools.length} 步</span>
        <span className="shrink-0">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <ul className="m-0 flex max-h-48 list-none flex-col gap-1 overflow-y-auto border-t p-2">
          {tools.map((tool, index) => (
            <li key={`${tool.name}-${index}`} className="text-[10.5px] leading-4">
              <span className="font-mono text-foreground">{tool.name}</span>
              {tool.detail && <span className="ml-1 break-all text-muted-foreground">{tool.detail.slice(0, 240)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SettingsDialog({ open, config, onClose, token, onSaved }: {
  open: boolean;
  config: AgentConfig | null;
  onClose: () => void;
  token?: string;
  onSaved: (config: AgentConfig) => void;
}) {
  const [runtime, setRuntime] = useState<AgentConfig['runtime']>(config?.runtime || 'external');
  const [baseUrl, setBaseUrl] = useState(config?.api.baseUrl || '');
  const [model, setModel] = useState(config?.api.model || '');
  const [apiKey, setApiKey] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(config?.api.systemPrompt || '');
  const [commandLine, setCommandLine] = useState(config?.cli.commandLine || '');
  const [preset, setPreset] = useState(config?.cli.preset || 'claude');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !config) return;
    setRuntime(config.runtime);
    setBaseUrl(config.api.baseUrl);
    setModel(config.api.model);
    setApiKey('');
    setSystemPrompt(config.api.systemPrompt);
    setCommandLine(config.cli.commandLine);
    setPreset(config.cli.preset || 'claude');
    setError(null);
  }, [open, config]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!token) { setError('离线导出为只读'); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
        body: JSON.stringify({
          runtime,
          api: { baseUrl, model, apiKey, systemPrompt },
          cli: { commandLine, preset },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
      onSaved(payload);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-[min(560px,100%)] rounded-xl border bg-popover p-0 shadow-float" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <span className="text-[14px] font-semibold">Agent 设置</span>
          <span className="text-[10.5px] text-muted-foreground">密钥只保存在本机 .flow/agent.json</span>
          <IconButton label="关闭设置" className="ml-auto" onClick={onClose}><X /></IconButton>
        </header>
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground">运行方式</span>
            <select value={runtime} onChange={(event) => setRuntime(event.target.value as AgentConfig['runtime'])} className="h-9 rounded-md border bg-card px-2 text-[12px]">
              <option value="external">外部轮询（Claude Code / Codex 用 requests/reply）</option>
              <option value="openai">模型 API（OpenAI 兼容，流式）</option>
              <option value="cli">本地 Agent CLI（Claude / Codex / Pi / 自定义）</option>
            </select>
          </label>

          {runtime === 'openai' && (
            <>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">Base URL</span>
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com/v1" className="h-9 rounded-md border bg-card px-2 font-mono text-[11.5px]" />
              </label>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">模型</span>
                <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-chat / gpt-4o / qwen..." className="h-9 rounded-md border bg-card px-2 font-mono text-[11.5px]" />
              </label>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">API Key {config?.api.hasApiKey ? '（已保存，留空保持不变）' : ''}</span>
                <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config?.api.hasApiKey ? '••••••••' : 'sk-...'} className="h-9 rounded-md border bg-card px-2 font-mono text-[11.5px]" />
              </label>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">System prompt（可选）</span>
                <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={3} className="rounded-md border bg-card p-2 text-[11.5px]" />
              </label>
            </>
          )}

          {runtime === 'cli' && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {(['claude', 'codex', 'pi'] as const).map((item) => (
                  <Button key={item} size="sm" variant="outline" onClick={() => { setPreset(item); setCommandLine(CLI_PRESETS[item]); }}>{item}</Button>
                ))}
              </div>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">命令模板（必须包含 {'{prompt}'}）</span>
                <textarea value={commandLine} onChange={(event) => setCommandLine(event.target.value)} rows={3} spellCheck={false} className="rounded-md border bg-card p-2 font-mono text-[11px]" />
              </label>
              <p className="m-0 text-[10.5px] leading-4 text-muted-foreground">
                通过 <code className="font-mono">/bin/sh -lc</code> 执行；输出按 JSONL 自动解析（Claude stream-json、Pi JSON、Codex JSON、纯文本都兼容）。停止会杀掉进程组。
                <br />Pi 的思考需要 <code className="font-mono">--mode json --thinking high</code>，且模型支持 reasoning；没有思考事件时会明确提示，而不是静默空白。
              </p>
            </>
          )}

          {error && <p className="m-0 rounded-md border border-destructive/30 bg-danger-soft px-2 py-1.5 text-[11.5px] text-destructive">{error}</p>}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t px-4 py-2.5">
          <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </footer>
      </div>
    </div>
  );
}
