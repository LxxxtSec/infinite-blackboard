// Append-only blackboard event store. JSON Lines is the source of truth;
// state.json is a disposable compatibility cache.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  emptyGraph, applyAll, edgeId, inferEdgeKind, TYPE_PREFIX, NODE_TYPES,
  NODE_STATES, SEVERITIES, CONFIDENCE_LEVELS, currentCursor, nextShortId,
  resolveRef, isUnit, unitsOf,
} from './model.js';
import { validateLesson, stampLesson, coverage } from './teach.js';

export const FLOW_DIR = '.flow';

export function paths(cwd = process.cwd()) {
  const root = path.join(cwd, FLOW_DIR);
  return {
    cwd, root,
    events: path.join(root, 'events.jsonl'),
    state: path.join(root, 'state.json'),
    config: path.join(root, 'config.json'),
    digest: path.join(root, 'digest.md'),
    lock: path.join(root, 'lock'),
  };
}

export function isInitialized(cwd = process.cwd()) {
  return fs.existsSync(paths(cwd).events);
}

/**
 * The board that owns `start`: the nearest directory at or above it holding
 * `.flow/events.jsonl`, like git finds its repository. Null when there is none.
 */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (isInitialized(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The board holds raw agent text (and, with activity capture, tool output), so a
 * new one keeps itself out of version control until someone chooses otherwise.
 */
export function protectBoard(cwd = process.cwd()) {
  const file = path.join(paths(cwd).root, '.gitignore');
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, '# blackboard data may contain sensitive text; remove this file to track it\n*\n');
  return true;
}

export function ensure(cwd = process.cwd()) {
  const p = paths(cwd);
  if (!fs.existsSync(p.root)) {
    fs.mkdirSync(p.root, { recursive: true });
    protectBoard(cwd);
  }
  if (!fs.existsSync(p.events)) fs.writeFileSync(p.events, '');
  if (!fs.existsSync(p.state)) fs.writeFileSync(p.state, JSON.stringify(defaultState(), null, 2));
  if (!fs.existsSync(p.config)) fs.writeFileSync(p.config, JSON.stringify(defaultConfig(), null, 2));
  return p;
}

export function defaultState() {
  const seq = {};
  for (const t of NODE_TYPES) seq[TYPE_PREFIX[t]] = 0;
  return {
    session: `session_${Date.now().toString(36)}`,
    title: '',
    started: new Date().toISOString(),
    focus: null,
    cursors: {},
    seq, // retained only so older installations remain readable
    hooks: true,
  };
}

export function defaultConfig() {
  return {
    // Only honored when optional hooks are explicitly installed. The normal
    // path remains direct Agent read/write calls.
    autoRecord: true,
    autoTools: ['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'Read', 'Grep', 'Glob'],
    maxActivities: 4000,
    maxAutoFacts: 4000, // legacy alias
    detailLimit: 1200,
    redact: true,
    digest: {
      maxNeighbors: 16,
      maxTrail: 10,
      maxOpenNodes: 16,
      maxCheckpoints: 6,
    },
  };
}

function recoverState(cwd) {
  const state = defaultState();
  const { events } = readEvents(cwd, 0);
  for (const ev of events) {
    if (ev.op === 'reset') {
      const fresh = defaultState();
      Object.assign(state, fresh);
    } else if (ev.op === 'meta' && ev.set) {
      if (ev.set.title !== undefined) state.title = ev.set.title;
      if (ev.set.session !== undefined) state.session = ev.set.session;
      if (ev.set.focus !== undefined) state.focus = ev.set.focus;
    } else if (ev.op === 'cursor' && ev.cursor?.agentId) {
      state.cursors[ev.cursor.agentId] = ev.cursor.to || null;
      if (ev.cursor.agentId === 'agent:primary') state.focus = ev.cursor.to || null;
    }
  }
  return state;
}

export function readState(cwd = process.cwd()) {
  const p = paths(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(p.state, 'utf8'));
    return { ...defaultState(), ...parsed, cursors: parsed.cursors || {} };
  } catch {
    return recoverState(cwd);
  }
}

export function writeState(state, cwd = process.cwd()) {
  const p = paths(cwd);
  const tmp = `${p.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p.state);
  return state;
}

/**
 * state.json is a disposable cache. Once the event is appended the action has
 * happened, so a failed cache write must not surface as a failed command
 * (the caller would retry and duplicate the event); readState recovers instead.
 */
function saveState(state, cwd) {
  try {
    writeState(state, cwd);
  } catch {
    try { fs.unlinkSync(paths(cwd).state); } catch {}
  }
}

export function readConfig(cwd = process.cwd()) {
  const defaults = defaultConfig();
  const p = paths(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(p.config, 'utf8'));
    return { ...defaults, ...parsed, digest: { ...defaults.digest, ...(parsed.digest || {}) } };
  } catch {
    return defaults;
  }
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** A lock is stale only when its owner is gone; a slow but live writer keeps it. */
function lockIsStale(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const pid = Number(raw.split('\n')[0]);
  if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
  // Unreadable owner (crash between create and write): fall back to age.
  try { return Date.now() - fs.statSync(file).mtimeMs > 30000; } catch { return false; }
}

/** Cross-process lock. A live lock is never deleted merely because we waited. */
export function withLock(fn, cwd = process.cwd(), timeoutMs = null) {
  const p = paths(cwd);
  if (!fs.existsSync(p.root)) fs.mkdirSync(p.root, { recursive: true });
  // Callers that must never hold up the Agent (hooks) pass a short limit.
  const deadline = Date.now() + (timeoutMs || Number(process.env.BLACKBOARD_LOCK_TIMEOUT_MS) || 10000);
  const token = `${process.pid}\n${Date.now()}\n${crypto.randomBytes(6).toString('hex')}\n`;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(p.lock, 'wx');
      fs.writeFileSync(fd, token);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(p.lock)) {
        try { fs.unlinkSync(p.lock); } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error('blackboard lock timeout: another writer is still active');
      sleepSync(8);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    // Only remove the lock if it is still ours.
    try {
      if (fs.readFileSync(p.lock, 'utf8') === token) fs.unlinkSync(p.lock);
    } catch {}
  }
}

function uniqueId(prefix) {
  const time = Date.now().toString(36);
  const pid = process.pid.toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${time}_${pid}${random}`;
}

function repairTornTail(file) {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    const readSize = Math.min(size, 1024 * 1024);
    const tail = Buffer.alloc(readSize);
    fs.readSync(fd, tail, 0, readSize, size - readSize);
    const nl = tail.lastIndexOf(0x0a);
    fs.ftruncateSync(fd, nl === -1 ? 0 : size - readSize + nl + 1);
  } finally {
    fs.closeSync(fd);
  }
}

export function appendEvent(ev, cwd = process.cwd()) {
  const p = paths(cwd);
  if (!fs.existsSync(p.root)) fs.mkdirSync(p.root, { recursive: true });
  if (!fs.existsSync(p.events)) fs.writeFileSync(p.events, '');
  repairTornTail(p.events);
  const record = {
    eventVersion: ev.eventVersion || 1,
    eventId: ev.eventId || uniqueId('event'),
    ...ev,
  };
  fs.appendFileSync(p.events, `${JSON.stringify(record)}\n`);
  return record;
}

export function readEvents(cwd = process.cwd(), fromByte = 0) {
  const p = paths(cwd);
  let buf;
  try {
    const fd = fs.openSync(p.events, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= fromByte) {
      fs.closeSync(fd);
      return { events: [], corrupt: 0, offset: size, truncated: false };
    }
    buf = Buffer.alloc(size - fromByte);
    fs.readSync(fd, buf, 0, buf.length, fromByte);
    fs.closeSync(fd);
  } catch {
    return { events: [], corrupt: 0, offset: fromByte, truncated: false };
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const complete = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
  const events = [];
  let corrupt = 0;
  for (const line of complete.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { corrupt++; }
  }
  return {
    events, corrupt,
    offset: fromByte + Buffer.byteLength(complete, 'utf8'),
    truncated: lastNl === -1,
  };
}

export function replay(cwd = process.cwd()) {
  const { events, corrupt } = readEvents(cwd, 0);
  const g = applyAll(emptyGraph(), events);
  g.integrity.corruptLines = corrupt;
  g.meta.count = Object.keys(g.nodes).length;
  return g;
}

/** "src/api/auth.js:142" or "src/api/auth.js" → { path, line } */
export function parseLocation(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = t.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (m) return { path: m[1], line: Number(m[2]) };
  const base = t.split('/').pop() || '';
  if (base && base.includes('.') && !base.startsWith('.')) return { path: t };
  return null;
}

export const LIMITS = { title: 500, detail: 20000, label: 500, summary: 12000 };

/** Cut `value` to the field limit and record the field name, so the caller can say so. */
function clipField(value, field, notes) {
  const text = String(value || '');
  if (text.length <= LIMITS[field]) return text;
  notes.push(field);
  return text.slice(0, LIMITS[field]);
}

/** Short ids (n12, hy3) are what an Agent has to type; they are derived from the log inside the write lock. */
function nodeId(g, type) {
  return nextShortId(g.nodes, TYPE_PREFIX[type] || 'n');
}

function cursorRecord({ from = null, to = null, reason = '', agentId = 'agent:primary', sessionId }) {
  const cursor = {
    id: uniqueId('cursor'), agentId, from, to, at: Date.now(), sessionId,
  };
  if (reason) cursor.reason = String(reason).slice(0, 500);
  return cursor;
}

/** Add a logic node. Linking and entering are explicit, independent options. */
export function addNode(input, cwd = process.cwd()) {
  const {
    type = 'note', title = '', detail = '', parent = null, status = null,
    severity = null, confidence = null, tags = [], auto = false, session = null, extra = null,
    at = null, enter = false, relateHere = false, relation = null,
    agentId = 'agent:primary', reason = '',
  } = input;

  if (status && !NODE_STATES.includes(status)) throw new Error(`invalid node state: ${status}`);
  if (severity && !SEVERITIES.includes(severity)) throw new Error(`invalid severity: ${severity}`);
  if (confidence && !CONFIDENCE_LEVELS.includes(confidence)) throw new Error(`invalid confidence: ${confidence}`);

  return withLock(() => {
    const state = readState(cwd);
    const g = replay(cwd);
    const truncated = [];
    const node = {
      id: nodeId(g, type), type, title: clipField(title, 'title', truncated),
      ts: Date.now(), session: session || state.session,
    };
    if (detail) node.detail = clipField(detail, 'detail', truncated);
    if (tags && tags.length) node.tags = [...new Set(tags.map(String))];
    if (auto) node.auto = true;
    if (status) node.status = status;
    else if (['intent', 'hypothesis', 'question'].includes(type)) node.status = 'open';
    if (severity) node.severity = severity;
    else if (type === 'vuln') node.severity = 'medium';
    if (confidence) node.confidence = confidence;
    if (extra && typeof extra === 'object') Object.assign(node, extra);
    if (at) {
      const loc = parseLocation(at);
      if (loc) node.loc = loc;
    }

    let sourceId = parent ? resolveRef(g.nodes, parent, 'source node') : null;
    if (!sourceId && relateHere) sourceId = currentCursor(g, agentId);
    if (sourceId && !g.nodes[sourceId]) throw new Error(`no such source node: ${sourceId}`);
    if (sourceId && parent) node.parent = sourceId; // legacy projection only

    appendEvent({ op: 'node', node }, cwd);

    let edge = null;
    if (sourceId) {
      const kind = relation || inferEdgeKind(g.nodes[sourceId]?.type, type);
      edge = {
        id: edgeId(sourceId, node.id, kind), from: sourceId, to: node.id,
        kind, ts: node.ts,
      };
      appendEvent({ op: 'edge', edge }, cwd);
    }

    let cursor = null;
    if (enter) {
      const from = currentCursor(g, agentId);
      cursor = cursorRecord({ from, to: node.id, reason, agentId, sessionId: state.session });
      appendEvent({ op: 'cursor', cursor }, cwd);
      state.cursors[agentId] = node.id;
      if (agentId === 'agent:primary') state.focus = node.id;
    }
    saveState(state, cwd);
    return truncated.length ? { node, edge, cursor, truncated } : { node, edge, cursor };
  }, cwd);
}

export function patchNode(ref, set, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const id = resolveRef(g.nodes, ref);
    if ('id' in set || 'ts' in set) throw new Error('a node\'s id and creation time cannot be changed');
    if (set.status && !NODE_STATES.includes(set.status)) throw new Error(`invalid node state: ${set.status}`);
    if (set.severity && !SEVERITIES.includes(set.severity)) throw new Error(`invalid severity: ${set.severity}`);
    if (set.confidence && !CONFIDENCE_LEVELS.includes(set.confidence)) throw new Error(`invalid confidence: ${set.confidence}`);
    const truncated = [];
    const updated = { ...set, updated: Date.now() };
    if (typeof updated.title === 'string') updated.title = clipField(updated.title, 'title', truncated);
    if (typeof updated.detail === 'string') updated.detail = clipField(updated.detail, 'detail', truncated);
    appendEvent({ op: 'patch', id, set: updated }, cwd);
    const node = { ...g.nodes[id], ...updated };
    return truncated.length ? { ...node, truncated } : node;
  }, cwd);
}

export function addEdge(input, cwd = process.cwd()) {
  const { kind = 'related-to', label = '' } = input;
  return withLock(() => {
    const g = replay(cwd);
    const from = resolveRef(g.nodes, input.from);
    const to = resolveRef(g.nodes, input.to);
    if (from === to) throw new Error('a logic edge cannot link a node to itself');
    const edge = { id: edgeId(from, to, kind), from, to, kind, ts: Date.now() };
    const truncated = [];
    if (label) edge.label = clipField(label, 'label', truncated);
    appendEvent({ op: 'edge', edge }, cwd);
    return truncated.length ? { ...edge, truncated } : edge;
  }, cwd);
}

export function moveCursor(ref, { reason = '', agentId = 'agent:primary' } = {}, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const id = ref ? resolveRef(g.nodes, ref) : null;
    const state = readState(cwd);
    const cursor = cursorRecord({
      from: currentCursor(g, agentId), to: id || null, reason, agentId,
      sessionId: state.session,
    });
    appendEvent({ op: 'cursor', cursor }, cwd);
    state.cursors[agentId] = id || null;
    if (agentId === 'agent:primary') state.focus = id || null;
    saveState(state, cwd);
    return cursor;
  }, cwd);
}

/** Backward-compatible alias. */
export function setFocus(id, cwd = process.cwd()) {
  return moveCursor(id, {}, cwd);
}

export function addActivity(input, cwd = process.cwd(), { lockTimeoutMs = null } = {}) {
  return withLock(() => {
    const state = readState(cwd);
    const g = replay(cwd);
    const activity = {
      id: nextShortId(g.activities, 'act'),
      tool: String(input.tool || 'tool'),
      summary: String(input.summary || '').slice(0, 500),
      status: input.status || 'success',
      agentId: input.agentId || 'agent:primary',
      at: Date.now(),
      sessionId: state.session,
    };
    if (input.input) activity.input = String(input.input).slice(0, 4000);
    if (input.output) activity.output = String(input.output).slice(0, 20000);
    if (input.location) activity.location = input.location;
    const cursorId = currentCursor(g, activity.agentId);
    if (cursorId) activity.linkedNodeIds = [cursorId];
    appendEvent({ op: 'activity', activity }, cwd);
    return activity;
  }, cwd, lockTimeoutMs);
}

export function addCheckpoint(input = {}, cwd = process.cwd(), { lockTimeoutMs = null } = {}) {
  return withLock(() => {
    const state = readState(cwd);
    const g = replay(cwd);
    const agentId = input.agentId || 'agent:primary';
    const truncated = [];
    const checkpoint = {
      id: nextShortId(g.checkpoints, 'cp'), agentId, at: Date.now(), sessionId: state.session,
      cursorNodeId: currentCursor(g, agentId),
      summary: clipField(input.summary, 'summary', truncated),
      trigger: input.trigger || 'manual',
    };
    appendEvent({ op: 'checkpoint', checkpoint }, cwd);
    return truncated.length ? { ...checkpoint, truncated } : checkpoint;
  }, cwd, lockTimeoutMs);
}

// ---- Student progress and Agent annotations (additive) ------------------

/**
 * Resolve a unit by short id, by a unique symbol/title, or by a
 * file-qualified reference (`vuln_demo.c:vuln_free`). Symbols survive
 * re-imports; the file prefix disambiguates the same name in two files.
 */
export function resolveUnitRef(g, ref) {
  const text = String(ref ?? '').trim();
  try {
    const id = resolveRef(g.nodes, text, 'unit');
    if (isUnit(g.nodes[id])) return id;
  } catch { /* fall through to symbol lookup */ }

  const all = unitsOf(g).filter((unit) => unit.status !== 'removed');
  const colon = text.lastIndexOf(':');
  if (colon > 0) {
    const file = text.slice(0, colon);
    const symbol = text.slice(colon + 1);
    const base = file.split('/').pop();
    const matches = all.filter((unit) => (unit.symbol === symbol || unit.title === symbol)
      && (unit.file === file || String(unit.file || '').endsWith(`/${file}`) || String(unit.file || '').split('/').pop() === base));
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw new Error(`ambiguous unit "${text}": ${matches.slice(0, 5).map((u) => `${u.id}@${u.file}`).join(', ')}`);
    throw new Error(`no such unit: ${text}`);
  }

  const matches = all.filter((unit) => unit.symbol === text || unit.title === text);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`ambiguous unit "${text}": ${matches.slice(0, 5).map((u) => `${u.id}@${u.file}`).join(', ')} (use file:symbol)`);
  }
  throw new Error(`no such unit: ${text}`);
}

/** Mark one code unit as learned/unlearned. Progress is per board, like everything else. */
export function setLearned(ref, learned = true, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const id = resolveUnitRef(g, ref);
    if (!isUnit(g.nodes[id])) throw new Error(`${id} is a ${g.nodes[id].type}, not a code unit`);
    const set = {
      learned: Boolean(learned),
      learnedAt: learned ? Date.now() : null,
      updated: Date.now(),
    };
    appendEvent({ op: 'patch', id, set }, cwd);
    return { ...g.nodes[id], ...set };
  }, cwd);
}

/**
 * Set short "what this function does in the exploit" roles. Accepts
 * [{ id, role }] or an object map { u12: "..." }. Returns resolved updates.
 */
export function setUnitRoles(entries, cwd = process.cwd()) {
  const list = Array.isArray(entries)
    ? entries
    : Object.entries(entries || {}).map(([id, value]) => (
      value && typeof value === 'object' ? { id, ...value } : { id, role: value }
    ));
  return withLock(() => {
    const g = replay(cwd);
    const updated = [];
    for (const entry of list) {
      const id = resolveUnitRef(g, entry.id ?? entry.symbol);
      if (!isUnit(g.nodes[id])) throw new Error(`${id} is a ${g.nodes[id].type}, not a code unit`);
      const set = { updated: Date.now() };
      if (entry.role !== undefined) set.role = String(entry.role ?? '').trim().slice(0, 300);
      // `detail` is the longer "where it comes from / what it means" note,
      // surfaced by the macro lookup table.
      if (entry.detail !== undefined) set.detail = String(entry.detail ?? '').trim().slice(0, 20000);
      appendEvent({ op: 'patch', id, set }, cwd);
      updated.push({ id, role: set.role ?? g.nodes[id].role ?? '', detail: set.detail ?? g.nodes[id].detail ?? '' });
    }
    return updated;
  }, cwd);
}

/**
 * Create a reviewable attack chain authored by the Agent (any titles/phases,
 * any order). `replace` retires the existing stages first, which is how a
 * heuristic `code import --chain` draft gets replaced by a real analysis.
 */
export function addChain(stages, { replace = false, agentId = 'agent:primary' } = {}, cwd = process.cwd()) {
  if (!Array.isArray(stages) || !stages.length) throw new Error('chain.stages must be a non-empty array');
  if (stages.length > 50) throw new Error('a chain may have at most 50 stages');
  return withLock(() => {
    const g = replay(cwd);
    const created = [];
    const edges = [];
    if (replace) {
      for (const node of Object.values(g.nodes)) {
        if (node.type === 'stage' && node.status !== 'removed') {
          appendEvent({ op: 'patch', id: node.id, set: { status: 'removed', updated: Date.now() } }, cwd);
          node.status = 'removed';
        }
      }
    }
    const knownEdges = new Set(Object.keys(g.edges));
    let previous = null;
    for (const stage of stages) {
      const title = String(stage.title || '').trim();
      if (!title) throw new Error('every chain stage needs a title');
      const node = {
        id: nextShortId(g.nodes, TYPE_PREFIX.stage || 'st'),
        type: 'stage',
        title: title.slice(0, 500),
        phase: stage.phase ? String(stage.phase).slice(0, 60) : null,
        detail: String(stage.detail || '').slice(0, 20000),
        agentId,
        status: 'active',
        ts: Date.now(),
      };
      appendEvent({ op: 'node', node }, cwd);
      g.nodes[node.id] = node;
      created.push(node);
      if (previous) {
        const id = edgeId(previous.id, node.id, 'step-before');
        if (!knownEdges.has(id)) {
          const edge = { id, from: previous.id, to: node.id, kind: 'step-before', ts: Date.now() };
          appendEvent({ op: 'edge', edge }, cwd);
          knownEdges.add(id);
          edges.push(edge);
        }
      }
      const units = Array.isArray(stage.units) ? stage.units : [];
      for (const ref of units) {
        const unitId = resolveUnitRef(g, ref);
        if (!isUnit(g.nodes[unitId])) throw new Error(`${unitId} is not a code unit (stage "${title}")`);
        const id = edgeId(unitId, node.id, 'implements');
        if (knownEdges.has(id)) continue;
        const edge = { id, from: unitId, to: node.id, kind: 'implements', ts: Date.now() };
        appendEvent({ op: 'edge', edge }, cwd);
        knownEdges.add(id);
        edges.push(edge);
      }
      previous = node;
    }
    return { stages: created, edges };
  }, cwd);
}

// ---- Teaching-board writes (additive; pentest boards never call these) ----

/** Record one imported source file; `path` is the identity. */
export function addFile(input, cwd = process.cwd()) {
  const file = {
    path: String(input.path),
    lang: input.lang || 'text',
    hash: String(input.hash || ''),
    lines: Number(input.lines) || 0,
    bytes: Number(input.bytes) || 0,
    includes: Array.isArray(input.includes) ? input.includes.slice(0, 200) : [],
    ts: Date.now(),
  };
  return withLock(() => {
    appendEvent({ op: 'file', file }, cwd);
    return file;
  }, cwd);
}

/**
 * Upsert parsed code units for one file. Identity is
 * `file|kind|symbol|startLine`, so re-importing an unchanged file is a no-op,
 * a moved function becomes a patch, a vanished function is marked removed, and
 * human annotations on surviving units are preserved.
 */
export function upsertUnits(file, parsedUnits, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const keyOf = (unit) => `${unit.file}|${unit.kind}|${unit.symbol}|${unit.startLine}`;
    const existing = new Map();
    for (const unit of unitsOf(g)) {
      if (unit.file !== file.path || unit.status === 'removed') continue;
      existing.set(keyOf(unit), unit);
    }
    const created = [];
    const updated = [];
    const removed = [];
    const wanted = new Set();

    for (const raw of parsedUnits) {
      const key = keyOf({ ...raw, file: file.path });
      wanted.add(key);
      const fields = {
        title: raw.symbol,
        kind: raw.kind,
        symbol: raw.symbol,
        file: file.path,
        lang: file.lang,
        startLine: raw.startLine,
        endLine: raw.endLine,
        signature: raw.signature || '',
        tags: raw.tags || [],
        calls: raw.calls || [],
        unitHash: file.hash,
      };
      const current = existing.get(key);
      if (current) {
        const patch = {};
        for (const [name, value] of Object.entries(fields)) {
          if (JSON.stringify(current[name]) !== JSON.stringify(value)) patch[name] = value;
        }
        if (Object.keys(patch).length) {
          appendEvent({ op: 'patch', id: current.id, set: { ...patch, updated: Date.now() } }, cwd);
          Object.assign(current, patch);
          updated.push(current);
        }
      } else {
        const unit = {
          id: nextShortId(g.nodes, TYPE_PREFIX.unit || 'u'),
          type: 'unit',
          status: 'active',
          ts: Date.now(),
          ...fields,
        };
        appendEvent({ op: 'node', node: unit }, cwd);
        g.nodes[unit.id] = unit; // keep id allocation and call resolution consistent
        created.push(unit);
      }
    }

    for (const [key, unit] of existing) {
      if (wanted.has(key)) continue;
      appendEvent({ op: 'patch', id: unit.id, set: { status: 'removed', updated: Date.now() } }, cwd);
      unit.status = 'removed';
      removed.push(unit.id);
    }

    // Resolve calls to known functions, same file first. External calls
    // (libc/kernel helpers) are simply not represented as edges.
    const bySymbol = new Map();
    for (const unit of unitsOf(g)) {
      if (unit.status === 'removed' || unit.kind !== 'function') continue;
      if (!bySymbol.has(unit.symbol)) bySymbol.set(unit.symbol, []);
      bySymbol.get(unit.symbol).push(unit);
    }
    const knownEdges = new Set(Object.keys(g.edges));
    const edges = [];
    for (const unit of unitsOf(g)) {
      if (unit.status === 'removed' || unit.kind !== 'function') continue;
      for (const name of unit.calls || []) {
        const targets = bySymbol.get(name);
        if (!targets?.length) continue;
        const target = targets.find((candidate) => candidate.file === unit.file) || targets[0];
        if (!target || target.id === unit.id) continue;
        const id = edgeId(unit.id, target.id, 'calls');
        if (knownEdges.has(id)) continue;
        knownEdges.add(id);
        const edge = { id, from: unit.id, to: target.id, kind: 'calls', ts: Date.now() };
        appendEvent({ op: 'edge', edge }, cwd);
        edges.push(edge);
      }
    }

    return { file, created, updated, removed, edges };
  }, cwd);
}

/** Create heuristic stage nodes and their step-before / implements edges. */
export function addStageChain(stages, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const createdStages = [];
    const createdEdges = [];
    let previous = null;
    for (const stage of stages) {
      if (!stage.units?.length) continue;
      const node = {
        id: nextShortId(g.nodes, TYPE_PREFIX.stage || 'st'),
        type: 'stage',
        title: stage.title,
        phase: stage.phase,
        status: 'active',
        detail: stage.detail || '',
        ts: Date.now(),
      };
      appendEvent({ op: 'node', node }, cwd);
      g.nodes[node.id] = node;
      createdStages.push(node);
      if (previous) {
        const id = edgeId(previous.id, node.id, 'step-before');
        if (!g.edges[id]) {
          const edge = { id, from: previous.id, to: node.id, kind: 'step-before', ts: Date.now() };
          appendEvent({ op: 'edge', edge }, cwd);
          createdEdges.push(edge);
        }
      }
      for (const unit of stage.units) {
        if (!g.nodes[unit.id]) continue;
        const id = edgeId(unit.id, node.id, 'implements');
        if (g.edges[id]) continue;
        const edge = { id, from: unit.id, to: node.id, kind: 'implements', ts: Date.now() };
        appendEvent({ op: 'edge', edge }, cwd);
        createdEdges.push(edge);
      }
      previous = node;
    }
    return { stages: createdStages, edges: createdEdges };
  }, cwd);
}

/** Append a validated, hash-stamped lesson. */
export function addLesson(input, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const { lesson, errors, warnings } = validateLesson(g, input);
    if (errors.length) {
      const error = new Error(`invalid lesson:\n- ${errors.join('\n- ')}`);
      error.errors = errors;
      error.warnings = warnings;
      throw error;
    }
    const record = { id: nextShortId(g.lessons, 'ls'), ts: Date.now(), ...stampLesson(lesson, g) };
    appendEvent({ op: 'lesson', lesson: record }, cwd);
    return { lesson: record, warnings };
  }, cwd);
}

export function addRequest(input, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const question = String(input.question || '').trim();
    if (!question) throw new Error('request.question is required');
    const request = {
      id: nextShortId(g.requests, 'rq'),
      question: question.slice(0, 4000),
      unitId: input.unitId || null,
      file: input.file || null,
      startLine: Number(input.startLine) || null,
      endLine: Number(input.endLine) || null,
      agentId: input.agentId || 'agent:primary',
      status: 'open',
      at: Date.now(),
    };
    if (request.unitId && !g.nodes[request.unitId]) throw new Error(`no such unit: ${request.unitId}`);
    appendEvent({ op: 'request', request }, cwd);
    return request;
  }, cwd);
}

export function replyRequest(requestRef, input = {}, cwd = process.cwd()) {
  return withLock(() => {
    const g = replay(cwd);
    const requestId = resolveRef(g.requests, requestRef, 'request');
    const text = String(input.text || '').trim();
    if (!text) throw new Error('reply.text is required');
    const reply = {
      id: nextShortId(g.replies, 'rp'),
      requestId,
      text: text.slice(0, 12000),
      author: input.author || 'agent:primary',
      at: Date.now(),
    };
    if (input.thinking) reply.thinking = String(input.thinking).slice(0, 20000);
    if (input.runtime) reply.runtime = String(input.runtime).slice(0, 40);
    if (input.stopped) reply.stopped = true;
    if (input.stopReason) reply.stopReason = String(input.stopReason).slice(0, 40);
    if (input.tools?.length) reply.tools = input.tools.slice(0, 40).map((tool) => ({
      name: String(tool.name || 'tool').slice(0, 120),
      detail: String(tool.detail || '').slice(0, 2000),
    }));
    appendEvent({ op: 'reply', reply }, cwd);
    return reply;
  }, cwd);
}

/** Resolve a board-relative code path, refusing anything outside the board root. */
export function resolveCodePath(root, relPath) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(relPath || ''));
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('path escapes board root');
  let realBase = base;
  try { realBase = fs.realpathSync(base); } catch { /* board root may not exist yet */ }
  // realBase can differ from base when the temp/board path goes through a
  // symlink (macOS /var → /private/var). Only compare real paths when the
  // target actually exists; a missing file is a 404, not a traversal.
  let realAbs = null;
  try { realAbs = fs.realpathSync(abs); } catch { /* keep the lexical check above */ }
  if (realAbs && realAbs !== realBase && !realAbs.startsWith(realBase + path.sep)) throw new Error('path escapes board root');
  return abs;
}

/** Read a bounded line window plus the current content hash. */
export function readCodeFile(root, relPath, { start = 1, end = null, maxLines = 4000 } = {}) {
  const abs = resolveCodePath(root, relPath);
  let stat;
  try { stat = fs.statSync(abs); } catch { return null; }
  if (!stat.isFile() || stat.size > 4_000_000) return null;
  const text = fs.readFileSync(abs, 'utf8');
  const all = text.split('\n');
  const s = Math.max(1, Math.min(all.length, Number(start) || 1));
  const requestedEnd = Number(end) || all.length;
  const e = Math.max(s, Math.min(all.length, requestedEnd, s + maxLines - 1));
  return {
    path: String(relPath),
    hash: crypto.createHash('sha256').update(text).digest('hex'),
    lines: all.length,
    start: s,
    end: e,
    slice: all.slice(s - 1, e).map((line, index) => ({ line: s + index, text: line })),
  };
}

export function setMeta(set, cwd = process.cwd()) {
  return withLock(() => {
    const state = readState(cwd);
    if (set.title !== undefined) state.title = set.title;
    if (set.session !== undefined) state.session = set.session;
    appendEvent({ op: 'meta', set }, cwd);
    saveState(state, cwd);
    return state;
  }, cwd);
}

export function reset(cwd = process.cwd()) {
  return withLock(() => {
    appendEvent({ op: 'reset' }, cwd);
    const state = defaultState();
    saveState(state, cwd);
    return state;
  }, cwd);
}

export function stats(g) {
  const byType = {};
  const intents = { open: 0, active: 0, done: 0, blocked: 0, dead: 0 };
  const vulns = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const confidence = { suspected: 0, 'static-confirmed': 0, reproduced: 0, confirmed: 0, unspecified: 0 };
  const live = Object.values(g.nodes).filter((node) => node.status !== 'removed');
  const liveIds = new Set(live.map((node) => node.id));
  for (const n of live) {
    byType[n.type] = (byType[n.type] || 0) + 1;
    if (n.type === 'intent') intents[n.status || 'open'] = (intents[n.status || 'open'] || 0) + 1;
    if (['vuln', 'finding'].includes(n.type) && n.severity && n.status !== 'superseded') {
      vulns[n.severity] = (vulns[n.severity] || 0) + 1;
      const level = n.confidence || 'unspecified';
      confidence[level] = (confidence[level] || 0) + 1;
    }
  }
  const openNodes = live.filter((n) =>
    ['intent', 'hypothesis', 'question'].includes(n.type) &&
    ['open', 'active', 'blocked'].includes(n.status || 'open'));
  // Teaching counters are additive; they stay 0 on pentest boards.
  const teaching = coverage(g);
  return {
    total: live.length,
    edges: Object.values(g.edges).filter((edge) => liveIds.has(edge.from) && liveIds.has(edge.to)).length,
    activities: Object.keys(g.activities || {}).length,
    checkpoints: Object.keys(g.checkpoints || {}).length,
    cursors: Object.keys(g.cursors || {}).length,
    byType, intents, vulns, confidence,
    frontier: openNodes.length,
    confirmed: live.filter((n) =>
      ['vuln', 'finding'].includes(n.type) && n.status !== 'superseded' &&
      (!n.confidence || ['reproduced', 'confirmed'].includes(n.confidence))).length,
    candidates: live.filter((n) =>
      ['vuln', 'finding'].includes(n.type) && n.status !== 'superseded' &&
      ['suspected', 'static-confirmed'].includes(n.confidence)).length,
    units: unitsOf(g).filter((unit) => unit.status !== 'removed').length,
    learned: unitsOf(g).filter((unit) => unit.status !== 'removed' && unit.learned).length,
    stages: Object.values(g.nodes).filter((n) => n.type === 'stage' && n.status !== 'removed').length,
    lessons: teaching.lessons.total,
    answers: Object.keys(g.replies || {}).length,
    requests: teaching.requests,
    coverage: teaching.units,
  };
}
