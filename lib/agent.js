// Agent runtime adapters for the in-page chat.
//
// Three families:
//   - openai:  any OpenAI-compatible /chat/completions streaming endpoint
//   - cli:     a local agent CLI run through a configurable command template
//   - external: no server-side model; the page only queues questions (legacy)
//
// Secrets stay on the server: they live in .flow/agent.json (0600) and are never
// sent to the browser. Streaming is exposed to lib/server.js through callbacks.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './store.js';

export const RUNTIMES = ['external', 'openai', 'cli'];

const DEFAULT_SYSTEM = [
  '你是一个内核/PoC 代码教学助手，正在通过 blackboard 的网页与学生对话。',
  '回答要围绕当前函数、代码行和利用链；先给结论，再解释关键行。',
  '不要编造不存在的代码、行号或漏洞；不确定时明确说不确定。',
  '学生用中文提问时用中文回答。',
].join('\n');

export function defaultAgentConfig() {
  return {
    runtime: 'external',
    api: {
      baseUrl: 'https://api.openai.com/v1',
      model: '',
      apiKey: '',
      systemPrompt: DEFAULT_SYSTEM,
      temperature: 0.2,
      maxTokens: 2000,
    },
    cli: {
      commandLine: 'claude -p {prompt} --output-format stream-json --verbose --include-partial-messages',
      preset: 'claude',
      timeoutMs: 1800000,
    },
  };
}

export const CLI_PRESETS = {
  claude: 'claude -p {prompt} --output-format stream-json --verbose --include-partial-messages',
  codex: 'codex exec --json {prompt}',
  pi: 'pi -p --mode json --thinking high --no-session {prompt}',
  custom: '',
};

function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = merge(base[key] || {}, value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

export function agentConfigPath(cwd) {
  return path.join(paths(cwd).root, 'agent.json');
}

export function loadAgentConfig(cwd) {
  const file = agentConfigPath(cwd);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return merge(defaultAgentConfig(), raw);
  } catch {
    return defaultAgentConfig();
  }
}

export function publicAgentConfig(cwd) {
  const config = loadAgentConfig(cwd);
  return {
    ...config,
    api: { ...config.api, apiKey: '', hasApiKey: Boolean(config.api.apiKey) },
  };
}

export function saveAgentConfig(cwd, patch) {
  const current = loadAgentConfig(cwd);
  const next = merge(current, patch);
  // A redacted/masked key from the settings form must not wipe the stored key.
  if (patch?.api?.apiKey === undefined || patch?.api?.apiKey === '') next.api.apiKey = current.api.apiKey;
  if (patch?.cli?.preset && CLI_PRESETS[patch.cli.preset] !== undefined && !patch?.cli?.commandLine) {
    next.cli.commandLine = CLI_PRESETS[patch.cli.preset];
  }
  const file = agentConfigPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return publicAgentConfig(cwd);
}

export function isConfigured(config) {
  if (config.runtime === 'openai') return Boolean(config.api.model && config.api.baseUrl);
  if (config.runtime === 'cli') return Boolean(config.cli.commandLine && config.cli.commandLine.includes('{prompt}'));
  return true;
}

/** Prompt handed to any runtime. Keep it explicit; the model may ignore it. */
export function buildAgentPrompt({ question, boardContext, history = [] }) {
  const lines = [];
  if (boardContext) {
    lines.push('## 黑板现场（只读上下文）', boardContext, '');
  }
  const recent = history.slice(-6).filter((item) => item?.text);
  if (recent.length) {
    lines.push('## 最近对话');
    for (const item of recent) lines.push(`- ${item.role === 'student' ? '学生' : 'Agent'}：${String(item.text).slice(0, 1200)}`);
    lines.push('');
  }
  lines.push('## 学生问题', question);
  return lines.join('\n');
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** Heuristic JSONL parser shared by CLI adapters. */
export function createJsonlParser(onEvent) {
  let buffer = '';
  let text = '';
  let thinking = '';
  let sawStreamText = false;
  let sawStreamThinking = false;
  const tools = [];

  const emitText = (value) => {
    const chunk = String(value ?? '');
    if (!chunk) return;
    text += chunk;
    onEvent({ type: 'text', delta: chunk });
  };
  const emitThinking = (value) => {
    const chunk = String(value ?? '');
    if (!chunk) return;
    thinking += chunk;
    onEvent({ type: 'thinking', delta: chunk });
  };
  const emitTool = (name, detail) => {
    const item = { name: String(name || 'tool'), detail: String(detail || '').slice(0, 1200) };
    tools.push(item);
    onEvent({ type: 'tool', ...item });
  };

  const extract = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 6) return;
    if (Array.isArray(obj)) { for (const item of obj) extract(item, depth + 1); return; }

    // Pi (and compatible) JSON mode: message_update.assistantMessageEvent
    if (obj.type === 'message_update' && obj.assistantMessageEvent) {
      const event = obj.assistantMessageEvent;
      if (event.type === 'text_delta') { sawStreamText = true; emitText(event.delta); }
      else if (event.type === 'thinking_delta') { sawStreamThinking = true; emitThinking(event.delta); }
      else if (event.type === 'toolcall_start') emitTool(event.toolName || event.toolName, JSON.stringify(event));
      else if (event.type === 'toolcall_end') emitTool(event.toolName, event.arguments ? JSON.stringify(event.arguments) : '');
      return;
    }
    if (obj.type === 'message_end' && obj.message?.role === 'assistant' && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && !sawStreamText) emitText(block.text);
        else if (block.type === 'thinking') emitThinking(block.thinking || block.text);
        else if (block.type === 'toolCall' || block.type === 'tool_use') emitTool(block.name || block.toolName, JSON.stringify(block.arguments || block.input || {}));
      }
      return;
    }

    // Claude Code stream-json
    if (obj.type === 'stream_event') {
      const event = obj.event || {};
      const delta = event.delta || {};
      if (delta.type === 'text_delta') { sawStreamText = true; emitText(delta.text); }
      else if (delta.type === 'thinking_delta') { sawStreamThinking = true; emitThinking(delta.thinking || delta.text); }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        emitTool(event.content_block.name, JSON.stringify(event.content_block.input || {}));
      }
      return;
    }
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && !sawStreamText) emitText(block.text);
        else if (block.type === 'thinking' && !sawStreamThinking) emitThinking(block.thinking);
        else if (block.type === 'tool_use') emitTool(block.name, JSON.stringify(block.input || {}));
      }
      return;
    }
    if (obj.type === 'result' && typeof obj.result === 'string' && !text) emitText(obj.result);

    // tool / function calls (various CLIs)
    if (['tool_use', 'tool_call', 'function_call'].includes(obj.type)) {
      emitTool(obj.name || obj.tool || obj.function?.name, JSON.stringify(obj.input || obj.arguments || {}));
    }
    if (obj.type === 'tool_result' && typeof obj.content === 'string') {
      // Keep tool output out of the answer text; it is noise for the student.
      return;
    }

    // OpenAI-ish / generic fields
    if (typeof obj.reasoning_content === 'string') emitThinking(obj.reasoning_content);
    if (typeof obj.reasoning === 'string') emitThinking(obj.reasoning);
    if (typeof obj.thinking === 'string') emitThinking(obj.thinking);
    if (typeof obj.text === 'string') emitText(obj.text);
    else if (typeof obj.content === 'string' && !obj.tool && !obj.tool_call) emitText(obj.content);
  };

  return {
    feed(chunk) {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        if (line.startsWith('{') || line.startsWith('[')) {
          try { extract(JSON.parse(line)); continue; } catch { /* fall through to text */ }
        }
        // Pi in JSON mode normally emits JSON events; if a tool call leaks out
        // as text, keep it in the collapsed tool section instead of the answer.
        const toolLine = /^(tool|bash|read|write|edit|grep|rg|ls|cat|node|cd)\s+(\{.*\})$/.exec(line);
        if (toolLine) {
          try {
            const payload = JSON.parse(toolLine[2]);
            emitTool(payload.toolName || payload.name || toolLine[1], payload.command || payload.input || toolLine[2]);
            continue;
          } catch { /* not JSON; fall through */ }
        }
        emitText(`${line}\n`);
      }
    },
    flush() {
      const line = buffer.trim();
      buffer = '';
      if (!line) return;
      try { extract(JSON.parse(line)); } catch { emitText(line); }
    },
    result() { return { text, thinking, tools }; },
  };
}

/** Spawn a local agent CLI; stop kills its process group. */
export function runCli(config, prompt, { cwd, signal, onEvent }) {
  return new Promise((resolve, reject) => {
    const template = config.cli.commandLine;
    if (!template.includes('{prompt}')) return reject(new Error('CLI commandLine must contain {prompt}'));
    const line = template.replace(/\{prompt\}/g, shellQuote(prompt));
    const parser = createJsonlParser(onEvent);
    const child = spawn('/bin/sh', ['-lc', line], {
      cwd,
      detached: true,
      env: { ...process.env, BLACKBOARD_CWD: cwd, FLOW_CWD: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let timer = null;

    const kill = () => {
      if (finished) return;
      finished = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ } }, 1500);
    };

    if (signal) {
      if (signal.aborted) { kill(); reject(new Error('aborted')); return; }
      signal.addEventListener('abort', kill, { once: true });
    }
    const limit = Math.max(20 * 60 * 1000, Number(config.cli.timeoutMs || 0));
    timer = setTimeout(() => { timedOut = true; kill(); }, limit);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => parser.feed(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.on('error', (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      parser.flush();
      const result = parser.result();
      if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { partial: result }));
      if (timedOut) return reject(Object.assign(new Error('agent timeout'), { partial: result }));
      if (code !== 0 && !result.text) return reject(Object.assign(new Error(stderr.trim().split('\n').slice(-3).join(' ' ) || `CLI exited ${code}`), { partial: result }));
      resolve({ ...result, code, stderr, kill });
    });
  });
}

/** OpenAI-compatible streaming endpoint. */
export async function runOpenAI(config, { messages, signal, onEvent }) {
  const base = String(config.api.baseUrl || '').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (config.api.apiKey) headers.authorization = `Bearer ${config.api.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: config.api.model,
      stream: true,
      temperature: Number(config.api.temperature ?? 0.2),
      max_tokens: Number(config.api.maxTokens ?? 2000),
      messages,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`model HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  if (!response.body) throw new Error('model response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let thinking = '';
  const tools = [];
  let done = false;
  while (!done) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { done = true; break; }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          onEvent({ type: 'text', delta: delta.content });
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          thinking += reasoning;
          onEvent({ type: 'thinking', delta: reasoning });
        }
        for (const tool of delta.tool_calls || []) {
          const item = { name: tool.function?.name || 'tool', detail: tool.function?.arguments || '' };
          tools.push(item);
          onEvent({ type: 'tool', ...item });
        }
      } catch { /* ignore malformed SSE line */ }
    }
  }
  return { text, thinking, tools };
}

/**
 * Run one chat turn through the configured runtime.
 * `signal` aborts API requests; CLI processes are killed by the caller's signal.
 * For CLI the returned promise has a `.kill` property.
 */
export function runAgent(config, { prompt, messages, cwd, signal, onEvent }) {
  if (!isConfigured(config)) throw new Error('agent runtime is not configured');
  if (config.runtime === 'cli') return runCli(config, prompt, { cwd, signal, onEvent });
  if (config.runtime === 'openai') return runOpenAI(config, { messages, signal, onEvent });
  throw new Error('the external runtime does not stream replies; use /api/request');
}
