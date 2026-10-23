import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  defaultAgentConfig, saveAgentConfig, loadAgentConfig, publicAgentConfig,
  createJsonlParser, runCli, runOpenAI, buildAgentPrompt, quoteCliPrompt, CLI_PRESETS,
} from '../lib/agent.js';
import { ensure, replay, stats } from '../lib/store.js';
import { startServer } from '../lib/server.js';

test('OMP preset is available and uses the non-interactive JSON mode', () => {
  assert.match(CLI_PRESETS.omp, /^omp -p --mode json/);
  assert.match(CLI_PRESETS.omp, /\{prompt\}$/);
});

test('CLI prompt quoting is platform-specific', () => {
  assert.equal(quoteCliPrompt("a'b", 'linux'), "'a'\\''b'");
  assert.equal(quoteCliPrompt("a'b", 'win32'), "'a''b'");
});

function board(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-agent-'));
  ensure(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeCli(t, body) {
  const file = path.join(os.tmpdir(), `agent-cli-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, body);
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

test('agent settings keep the key server-side and preserve it when the form is blank', (t) => {
  const dir = board(t);
  assert.equal(defaultAgentConfig().runtime, 'external');
  const saved = saveAgentConfig(dir, { runtime: 'openai', api: { model: 'test-model', apiKey: 'sk-secret' } });
  assert.equal(saved.runtime, 'openai');
  assert.equal(saved.api.apiKey, '');
  assert.equal(saved.api.hasApiKey, true);
  const loaded = loadAgentConfig(dir);
  assert.equal(loaded.api.apiKey, 'sk-secret');
  saveAgentConfig(dir, { api: { model: 'next-model', apiKey: '' } });
  const again = publicAgentConfig(dir);
  assert.equal(again.api.model, 'next-model');
  assert.equal(again.api.hasApiKey, true);
  assert.equal(loadAgentConfig(dir).api.apiKey, 'sk-secret');
});

test('JSONL parser understands Claude stream events, tools and plain text', () => {
  const events = [];
  const parser = createJsonlParser((event) => events.push(event));
  parser.feed('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先看代码"}}}\n');
  parser.feed('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"答案：UAF"}}}\n');
  parser.feed('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.c"}}]}}\n');
  parser.feed('plain line\n');
  parser.flush();
  const result = parser.result();
  assert.equal(result.thinking, '先看代码');
  assert.ok(result.text.includes('答案：UAF'));
  assert.ok(result.text.includes('plain line'));
  assert.equal(result.tools[0].name, 'Read');
  assert.ok(events.some((event) => event.type === 'thinking'));
  assert.ok(events.some((event) => event.type === 'tool'));
});

test('JSONL parser understands Pi message_update thinking/text/tool events', () => {
  const events = [];
  const parser = createJsonlParser((event) => events.push(event));
  parser.feed('{"type":"message_update","assistantMessageEvent":{"type":"thinking_start"}}\n');
  parser.feed('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"先比较"}}\n');
  parser.feed('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"9.9 更大"}}\n');
  parser.feed('{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","toolName":"read","id":"t1"}}\n');
  parser.flush();
  const result = parser.result();
  assert.equal(result.thinking, '先比较');
  assert.equal(result.text, '9.9 更大');
  assert.equal(result.tools[0].name, 'read');
  assert.ok(events.some((event) => event.type === 'thinking'));
});

test('CLI adapter streams JSONL and passes the prompt', async (t) => {
  const dir = board(t);
  const script = fakeCli(t, `
const prompt = process.argv[2] || '';
console.log(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: '想一想' } } }));
console.log(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '收到：' + prompt.slice(0, 20) } } }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.c' } }] } }));
`);
  const events = [];
  const result = await runCli({
    cli: { commandLine: `${process.execPath} ${script} {prompt}`, timeoutMs: 10_000 },
    api: {},
  }, '你好', { cwd: dir, onEvent: (event) => events.push(event) });
  assert.match(result.text, /收到：你好/);
  assert.equal(result.thinking, '想一想');
  assert.equal(result.tools[0].name, 'Read');
  assert.ok(events.length >= 3);
});

test('stopping a CLI aborts it', async (t) => {
  const dir = board(t);
  const script = fakeCli(t, `
console.log(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '开始' } } }));
setInterval(() => {}, 1000);
`);
  const abort = new AbortController();
  const promise = runCli({
    cli: { commandLine: `${process.execPath} ${script} {prompt}`, timeoutMs: 20_000 },
    api: {},
  }, 'stop me', { cwd: dir, signal: abort.signal, onEvent: () => {} });
  setTimeout(() => abort.abort(), 300);
  await assert.rejects(promise, /aborted/);
});

test('OpenAI-compatible streaming collects text and reasoning', async (t) => {
  const server = http.createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"想一下"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const events = [];
  const result = await runOpenAI({
    api: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: '', temperature: 0, maxTokens: 100 },
  }, { messages: [{ role: 'user', content: 'hi' }], onEvent: (event) => events.push(event) });
  assert.equal(result.text, '你好');
  assert.equal(result.thinking, '想一下');
  assert.ok(events.some((event) => event.type === 'text'));
});

test('prompt carries board context, history and the question', () => {
  const prompt = buildAgentPrompt({
    question: '这里为什么是 UAF？',
    boardContext: '当前选中 u18 · leak_kernel_pointer',
    history: [{ role: 'student', text: '先讲入口' }, { role: 'agent', text: '入口是 main' }],
  });
  assert.match(prompt, /leak_kernel_pointer/);
  assert.match(prompt, /先讲入口/);
  assert.match(prompt, /这里为什么是 UAF/);
});

test('HTTP: settings save, CLI stream, reply persistence and stop endpoint', async (t) => {
  const dir = board(t);
  const script = fakeCli(t, `
const prompt = process.argv[2] || '';
console.log(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '回答：' + prompt.slice(-30) } } }));
`);
  const port = 53000 + Math.floor(Math.random() * 3000);
  const server = await startServer({ cwd: dir, port });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const graph = await (await fetch(`${base}/api/graph`)).json();
  const token = graph.requestToken;

  const saved = await fetch(`${base}/api/agent/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ runtime: 'cli', cli: { commandLine: `${process.execPath} ${script} {prompt}` } }),
  });
  assert.equal(saved.status, 200);
  const settings = await saved.json();
  assert.equal(settings.runtime, 'cli');

  const streamed = await fetch(`${base}/api/agent/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ question: '解释一下 leak_kernel_pointer' }),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type') || '', /text\/event-stream/);
  const text = await streamed.text();
  assert.match(text, /event: start/);
  assert.match(text, /event: text/);
  assert.match(text, /event: done/);
  const g = replay(dir);
  assert.equal(Object.keys(g.requests).length, 1);
  assert.equal(Object.keys(g.replies).length, 1);
  assert.match(Object.values(g.replies)[0].text, /回答：/);

  const missing = await fetch(`${base}/api/agent/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': token },
    body: JSON.stringify({ sessionId: 'nope' }),
  });
  assert.equal(missing.status, 404);
});
