// Unit tests for the blackboard plugin's CLI bridge and tool layer.
// They exercise the real CLI against throwaway boards; no DSH runtime needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cleanStderr, cliEnv, parseJson, resolveCli, runBlackboard } from '../lib/cli.js';
import { createBlackboardTools } from '../lib/tools.js';

const cli = resolveCli();
const defineTool = (definition) => definition;
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'blackboard-plugin-'));

function execFor(cwd) {
  return { agent: { session: { meta: { cwd } } } };
}

function toolsFor(cwd, options = {}) {
  const definitions = createBlackboardTools(defineTool, {
    getCli: () => cli,
    resolveCwd: () => cwd,
    ...options,
  });
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

function events(cwd) {
  return readFileSync(path.join(cwd, '.flow', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('resolveCli targets the CLI shipped next to the plugin', () => {
  assert.equal(cli.command, process.execPath);
  assert.equal(cli.prefix.length, 1);
  assert.match(cli.prefix[0], /bin[/\\]blackboard\.js$/);
  assert.ok(existsSync(cli.prefix[0]));
});

test('resolveCli rejects an explicit cliPath that does not exist', () => {
  assert.throws(() => resolveCli('/definitely/not/here/blackboard.js'), /cliPath does not exist/);
});

test('cleanStderr removes ANSI, CLI prefixes and blank lines', () => {
  const raw = '\u001b[31mblackboard:\u001b[0m 当前目录没有 .flow/\n\n提示 注意\n';
  assert.equal(cleanStderr(raw), '当前目录没有 .flow/ 注意');
});

test('parseJson rejects empty and non-JSON stdout', () => {
  assert.throws(() => parseJson(''), /returned no output/);
  assert.throws(() => parseJson('not json'), /non-JSON output/);
});

test('cliEnv strips inherited board pins and keeps output machine-readable', () => {
  const env = cliEnv('/tmp/board', { PATH: '/bin', BLACKBOARD_CWD: '/wrong', FLOW_CWD: '/wrong' });
  assert.equal('BLACKBOARD_CWD' in env, false);
  assert.equal('FLOW_CWD' in env, false);
  assert.equal(env.BLACKBOARD_QUIET, '1');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.PATH, '/bin');
});

test('runBlackboard initializes a board and returns its digest', async () => {
  const cwd = tempDir();
  await runBlackboard(['init', '--title', 'plugin test board'], { cwd, cli });
  assert.ok(existsSync(path.join(cwd, '.flow')));
  const parsed = parseJson(await runBlackboard(['digest', '--json'], { cwd, cli }), 'digest');
  assert.match(parsed.digest, /plugin test board/);
});

test('runBlackboard surfaces CLI failures as errors', async () => {
  const cwd = tempDir();
  await assert.rejects(
    () => runBlackboard(['digest', '--json'], { cwd, cli }),
    /\.flow/,
  );
});

test('add, link, focus and brief round-trip through the event log', async () => {
  const cwd = tempDir();
  const tools = toolsFor(cwd);
  const exec = execFor(cwd);

  const goal = await tools.get('blackboard_add').execute(
    { type: 'goal', title: 'Audit the admin API', enter: true },
    exec,
  );
  assert.match(goal, /\[goal\]/);

  const intent = await tools.get('blackboard_add').execute(
    { type: 'intent', title: 'Enumerate routes', detail: 'Derived from the bundle' },
    exec,
  );
  assert.match(intent, /\[intent\]/);

  const linked = await tools.get('blackboard_link').execute(
    { from: 'g1', to: 'i1', relation: 'derived-from' },
    exec,
  );
  assert.match(linked, /g1 --derived-from--> i1/);

  const focused = await tools.get('blackboard_focus').execute({ to: 'next' }, exec);
  assert.match(focused, /Cursor → i1/);

  const brief = await tools.get('blackboard_brief').execute({}, exec);
  assert.match(brief, /blackboard 黑板恢复/);
  assert.match(brief, /Enumerate routes/);

  const ops = events(cwd).map((event) => event.op);
  assert.deepEqual(ops, ['node', 'cursor', 'node', 'edge', 'cursor']);
});

test('edit marks a node done and show renders both relation directions', async () => {
  const cwd = tempDir();
  const tools = toolsFor(cwd);
  const exec = execFor(cwd);

  await tools.get('blackboard_add').execute({ type: 'goal', title: 'G', enter: true }, exec);
  await tools.get('blackboard_add').execute({ type: 'finding', title: 'F' }, exec);
  await tools.get('blackboard_link').execute({ from: 'g1', to: 'fd1', relation: 'proves' }, exec);
  const edited = await tools.get('blackboard_edit').execute({ id: 'fd1', status: 'done', confidence: 'reproduced' }, exec);
  assert.match(edited, /status=done/);
  assert.match(edited, /confidence=reproduced/);

  const shown = await tools.get('blackboard_show').execute({ id: 'fd1' }, exec);
  assert.match(shown, /Incoming:/);
  assert.match(shown, /G/);

  const list = await tools.get('blackboard_show').execute({ limit: 10 }, exec);
  assert.match(list, /\[goal\]/);
});

test('show rejects an unknown node with the CLI diagnostic', async () => {
  const cwd = tempDir();
  const tools = toolsFor(cwd);
  await runBlackboard(['init'], { cwd, cli });
  await assert.rejects(
    () => tools.get('blackboard_show').execute({ id: 'zzzz' }, execFor(cwd)),
    /no such node/,
  );
});

test('every tool declares a name, description, schema and renderer', () => {
  const tools = toolsFor(tempDir());
  assert.equal(tools.size, 11);
  for (const [name, definition] of tools) {
    assert.match(name, /^blackboard_/);
    assert.ok(definition.description.length > 20);
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.output.schema.type, 'string');
    assert.equal(definition.output.render([], 'hello')[0].text, 'hello');
  }
});

test('a failing CLI path fails the call, not module load', async () => {
  const cwd = tempDir();
  const definitions = createBlackboardTools(defineTool, {
    getCli: () => { throw new Error('blackboard: cliPath does not exist: /nope'); },
    resolveCwd: () => cwd,
  });
  const add = definitions.find((definition) => definition.name === 'blackboard_add');
  await assert.rejects(
    () => add.execute({ type: 'note', title: 'x' }, execFor(cwd)),
    /cliPath does not exist/,
  );
});

test('init bootstraps a board and reports readiness', async () => {
  const cwd = tempDir();
  const tools = toolsFor(cwd);
  const out = await tools.get('blackboard_init').execute({ title: 'Init via tool' }, execFor(cwd));
  assert.match(out, /Board ready: 0 nodes, 0 edges/);
  assert.match(out, /已初始化/);
  assert.ok(existsSync(path.join(cwd, '.flow', 'events.jsonl')));
});

test('checkpoint and context tools act on the live board', async () => {
  const cwd = tempDir();
  const tools = toolsFor(cwd);
  const exec = execFor(cwd);
  await tools.get('blackboard_add').execute({ type: 'goal', title: 'Context goal', enter: true }, exec);

  const checkpoint = await tools.get('blackboard_checkpoint').execute({ summary: 'after goal' }, exec);
  assert.match(checkpoint, /Checkpoint cp1 @g1/);
  assert.match(checkpoint, /after goal/);

  const context = await tools.get('blackboard_context').execute({ depth: 1, budget: 2000 }, exec);
  assert.match(context, /Context goal/);

  const focus = await tools.get('blackboard_focus').execute({ to: 'clear' }, exec);
  assert.equal(focus, 'Cursor cleared');

  assert.deepEqual(events(cwd).map((event) => event.op), ['node', 'cursor', 'checkpoint', 'cursor']);
});

test('a session in a subdirectory writes to the ancestor board', async () => {
  const root = tempDir();
  await runBlackboard(['init', '--title', 'root board'], { cwd: root, cli });
  const sub = path.join(root, 'sub');
  mkdirSync(sub, { recursive: true });

  const tools = toolsFor(sub);
  const created = await tools.get('blackboard_add').execute({ type: 'fact', title: 'from subdir' }, execFor(sub));
  assert.match(created, /\[fact\]/);

  // The project board wins; no nested board may appear in the subdirectory.
  assert.equal(existsSync(path.join(sub, '.flow')), false);
  assert.deepEqual(events(root).map((event) => event.op), ['meta', 'node']);
  assert.match(readFileSync(path.join(root, '.flow', 'events.jsonl'), 'utf8'), /from subdir/);
});
