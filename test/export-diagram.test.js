import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModules, drawioXml, xmindContent, xmindZip } from '../lib/export-diagram.js';

function graph() {
  return {
    meta: { title: '导出测试板' },
    nodes: {
      st1: { id: 'st1', type: 'stage', title: '堆布局', phase: 'heap', status: 'active' },
      u1: { id: 'u1', type: 'unit', kind: 'function', symbol: 'heap_prepare', title: 'heap_prepare', file: 'heap.c', startLine: 10, endLine: 20, role: '准备堆布局', status: 'active' },
      u2: { id: 'u2', type: 'unit', kind: 'function', symbol: 'spray_msg', title: 'spray_msg', file: 'net.c', startLine: 30, endLine: 40, role: '喷洒对象', status: 'active' },
      m1: { id: 'm1', type: 'unit', kind: 'macro', symbol: 'SZ', title: 'SZ', file: 'heap.c', status: 'active' },
    },
    edges: {
      e1: { id: 'e1', from: 'u1', to: 'st1', kind: 'implements' },
      e2: { id: 'e2', from: 'u2', to: 'st1', kind: 'implements' },
      e3: { id: 'e3', from: 'u1', to: 'u2', kind: 'calls' },
    },
    lessons: {},
  };
}

test('module export groups stage functions and keeps call edges', () => {
  const g = graph();
  const modules = buildModules(g, 'stage');
  assert.equal(modules.modules.length, 1);
  assert.deepEqual(modules.modules[0].units.map((unit) => unit.id).sort(), ['u1', 'u2']);
  assert.equal(modules.modules[0].calls.length, 1);
  const xml = drawioXml(g, 'stage');
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /heap_prepare/);
  assert.match(xml, /spray_msg/);
  assert.match(xml, /<diagram/);
  assert.match(xml, /target="module-0-unit-1"/);
});

test('current-stage export only contains that module', () => {
  const g = graph();
  const xml = drawioXml(g, 'stage', 'st1');
  assert.doesNotMatch(xml, /id="overview"/);
  assert.match(xml, /name="堆布局"/);
  const xmind = xmindContent(g, 'stage', 'st1');
  assert.equal(xmind.content.length, 1);
  assert.equal(xmind.content[0].rootTopic.title, '堆布局');
});

test('a unit repeated in two stages is owned by the first stage only', () => {
  const g = graph();
  g.nodes.st2 = { id: 'st2', type: 'stage', title: '第二阶段', phase: 'next', status: 'active' };
  g.edges.e4 = { id: 'e4', from: 'u1', to: 'st2', kind: 'implements' };
  g.edges.e5 = { id: 'e5', from: 'u2', to: 'st2', kind: 'implements' };
  const modules = buildModules(g, 'stage');
  assert.equal(modules.modules.length, 2);
  assert.deepEqual(modules.modules.find((m) => m.id === 'st1').units.map((u) => u.id).sort(), ['u1', 'u2']);
  assert.deepEqual(modules.modules.find((m) => m.id === 'st2').units, []);
});

test('XMind export is a zip with modern XMind JSON sheets', () => {
  const g = graph();
  const content = xmindContent(g, 'stage');
  const sheet = content.content[0];
  assert.equal(sheet.class, 'sheet');
  assert.ok(sheet.rootTopic.children.attached[0].title.endsWith('堆布局'));
  assert.ok(content.content.length > 1, 'one sheet per stage plus overview');
  const stageSheet = content.content.find((item) => item.title.endsWith('堆布局'));
  assert.ok(stageSheet);
  assert.equal(stageSheet.rootTopic.children.attached.length, 2);
  assert.match(stageSheet.rootTopic.children.attached[0].notes.plain.content, /heap.c/);
  const zip = xmindZip(g, 'stage');
  assert.ok(Buffer.isBuffer(zip));
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(zip.includes(Buffer.from('content.json')));
  assert.ok(zip.includes(Buffer.from('metadata.json')));
});
