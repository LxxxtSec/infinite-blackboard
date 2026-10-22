// Module-oriented exports: draw.io (mxGraph XML) and XMind (modern .xmind zip).
// The board remains the source of truth; these are read-only projections.

import { deflateRawSync } from 'node:zlib';
import { orderedStages } from './model.js';

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const html = (value) => esc(value).replace(/\n/g, '<br>');
const cleanLabel = (value, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function unitList(g) {
  return Object.values(g.nodes || {})
    .filter((node) => node.type === 'unit' && node.status !== 'removed' && node.kind !== 'macro')
    .sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')) || Number(a.startLine || 0) - Number(b.startLine || 0));
}

function callEdges(g, unitIds) {
  return Object.values(g.edges || {})
    .filter((edge) => edge.kind === 'calls' && unitIds.has(edge.from) && unitIds.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to }));
}

/**
 * Group the board into functional modules.
 * - stage: one module per attack-chain stage, plus unassigned functions
 * - file: one module per imported file
 */
export function buildModules(g, groupBy = 'stage', stageId = null) {
  const stageUnitIds = stageId
    ? new Set(Object.values(g.edges || {})
      .filter((edge) => edge.kind === 'implements' && edge.to === stageId)
      .map((edge) => edge.from))
    : null;
  const units = unitList(g).filter((unit) => !stageUnitIds || stageUnitIds.has(unit.id));
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unitIds = new Set(byId.keys());
  const calls = callEdges(g, unitIds);
  const stages = orderedStages(g);
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));

  const groups = new Map();
  const add = (id, title, subtitle, stage = null) => {
    if (!groups.has(id)) groups.set(id, { id, title, subtitle, stage, units: [], calls: [] });
    return groups.get(id);
  };

  if (groupBy === 'file') {
    for (const unit of units) {
      const file = unit.file || '(未归类)';
      add(file, file.split('/').pop() || file, file).units.push(unit);
    }
  } else {
    for (const stage of stages) add(stage.id, stage.title || stage.id, stage.phase || '', stage);
    const stageOfUnit = new Map();
    for (const edge of Object.values(g.edges || {})) {
      if (edge.kind !== 'implements' || !unitIds.has(edge.from) || !stageById.has(edge.to)) continue;
      const group = groups.get(edge.to);
      if (group && !group.units.some((unit) => unit.id === edge.from)) group.units.push(byId.get(edge.from));
      if (!stageOfUnit.has(edge.from)) stageOfUnit.set(edge.from, edge.to);
    }
    const unassigned = units.filter((unit) => !stageOfUnit.has(unit.id));
    if (!stageId && unassigned.length) add('__unassigned', '未归类函数', '没有绑定到攻击阶段', null).units = unassigned;
    if (stageId) {
      for (const id of [...groups.keys()]) if (id !== stageId) groups.delete(id);
    }
  }

  const moduleOf = new Map();
  for (const group of groups.values()) {
    group.units.sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')) || Number(a.startLine || 0) - Number(b.startLine || 0));
    for (const unit of group.units) if (!moduleOf.has(unit.id)) moduleOf.set(unit.id, group.id);
    const ids = new Set(group.units.map((unit) => unit.id));
    group.calls = calls.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }

  const cross = new Map();
  for (const edge of calls) {
    const from = moduleOf.get(edge.from);
    const to = moduleOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}`;
    cross.set(key, (cross.get(key) || 0) + 1);
  }

  return {
    groupBy,
    title: g.meta?.title || 'blackboard',
    modules: [...groups.values()].filter((group) => group.units.length || group.stage),
    crossCalls: [...cross.entries()].map(([key, count]) => {
      const [from, to] = key.split('|');
      return { from, to, count };
    }),
    unitById: byId,
  };
}

const style = {
  header: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#0f1b18;strokeColor=#0f1b18;fontColor=#d8eee7;fontStyle=1;fontSize=14;align=left;spacing=12;',
  module: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f2f7f5;strokeColor=#7ca294;fontStyle=1;fontSize=13;verticalAlign=top;align=left;spacing=12;',
  unit: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#eef5ff;strokeColor=#5b7fa3;align=left;verticalAlign=top;spacing=8;fontSize=11;',
  edge: 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;strokeColor=#6b7e95;fontSize=10;labelBackgroundColor=#ffffff;',
  text: 'text;html=1;align=left;verticalAlign=middle;fontSize=12;whiteSpace=wrap;',
};

function unitLabel(unit) {
  const role = unit.role ? `<br><font color="#52645d">${html(cleanLabel(unit.role, 220))}</font>` : '';
  const file = unit.file ? `<br><font color="#7c8b85" size="1">${html(`${unit.file.split('/').pop()}:${unit.startLine || ''}`)}</font>` : '';
  return `<b>${html(unit.symbol || unit.title || unit.id)}</b>${role}${file}`;
}

function moduleLabel(group, outgoing = 0, incoming = 0) {
  const phase = group.stage?.phase ? `<br><font color="#6b7e95" size="1">${html(group.stage.phase)}</font>` : '';
  const links = outgoing || incoming
    ? `<br><font color="#7c8b85" size="1">调用 ${outgoing} · 被调用 ${incoming}</font>`
    : '';
  return `<b>${html(cleanLabel(group.title, 120))}</b><br><font color="#7c8b85" size="1">${group.units.length} 个函数</font>${phase}${links}`;
}

function drawioPage(id, name, cells) {
  return `<diagram id="${esc(id)}" name="${esc(name)}"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram>`;
}

export function drawioXml(g, groupBy = 'stage', stageId = null) {
  const data = buildModules(g, groupBy, stageId);
  const pages = [];
  const outgoing = new Map();
  const incoming = new Map();
  for (const cross of data.crossCalls) {
    outgoing.set(cross.from, (outgoing.get(cross.from) || 0) + cross.count);
    incoming.set(cross.to, (incoming.get(cross.to) || 0) + cross.count);
  }

  // Overview deliberately has no crossing edges. Cross-module calls live on a
  // separate readable list page instead of routing arrows through module boxes.
  if (!stageId) {
    let summary = '';
    data.modules.forEach((group, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      summary += `<mxCell id="mod-${index}" value="${esc(moduleLabel(group, outgoing.get(group.id) || 0, incoming.get(group.id) || 0))}" style="${style.module}" vertex="1" parent="1"><mxGeometry x="${40 + col * 350}" y="${40 + row * 180}" width="320" height="150" as="geometry"/></mxCell>`;
    });
    pages.push(drawioPage('overview', `${data.title} · 模块总览`, summary));

    if (data.crossCalls.length) {
      let table = `<mxCell id="cross-header" value="${esc(`跨模块调用 · ${data.crossCalls.length} 条`)}" style="${style.header}" vertex="1" parent="1"><mxGeometry x="20" y="20" width="900" height="46" as="geometry"/></mxCell>`;
      const byId = new Map(data.modules.map((group) => [group.id, group]));
      data.crossCalls
        .slice()
        .sort((a, b) => b.count - a.count)
        .forEach((cross, index) => {
          const from = byId.get(cross.from)?.title || cross.from;
          const to = byId.get(cross.to)?.title || cross.to;
          table += `<mxCell id="cross-row-${index}" value="${esc(`${from}  →  ${to}    ${cross.count} 次调用`)}" style="${style.text}" vertex="1" parent="1"><mxGeometry x="40" y="${88 + index * 34}" width="860" height="28" as="geometry"/></mxCell>`;
        });
      pages.push(drawioPage('cross-module', '跨模块调用', table));
    }
  }

  data.modules.forEach((group, index) => {
    const pageId = `module-${index}`;
    let cells = `<mxCell id="${pageId}-header" value="${esc(moduleLabel(group, outgoing.get(group.id) || 0, incoming.get(group.id) || 0))}" style="${style.header}" vertex="1" parent="1"><mxGeometry x="20" y="20" width="900" height="56" as="geometry"/></mxCell>`;
    const ids = new Map();
    group.units.forEach((unit, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const id = `${pageId}-unit-${i}`;
      ids.set(unit.id, id);
      cells += `<mxCell id="${id}" value="${esc(unitLabel(unit))}" style="${style.unit}" vertex="1" parent="1"><mxGeometry x="${20 + col * 300}" y="${96 + row * 140}" width="280" height="120" as="geometry"/></mxCell>`;
    });
    for (const call of group.calls) {
      const source = ids.get(call.from);
      const target = ids.get(call.to);
      if (!source || !target) continue;
      cells += `<mxCell id="${pageId}-edge-${esc(call.from)}-${esc(call.to)}" style="${style.edge}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    }
    pages.push(drawioPage(pageId, cleanLabel(group.title, 60), cells));
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="Infinite Blackboard" type="device">${pages.join('')}</mxfile>\n`;
}

function xmindTopic(id, title, children = [], note = '') {
  const topic = { id, class: 'topic', title, titleUnedited: false };
  if (note) topic.notes = { plain: { content: note } };
  if (children.length) topic.children = { attached: children };
  return topic;
}

function unitTopic(prefix, unit, group, data) {
  const calls = group.calls.filter((call) => call.from === unit.id)
    .map((call) => data.unitById.get(call.to)?.symbol || call.to);
  const note = [
    unit.role ? `作用：${unit.role}` : '',
    unit.file ? `位置：${unit.file}:${unit.startLine || ''}-${unit.endLine || ''}` : '',
    unit.learned ? '状态：已学习' : '',
    calls.length ? `调用：${calls.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return xmindTopic(`${prefix}-unit-${unit.id}`, unit.symbol || unit.title || unit.id, [], note);
}

export function xmindContent(g, groupBy = 'stage', stageId = null) {
  const data = buildModules(g, groupBy, stageId);
  if (stageId) {
    const group = data.modules[0];
    if (!group) {
      return {
        content: [{ id: 'sheet-empty', class: 'sheet', title: '当前阶段', rootTopic: xmindTopic('root-empty', '当前阶段没有函数') }],
        metadata: { creator: { name: 'Infinite Blackboard', version: '0.6.0' }, activeSheetId: 'sheet-empty' },
        manifest: { 'file-entries': { 'content.json': {}, 'metadata.json': {}, 'manifest.json': {} } },
      };
    }
    const root = xmindTopic('root-stage', group.title, group.units.map((unit) => unitTopic('stage', unit, group, data)));
    root.structureClass = 'org.xmind.ui.map.clockwise';
    const sheet = { id: 'sheet-stage', class: 'sheet', title: cleanLabel(group.title, 50), rootTopic: root };
    return {
      content: [sheet],
      metadata: { creator: { name: 'Infinite Blackboard', version: '0.6.0' }, activeSheetId: 'sheet-stage' },
      manifest: { 'file-entries': { 'content.json': {}, 'metadata.json': {}, 'manifest.json': {} } },
    };
  }

  const overviewRoot = xmindTopic('root-overview', data.title, data.modules.map((group, index) => (
    xmindTopic(
      `module-${index}`,
      `${String(index + 1).padStart(2, '0')} ${group.title}`,
      [],
      [group.stage?.phase ? `阶段：${group.stage.phase}` : '', `${group.units.length} 个函数`, '详细内容见下方同名 Sheet'].filter(Boolean).join('\n'),
    )
  )), `按${groupBy === 'file' ? '文件' : '攻击阶段'}导出的功能模块 · 共 ${data.modules.length} 个模块 · 每个模块一张 Sheet`);
  overviewRoot.structureClass = 'org.xmind.ui.map.clockwise';
  const sheets = [{
    id: 'sheet-overview',
    class: 'sheet',
    title: groupBy === 'file' ? '文件总览' : '攻击链总览',
    rootTopic: overviewRoot,
  }];
  data.modules.forEach((group, index) => {
    const root = xmindTopic(`root-module-${index}`, group.title, group.units.map((unit) => unitTopic(`module-${index}`, unit, group, data)));
    root.structureClass = 'org.xmind.ui.map.clockwise';
    sheets.push({
      id: `sheet-module-${index}`,
      class: 'sheet',
      title: `${String(index + 1).padStart(2, '0')} ${cleanLabel(group.title, 45)}`,
      rootTopic: root,
    });
  });
  return {
    content: sheets,
    metadata: { creator: { name: 'Infinite Blackboard', version: '0.6.0' }, activeSheetId: `sheet-overview` },
    manifest: { 'file-entries': { 'content.json': {}, 'metadata.json': {}, 'manifest.json': {} } },
  };
}

// Minimal ZIP writer (deflate) so XMind export needs no runtime dependency.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function zipFiles(files) {
  const entries = [];
  const locals = [];
  let offset = 0;
  const { time, day } = dosTime();
  for (const [name, value] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.from(value, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, compressed);
    entries.push({ name: nameBuffer, crc, compressed: compressed.length, original: data.length, offset });
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const central = [];
  for (const entry of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.original, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    central.push(header, entry.name);
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...central, end]);
}

export function xmindZip(g, groupBy = 'stage', stageId = null) {
  const data = xmindContent(g, groupBy, stageId);
  return zipFiles({
    'content.json': JSON.stringify(data.content),
    'metadata.json': JSON.stringify(data.metadata),
    'manifest.json': JSON.stringify(data.manifest),
  });
}
