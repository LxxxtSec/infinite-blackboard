import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSource, suggestChain, maskSource, languageOf } from '../lib/code.js';
import { importCode } from '../lib/importer.js';
import {
  addFile, addLesson, addRequest, replyRequest, ensure, replay, stats, readCodeFile,
  resolveCodePath, upsertUnits, setLearned, setUnitRoles, addChain,
} from '../lib/store.js';
import { emptyGraph, apply, unitsOf, orderedStages, NODE_TYPES, EDGE_KINDS } from '../lib/model.js';
import { validateLesson, coverage, lessonStaleFiles, teachingUnits, lineNoteIndex } from '../lib/teach.js';
import { buildDigest } from '../lib/digest.js';
import { buildAgentContext } from '../lib/context.js';
import { lintGraph } from '../lib/lint.js';
import { renderExport } from '../lib/export.js';
import { startServer } from '../lib/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'flow.js');
const EXAMPLE = path.resolve(HERE, '..', 'examples', 'kernel-lpe-demo');

const EXPLOIT = `#define BUF 64
struct demo { int a; int b; };

static int helper(int x)
{
    return x + 1;
}

static void leak_ptr(void)
{
    helper(1);
    printf("leak\\n");
}
`;

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-teaching-'));
  ensure(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'demo.c'), EXPLOIT);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function board(t) {
  const dir = project(t);
  const result = importCode(dir, path.join(dir, 'src', 'demo.c'));
  assert.equal(result.files.length, 1);
  return { dir, result };
}

test('C parser extracts macros, structs, functions, calls and tags', () => {
  const parsed = parseSource(EXPLOIT, { path: 'src/demo.c' });
  assert.equal(parsed.lang, 'c');
  assert.equal(parsed.lines, 14);
  const kinds = parsed.units.map((unit) => unit.kind);
  assert.ok(kinds.includes('macro'));
  assert.ok(kinds.includes('struct'));
  assert.ok(kinds.includes('function'));

  const helper = parsed.units.find((unit) => unit.symbol === 'helper');
  assert.equal(helper.kind, 'function');
  assert.equal(helper.startLine, 4);
  assert.equal(helper.endLine, 7);
  assert.deepEqual(helper.calls, []); // no call inside helper

  const leak = parsed.units.find((unit) => unit.symbol === 'leak_ptr');
  assert.ok(leak.tags.includes('leak'));
  assert.ok(leak.calls.includes('helper'));
  assert.ok(leak.calls.includes('printf'));
});

test('parser is line-accurate after comments and strings, and masks them', () => {
  const src = [
    '/* a { brace in a comment */',
    'const char *s = "a { brace in a string";',
    'static void f(void) {',
    '    // closing brace in a comment }',
    '    puts("x");',
    '}',
  ].join('\n');
  const masked = maskSource(src);
  assert.ok(!masked.includes('brace in a comment'));
  const parsed = parseSource(src, { path: 'x.c' });
  const f = parsed.units.find((unit) => unit.symbol === 'f');
  assert.ok(f);
  assert.equal(f.startLine, 3);
  assert.equal(f.endLine, 6);
});

test('non-C languages fall back to one file unit and keep the language', () => {
  assert.equal(languageOf('a.py'), 'python');
  const parsed = parseSource('def f():\n    return 1\n', { path: 'a.py' });
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].kind, 'file');
  assert.equal(parsed.units[0].startLine, 1);
  assert.equal(parsed.units[0].endLine, 3);
});

test('stage suggestion is heuristic but ordered by the exploit lifecycle', () => {
  const parsed = parseSource(EXPLOIT, { path: 'src/demo.c' });
  const chain = suggestChain(parsed.units);
  const phases = chain.map((stage) => stage.phase);
  assert.ok(phases.includes('leak'));
  for (let i = 1; i < phases.length; i += 1) {
    assert.ok(['entry', 'surface', 'trigger', 'primitive', 'leak', 'spray', 'overwrite', 'bypass', 'escalate', 'impact', 'cleanup'].indexOf(phases[i - 1])
      < ['entry', 'surface', 'trigger', 'primitive', 'leak', 'spray', 'overwrite', 'bypass', 'escalate', 'impact', 'cleanup'].indexOf(phases[i]));
  }
});

test('import creates file records, unit nodes and call edges, and is idempotent', (t) => {
  const { dir, result } = board(t);
  assert.equal(result.files[0].created, 4);
  const g = replay(dir);
  assert.equal(Object.keys(g.files).length, 1);
  assert.ok(unitsOf(g).length >= 4);
  const calls = Object.values(g.edges).filter((edge) => edge.kind === 'calls');
  assert.ok(calls.length >= 1);

  const again = importCode(dir, path.join(dir, 'src', 'demo.c'));
  assert.equal(again.files[0].created, 0);
  assert.equal(again.files[0].updated, 0);
  const after = replay(dir);
  assert.equal(unitsOf(after).length, unitsOf(g).length);
  assert.equal(Object.keys(after.edges).length, Object.keys(g.edges).length);
});

test('re-import marks vanished units removed and patches moved ones', (t) => {
  const { dir } = board(t);
  const before = unitsOf(replay(dir)).find((unit) => unit.symbol === 'helper');
  const source = fs.readFileSync(path.join(dir, 'src', 'demo.c'), 'utf8')
    .replace('static int helper(int x)\n{\n    return x + 1;\n}', '// helper removed\n')
    .replace('static void leak_ptr(void)', 'static void leak_ptr(void) /* moved */');
  fs.writeFileSync(path.join(dir, 'src', 'demo.c'), source);
  importCode(dir, path.join(dir, 'src', 'demo.c'));
  const g = replay(dir);
  assert.equal(g.nodes[before.id].status, 'removed');
  assert.ok(unitsOf(g).some((unit) => unit.symbol === 'leak_ptr'));
});

test('file records keep #include lists for file dependency views', (t) => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'src', 'with_include.c'), '#include "demo.c"\n#include <stdio.h>\n\nstatic void f(void) {}\n');
  importCode(dir, path.join(dir, 'src', 'with_include.c'));
  const file = replay(dir).files['src/with_include.c'];
  assert.deepEqual(file.includes, ['demo.c', 'stdio.h']);
});

test('import refuses code outside the board root', (t) => {
  const dir = project(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-outside-'));
  fs.writeFileSync(path.join(outside, 'evil.c'), 'static void f(void){}\n');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const result = importCode(dir, path.join(outside, 'evil.c'));
  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /outside board root/);
});

test('lesson validation binds to imported files and rejects bad anchors', (t) => {
  const { dir } = board(t);
  const g = replay(dir);
  const unit = unitsOf(g).find((item) => item.symbol === 'leak_ptr');

  const ok = validateLesson(g, {
    title: '逐行读 leak_ptr',
    level: 'line',
    target: { unit: unit.id },
    sections: [{ heading: '说明', body: 'body' }],
    lineNotes: [{ file: 'src/demo.c', line: 12, kind: 'key', note: '读指针' }],
  });
  assert.deepEqual(ok.errors, []);

  const missingFile = validateLesson(g, {
    title: 'x', level: 'line', target: { file: 'nope.c', lines: [{ start: 1, end: 2 }] },
  });
  assert.ok(missingFile.errors.some((message) => message.includes('not imported')));

  const outOfRange = validateLesson(g, {
    title: 'x', level: 'line', target: { file: 'src/demo.c', lines: [{ start: 1, end: 9999 }] },
  });
  assert.ok(outOfRange.errors.some((message) => message.includes('past end of file')));

  const unknownUnit = validateLesson(g, { title: 'x', unit: 'nope', target: { unit: 'u999' } });
  assert.ok(unknownUnit.errors.some((message) => message.includes('does not exist')));

  assert.throws(() => validateLesson(g, { level: 'line' }), /title is required/);
});

test('lessons are stored with code hashes and can cover units by line range', (t) => {
  const { dir } = board(t);
  const g = replay(dir);
  const unit = unitsOf(g).find((item) => item.symbol === 'leak_ptr');
  const { lesson } = addLesson({
    title: 'leak_ptr 逐行',
    level: 'line',
    target: { file: 'src/demo.c', lines: [{ start: unit.startLine, end: unit.endLine }] },
    lineNotes: [{ file: 'src/demo.c', line: unit.startLine + 1, kind: 'note', note: '进入函数' }],
  }, dir);
  assert.match(lesson.id, /^ls\d+$/);
  assert.ok(lesson.codeHashes['src/demo.c']);

  const cov = coverage(replay(dir));
  assert.equal(cov.units.total, teachingUnits(replay(dir)).length);
  assert.ok(cov.units.covered >= 1);
  assert.ok(cov.lessons.lineNotes >= 1);
  assert.equal(cov.lessons.stale, 0);

  const notes = lineNoteIndex(replay(dir)).get('src/demo.c');
  assert.equal(notes.get(unit.startLine + 1)[0].lessonId, lesson.id);
});

test('changed code makes a lesson stale without deleting it', (t) => {
  const { dir } = board(t);
  const g = replay(dir);
  const unit = unitsOf(g).find((item) => item.symbol === 'leak_ptr');
  addLesson({
    title: 'x', level: 'unit', target: { unit: unit.id },
  }, dir);
  fs.appendFileSync(path.join(dir, 'src', 'demo.c'), '\n// edited\n');
  importCode(dir, path.join(dir, 'src', 'demo.c'));
  const after = replay(dir);
  const lesson = Object.values(after.lessons)[0];
  assert.deepEqual(lessonStaleFiles(after, lesson), ['src/demo.c']);
  assert.equal(coverage(after).lessons.stale, 1);
  const lint = lintGraph(after);
  assert.ok(lint.issues.some((issue) => issue.code === 'stale-lessons'));
});

test('description digest and context only grow on teaching boards', (t) => {
  const { dir } = board(t);
  const g = replay(dir);
  const unit = unitsOf(g).find((item) => item.symbol === 'leak_ptr');
  addLesson({
    title: '大局', level: 'overview', target: { board: true },
  }, dir);
  addRequest({ question: '这里为什么要泄露？', unitId: unit.id }, dir);

  const digest = buildDigest(replay(dir), dir);
  assert.match(digest, /## 代码与教学/);
  assert.match(digest, /## 待答提问/);

  const packet = buildAgentContext(replay(dir), {
    focus: unit.id,
    budgetTokens: 8000,
    readCode: (file, start, end) => readCodeFile(dir, file, { start, end }),
  });
  assert.equal(packet.schema, 'blackboard.context.v1');
  assert.equal(packet.policy.readOnly, true);
  assert.ok(packet.teaching);
  assert.equal(packet.teaching.focusUnit.symbol, 'leak_ptr');
  assert.ok(packet.teaching.focusCode.slice.length >= 1);
  assert.equal(packet.teaching.openRequests.length, 1);

  // A pentest board (no code) keeps the old shape: teaching stays null and the
  // digest has no teaching sections.
  const plain = emptyGraph();
  plain.nodes.g1 = { id: 'g1', type: 'goal', title: '授权边界', ts: 1 };
  plain.meta.focus = 'g1';
  const plainPacket = buildAgentContext(plain, { budgetTokens: 2000 });
  assert.equal(plainPacket.teaching, null);
  assert.doesNotMatch(buildDigest(plain, dir), /## 代码与教学/);
});

test('requests are answered with replies and drop out of the open queue', (t) => {
  const { dir } = board(t);
  const request = addRequest({ question: '竞态窗口在哪？', file: 'src/demo.c', startLine: 10 }, dir);
  assert.match(request.id, /^rq\d+$/);
  assert.equal(coverage(replay(dir)).requests.open, 1);
  const reply = replyRequest(request.id, { text: '在锁外的引用生命周期里。' }, dir);
  assert.match(reply.id, /^rp\d+$/);
  const cov = coverage(replay(dir));
  assert.equal(cov.requests.open, 0);
  assert.equal(cov.requests.answered, 1);
});

test('teaching metadata repalys through events and reset clears it', () => {
  const g = apply(emptyGraph(), { op: 'file', file: { path: 'a.c', lang: 'c', hash: 'h', lines: 10 } });
  assert.equal(g.files['a.c'].lines, 10);
  apply(g, { op: 'lesson', lesson: { id: 'ls1', title: 'x', level: 'unit', target: {}, sections: [], lineNotes: [], concepts: [], exercises: [], prerequisites: [], codeHashes: {} } });
  apply(g, { op: 'request', request: { id: 'rq1', question: 'q', status: 'open' } });
  apply(g, { op: 'reply', reply: { id: 'rp1', requestId: 'rq1', text: 'a' } });
  assert.equal(Object.keys(g.lessons).length, 1);
  assert.equal(Object.keys(g.replies).length, 1);
  const reset = apply(g, { op: 'reset' });
  assert.deepEqual(Object.keys(reset.files), []);
  assert.deepEqual(Object.keys(reset.lessons), []);
});

test('new vocabulary is additive: old node and edge kinds remain valid', () => {
  for (const kind of ['goal', 'finding', 'vuln', 'note']) assert.ok(NODE_TYPES.includes(kind));
  for (const kind of ['supports', 'derived-from', 'related-to']) assert.ok(EDGE_KINDS.includes(kind));
  for (const kind of ['calls', 'implements', 'step-before']) assert.ok(EDGE_KINDS.includes(kind));
});

test('orderedStages follows explicit step-before edges', () => {
  const g = emptyGraph();
  g.nodes.st2 = { id: 'st2', type: 'stage', title: 'B', ts: 2 };
  g.nodes.st1 = { id: 'st1', type: 'stage', title: 'A', ts: 1 };
  g.nodes.st3 = { id: 'st3', type: 'stage', title: 'C', ts: 3 };
  g.edges['st1->st2:step-before'] = { id: 'st1->st2:step-before', from: 'st1', to: 'st2', kind: 'step-before' };
  g.edges['st2->st3:step-before'] = { id: 'st2->st3:step-before', from: 'st2', to: 'st3', kind: 'step-before' };
  assert.deepEqual(orderedStages(g).map((stage) => stage.id), ['st1', 'st2', 'st3']);
});

test('code reads stay inside the board root', (t) => {
  const dir = project(t);
  assert.throws(() => resolveCodePath(dir, '../etc/passwd'), /escapes board root/);
  const slice = readCodeFile(dir, 'src/demo.c', { start: 1, end: 2 });
  assert.equal(slice.slice[0].line, 1);
  assert.equal(slice.slice.length, 2);
  assert.equal(readCodeFile(dir, 'nope.c'), null);
});

test('export embeds teaching code and lessons but still strips raw activity', (t) => {
  const { dir } = board(t);
  const unit = unitsOf(replay(dir)).find((item) => item.symbol === 'leak_ptr');
  addLesson({ title: '讲解', level: 'unit', target: { unit: unit.id } }, dir);
  const html = renderExport({ cwd: dir });
  assert.match(html, /<title>/, 'title present');
  const match = html.match(/window\.__BLACKBOARD_DATA__ = ([\s\S]*?);\ntry \{/);
  assert.ok(match, 'snapshot embedded');
  const snap = JSON.parse(match[1].replace(/\\u003c/g, '<'));
  assert.ok(snap.code['src/demo.c'].content.join('\n').includes('leak_ptr'));
  assert.equal(Object.keys(snap.lessons).length, 1);
  assert.equal(Object.keys(snap.files).length, 1);
  assert.deepEqual(snap.activities, {});
});

test('learned progress is stored, counted and exposed to the Agent', (t) => {
  const { dir } = board(t);
  const unit = unitsOf(replay(dir)).find((item) => item.symbol === 'leak_ptr');
  const marked = setLearned(unit.id, true, dir);
  assert.equal(marked.learned, true);
  const g = replay(dir);
  assert.equal(g.nodes[unit.id].learned, true);
  assert.equal(stats(g).learned, 1);
  assert.match(buildDigest(g, dir), /学完 1\//);
  const packet = buildAgentContext(g, { focus: unit.id });
  assert.equal(packet.teaching.learned, 1);
  assert.equal(packet.teaching.focusUnit.learned, true);
  setLearned(unit.id, false, dir);
  assert.equal(replay(dir).nodes[unit.id].learned, false);
});

test('unit roles can be annotated by symbol or id and reach the Agent context', (t) => {
  const { dir } = board(t);
  const unit = unitsOf(replay(dir)).find((item) => item.symbol === 'helper');
  const updated = setUnitRoles([{ id: 'helper', role: '辅助：给调用者加一' }], dir);
  assert.equal(updated[0].id, unit.id);
  assert.equal(replay(dir).nodes[unit.id].role, '辅助：给调用者加一');
  const packet = buildAgentContext(replay(dir), { focus: unit.id });
  assert.equal(packet.teaching.focusUnit.role, '辅助：给调用者加一');
  setUnitRoles({ [unit.id]: '' }, dir);
  assert.equal(replay(dir).nodes[unit.id].role, '');
});

test('macro annotations carry both a role and a source explanation', (t) => {
  const { dir } = board(t);
  const unit = unitsOf(replay(dir)).find((item) => item.kind === 'macro');
  assert.ok(unit, 'fixture has a macro');
  const [updated] = setUnitRoles([{ id: unit.id, role: '缓冲区大小', detail: '来源：demo.c 顶部，按真实目标调整。' }], dir);
  assert.equal(updated.role, '缓冲区大小');
  assert.equal(updated.detail, '来源：demo.c 顶部，按真实目标调整。');
  const node = replay(dir).nodes[unit.id];
  assert.equal(node.role, '缓冲区大小');
  assert.equal(node.detail, '来源：demo.c 顶部，按真实目标调整。');
});

test('agent-authored chains accept arbitrary titles/phases and replace drafts', (t) => {
  const { dir } = board(t);
  const created = addChain([
    { title: '先看入口', phase: 'kickoff', units: ['leak_ptr'] },
    { title: '再看辅助', phase: 'whatever-the-poc-needs', units: ['helper'] },
  ], {}, dir);
  assert.equal(created.stages.length, 2);
  const g = replay(dir);
  const ordered = orderedStages(g);
  assert.deepEqual(ordered.map((stage) => stage.title), ['先看入口', '再看辅助']);
  assert.ok(Object.values(g.edges).some((edge) => edge.kind === 'implements'
    && edge.from === unitsOf(g).find((unit) => unit.symbol === 'leak_ptr').id));

  const replacement = addChain([{ title: '唯一阶段', phase: 'custom' }], { replace: true }, dir);
  const after = replay(dir);
  assert.equal(orderedStages(after).length, 1);
  assert.equal(orderedStages(after)[0].id, replacement.stages[0].id);
  assert.equal(after.nodes[created.stages[0].id].status, 'removed');
});

test('CLI teaches a project end to end', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(EXAMPLE, dir, { recursive: true });
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });

  run('init', '--title', 'CLI teaching');
  const imported = run('code', 'import', '.');
  assert.match(imported, /已导入 8 个文件/);
  assert.doesNotMatch(imported, /攻击链/);

  // Agent analyses the code, then contributes roles and a PoC-specific chain.
  const annotated = run('annotate', '--file', 'roles.json');
  assert.match(annotated, /已标注/);
  const chained = run('chain', 'import', 'chain.json');
  assert.match(chained, /已写入攻击链 5 个阶段/);
  assert.match(run('chain', 'ls'), /确认攻击面/);
  assert.match(run('learn', 'leak_kernel_pointer'), /已标记学习完毕/);

  run('teach', 'import', 'lesson-overview.json');
  run('teach', 'import', 'lesson-vuln-free.json');
  const coverageText = run('coverage');
  assert.match(coverageText, /覆盖率/);
  assert.match(coverageText, /vuln_demo\.c/);

  run('ask', '为什么先泄露再覆写？', '--file', 'exploit.c', '--lines', '114-120');
  assert.match(run('requests'), /待答/);
  run('reply', 'rq1', '--text', '因为覆写需要知道目标地址。');
  assert.match(run('requests'), /已答/);

  const digest = run('digest');
  assert.match(digest, /## 攻击链/);
  assert.match(digest, /确认攻击面/);
  assert.match(digest, /学完 1\//);
  assert.match(digest, /## 未讲解单元/);

  const context = JSON.parse(run('context', '--budget', '6000'));
  assert.ok(context.teaching);
  assert.ok(context.teaching.chain.length >= 5);

  const lint = run('lint');
  assert.match(lint, /uncovered-units/);
});

test('HTTP: code endpoint and token-guarded student request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(EXAMPLE, dir, { recursive: true });
  ensure(dir);
  importCode(dir, dir);
  const port = 50000 + Math.floor(Math.random() * 5000);
  const server = await startServer({ cwd: dir, port });
  t.after(() => server.close());

  const base = `http://127.0.0.1:${port}`;
  const graph = await (await fetch(`${base}/api/graph`)).json();
  assert.ok(graph.requestToken);
  assert.ok(Object.keys(graph.files).length >= 2);

  const file = await (await fetch(`${base}/api/file?path=exploit.c&start=114&end=118`)).json();
  assert.equal(file.slice[0].line, 114);
  assert.match(file.slice[0].text, /leak_kernel_pointer/);

  const bad = await fetch(`${base}/api/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'no token' }),
  });
  assert.equal(bad.status, 403);

  const ok = await fetch(`${base}/api/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': graph.requestToken },
    body: JSON.stringify({ question: '锁内为什么还会竞态？', unitId: 'u1' }),
  });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.request.status, 'open');

  const unitId = Object.values(graph.nodes).find((node) => node.type === 'unit').id;
  const progress = await fetch(`${base}/api/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': graph.requestToken },
    body: JSON.stringify({ unitId, learned: true }),
  });
  assert.equal(progress.status, 200);
  const progressBody = await progress.json();
  assert.equal(progressBody.unit.learned, true);

  const forbidden = await fetch(`${base}/api/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unitId, learned: false }),
  });
  assert.equal(forbidden.status, 403);

  // Web-first editing: import a local source, annotate, write a chain, add a lesson.
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-web-src-'));
  fs.writeFileSync(path.join(sourceDir, 'pwn.c'), 'static void helper(void){}\nstatic void pwn(void){ helper(); }\n');
  t.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));
  const imported = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': graph.requestToken },
    body: JSON.stringify({ source: sourceDir, dest: 'webpoc' }),
  });
  assert.equal(imported.status, 200);
  const importedBody = await imported.json();
  assert.equal(importedBody.files.length, 1);

  const roles = await fetch(`${base}/api/roles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': graph.requestToken },
    body: JSON.stringify({ roles: { pwn: '入口：调用 helper' } }),
  });
  assert.equal(roles.status, 200);
  assert.equal((await roles.json()).updated.length, 1);

  const chain = await fetch(`${base}/api/chain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': graph.requestToken },
    body: JSON.stringify({ stages: [{ title: 'Web 自定义阶段', phase: 'any-phase', units: ['pwn'] }], replace: true }),
  });
  assert.equal(chain.status, 200);
  assert.equal((await chain.json()).stages.length, 1);

  const graph2 = await (await fetch(`${base}/api/graph`)).json();
  const webUnit = Object.values(graph2.nodes).find((node) => node.type === 'unit' && node.symbol === 'pwn');
  assert.ok(webUnit);
  assert.equal(webUnit.role, '入口：调用 helper');

  const lesson = await fetch(`${base}/api/lesson`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-blackboard-request': graph.requestToken },
    body: JSON.stringify({ lesson: { title: 'Web 讲解', level: 'unit', target: { unit: webUnit.id } } }),
  });
  assert.equal(lesson.status, 200);
  assert.match((await lesson.json()).lesson.id, /^ls/);
});
