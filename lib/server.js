// Live server: serves the viewer, the graph snapshot, and an SSE stream that
// ticks whenever the event log grows.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, isInitialized, ensure, replay, readEvents, readState, stats, readCodeFile, addRequest, replyRequest, setLearned } from './store.js';
import { buildDigest } from './digest.js';
import { buildAgentContext } from './context.js';
import { coverage } from './teach.js';
import { renderExport } from './export.js';
import { drawioXml, xmindZip } from './export-diagram.js';
import { importCode } from './importer.js';
import { fetchIntoBoard, slugify } from './source.js';
import { setMeta, setUnitRoles, addChain, addLesson } from './store.js';
import { unitsOf, orderedStages } from './model.js';
import { lessonsForUnit, lessonBrief } from './teach.js';
import {
  runAgent, loadAgentConfig, publicAgentConfig, saveAgentConfig, isConfigured, buildAgentPrompt,
} from './agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');
const MAX_REQUEST_BODY = 8 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function snapshot(cwd) {
  const g = replay(cwd);
  const state = readState(cwd);
  return {
    meta: {
      ...g.meta,
      title: g.meta.title || state.title,
      focus: g.meta.focus || state.focus,
      session: state.session,
    },
    nodes: g.nodes,
    edges: g.edges,
    cursors: g.cursors,
    cursorTrail: g.cursorTrail.slice(-100),
    activities: g.activities,
    checkpoints: g.checkpoints,
    // Teaching-board side tables. Empty objects on pentest boards, so the
    // snapshot shape only grows by empty keys.
    files: g.files,
    lessons: g.lessons,
    requests: g.requests,
    replies: g.replies,
    coverage: coverage(g),
    // A student request needs a same-origin capability token; the random value
    // is per process and never persisted.
    requestToken: REQUEST_TOKEN,
    stats: stats(g),
    digest: buildDigest(g, cwd),
  };
}

// Per-process capability for POST /api/request. A cross-origin form post cannot
// read the token (no CORS headers), and a JSON fetch triggers a preflight that
// this server refuses.
const REQUEST_TOKEN = `bb_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

function readBody(req, limit = MAX_REQUEST_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI and same-origin fetches may omit it
  try {
    const host = new URL(origin).host;
    return host === req.headers.host;
  } catch {
    return false;
  }
}


/** Shared guard for the token-protected JSON write endpoints. */
async function guardedJson(req, res, limit = 64 * 1024) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return null;
  }
  if (!sameOrigin(req) || req.headers['x-blackboard-request'] !== REQUEST_TOKEN) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return null;
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'expected application/json' }));
    return null;
  }
  try {
    return JSON.parse(await readBody(req, limit));
  } catch (error) {
    res.writeHead(error.message === 'body too large' ? 413 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid_json', detail: error.message }));
    return null;
  }
}

function receiveUpload(req, file, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const stream = fs.createWriteStream(file);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('upload too large'));
        req.destroy();
        stream.destroy();
      }
    });
    req.pipe(stream);
    stream.on('finish', () => resolve(size));
    stream.on('error', reject);
    req.on('error', reject);
  });
}

async function importFetched(cwd, fetched) {
  const result = importCode(cwd, fetched.dir);
  setMeta({
    source: fetched.label,
    sourceKind: fetched.kind,
    sourcePath: path.relative(cwd, fetched.dir),
  }, cwd);
  const g = replay(cwd);
  return {
    source: { kind: fetched.kind, label: fetched.label, path: path.relative(cwd, fetched.dir) },
    files: result.files.map((file) => ({ path: file.path, units: file.units, created: file.created, updated: file.updated, removed: file.removed })),
    skipped: result.skipped,
    stats: stats(g),
  };
}


/** Compact read-only context handed to an in-page Agent runtime. */
function boardContextForAgent(cwd, { unitId = null, file = null, startLine = null, endLine = null } = {}) {
  const g = replay(cwd);
  const lines = [];
  const units = unitsOf(g).filter((unit) => unit.status !== 'removed' && unit.kind !== 'macro');
  lines.push(`黑板：${g.meta.title || '(untitled)'} · 代码单元 ${units.length} · 讲解 ${Object.keys(g.lessons || {}).length}`);
  const stages = orderedStages(g);
  if (stages.length) {
    lines.push('攻击链（Agent 自定义）：');
    stages.forEach((stage, index) => lines.push(`${index + 1}. ${stage.title}${stage.phase ? ` · ${stage.phase}` : ''}`));
  }
  const focus = unitId ? g.nodes[unitId] : null;
  if (focus) {
    lines.push('', `当前选中：${focus.id} ${focus.symbol || focus.title} · ${focus.file}:${focus.startLine}-${focus.endLine}`);
    if (focus.role) lines.push(`作用：${focus.role}`);
    if (focus.learned) lines.push('学习状态：已标记学习完毕');
    try {
      const slice = readCodeFile(cwd, focus.file, { start: focus.startLine, end: focus.endLine, maxLines: 140 });
      if (slice) {
        lines.push('实现：', '```c');
        for (const line of slice.slice) lines.push(`${line.line}: ${line.text}`);
        lines.push('```');
      }
    } catch { /* code may have moved */ }
    const lessons = lessonsForUnit(g, focus.id);
    if (lessons.length) lines.push(`已有讲解：${lessons.map((lesson) => `${lesson.id} ${lessonBrief(lesson).title}`).join('；')}`);
  } else if (file) {
    try {
      const slice = readCodeFile(cwd, file, { start: startLine || 1, end: endLine || null, maxLines: 140 });
      if (slice) {
        lines.push('', `当前代码：${file}:${slice.start}-${slice.end}`, '```c');
        for (const line of slice.slice) lines.push(`${line.line}: ${line.text}`);
        lines.push('```');
      }
    } catch { /* ignore */ }
  }
  lines.push('', `黑板 CLI：node ${path.resolve(HERE, '..', 'bin', 'flow.js')}`, `项目根目录（当前工作目录）：${cwd}`);
  return lines.join('\n').slice(0, 14000);
}

export function startServer({ cwd = process.cwd(), port = 4317, open = false, projectsRoot = null }) {
  // Project mode: one server serves a directory of boards and keeps one active.
  // Switching is a server-wide operation; this is a local single-user tool.
  let projectsDir = projectsRoot ? path.resolve(projectsRoot) : null;
  let projectId = null;
  const projectDirs = () => {
    if (!projectsDir) return [];
    try {
      return fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(projectsDir, entry.name, '.flow')))
        .map((entry) => entry.name)
        .sort();
    } catch { return []; }
  };
  const activeFile = () => path.join(projectsDir, '.active');
  const writeActive = (id) => { try { fs.writeFileSync(activeFile(), id); } catch { /* ignore */ } };
  const readActive = () => { try { return fs.readFileSync(activeFile(), 'utf8').trim(); } catch { return ''; } };
  const projectSummary = (id) => {
    const dir = path.join(projectsDir, id);
    const g = replay(dir);
    const units = Object.values(g.nodes).filter((node) => node.type === 'unit' && node.status !== 'removed' && node.kind !== 'macro');
    const stages = orderedStages(g).length;
    const lessons = Object.keys(g.lessons || {}).length;
    const annotated = units.filter((unit) => unit.role).length;
    const analyzed = stages > 0 || lessons > 0 || annotated > 0;
    let updatedAt = 0;
    try { updatedAt = fs.statSync(paths(dir).events).mtimeMs; } catch { /* ignore */ }
    return {
      id,
      title: g.meta.title || id,
      units: units.length,
      annotated,
      stages,
      lessons,
      status: units.length === 0 ? 'empty' : analyzed ? 'analyzed' : 'pending',
      updatedAt,
      active: id === projectId,
    };
  };

  if (projectsDir) {
    fs.mkdirSync(projectsDir, { recursive: true });
    let ids = projectDirs();
    let wanted = readActive();
    if (!wanted || !ids.includes(wanted)) wanted = ids[0] || null;
    if (!wanted) {
      wanted = 'project-1';
      const dir = path.join(projectsDir, wanted);
      fs.mkdirSync(dir, { recursive: true });
      ensure(dir);
      setMeta({ title: '未命名项目' }, dir);
    }
    projectId = wanted;
    cwd = path.join(projectsDir, wanted);
    ensure(cwd);
    writeActive(wanted);
  } else if (!isInitialized(cwd)) {
    throw new Error('当前目录没有 .flow/，先运行 blackboard init');
  }
  const clients = new Set();
  const agentSessions = new Map();
  let lastMtime = 0;
  let lastSize = 0;

  const tick = () => {
    try {
      const p = paths(cwd);
      const st = fs.statSync(p.events);
      if (st.mtimeMs === lastMtime && st.size === lastSize) return;
      lastMtime = st.mtimeMs;
      lastSize = st.size;
      const data = JSON.stringify(snapshot(cwd));
      for (const res of clients) {
        res.write(`event: graph\ndata: ${data}\n\n`);
      }
    } catch {}
  };

  const tickTimer = setInterval(tick, 250);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: graph\ndata: ${JSON.stringify(snapshot(cwd))}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }


    if (p === '/api/projects') {
      if (!projectsDir) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ enabled: false, projects: [] }));
      }
      if (req.method === 'GET') {
        const projects = projectDirs().map(projectSummary);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ enabled: true, active: projectId, projects }));
      }
      const payload = await guardedJson(req, res, 16 * 1024);
      if (!payload) return;
      const name = String(payload.name || '').trim().slice(0, 80) || '未命名项目';
      const base = slugify(name) || 'project';
      let id = base;
      let n = 2;
      while (fs.existsSync(path.join(projectsDir, id))) { id = `${base}-${n}`; n += 1; }
      const dir = path.join(projectsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      ensure(dir);
      setMeta({ title: name }, dir);
      projectId = id;
      cwd = dir;
      lastMtime = 0; lastSize = 0;
      writeActive(id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ project: projectSummary(id) }));
    }


    if (p === '/api/projects/delete') {
      if (!projectsDir) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'projects_disabled' }));
      }
      const payload = await guardedJson(req, res, 16 * 1024);
      if (!payload) return;
      const id = String(payload.id || '');
      const ids = projectDirs();
      if (!ids.includes(id) || path.basename(id) !== id) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'project_not_found' }));
      }
      if (ids.length <= 1) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'last_project', detail: '至少保留一个项目' }));
      }
      if (id === projectId) {
        const next = ids.find((candidate) => candidate !== id);
        projectId = next;
        cwd = path.join(projectsDir, next);
        ensure(cwd);
        writeActive(next);
        lastMtime = 0; lastSize = 0;
      }
      try {
        fs.rmSync(path.join(projectsDir, id), { recursive: true, force: true });
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'delete_failed', detail: error.message }));
      }
      writeActive(projectId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ deleted: id, active: projectId }));
    }

    if (p === '/api/projects/switch') {
      if (!projectsDir) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'projects_disabled' }));
      }
      const payload = await guardedJson(req, res, 16 * 1024);
      if (!payload) return;
      const id = String(payload.id || '');
      if (!projectDirs().includes(id)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'project_not_found' }));
      }
      projectId = id;
      cwd = path.join(projectsDir, id);
      ensure(cwd);
      lastMtime = 0; lastSize = 0;
      writeActive(id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ project: projectSummary(id) }));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD'
      && !['/api/request', '/api/progress', '/api/import', '/api/import/upload', '/api/roles', '/api/chain', '/api/lesson',
        '/api/agent/settings', '/api/agent/stream', '/api/agent/stop', '/api/projects', '/api/projects/switch', '/api/projects/delete', '/api/request/cancel'].includes(p)) {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' });
      return res.end(JSON.stringify({ error: 'method_not_allowed' }));
    }

    // A student question is the only write the viewer can perform. It is
    // guarded by same-origin + a per-process token, so a hostile page cannot
    // post to a localhost board even though the server has no accounts.
    if (p === '/api/request') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
        return res.end(JSON.stringify({ error: 'method_not_allowed' }));
      }
      if (!sameOrigin(req) || req.headers['x-blackboard-request'] !== REQUEST_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'expected application/json' }));
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_json', detail: error.message }));
      }
      try {
        const request = addRequest({
          question: payload.question,
          unitId: payload.unitId || null,
          file: payload.file || null,
          startLine: payload.startLine || null,
          endLine: payload.endLine || null,
          agentId: 'agent:web',
        }, cwd);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ request }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_request', detail: error.message }));
      }
    }


    if (p === '/api/request/cancel') {
      const payload = await guardedJson(req, res, 8 * 1024);
      if (!payload) return;
      const id = String(payload.id || '');
      const g = replay(cwd);
      if (!g.requests?.[id]) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'request_not_found' }));
      }
      if (Object.values(g.replies || {}).some((reply) => reply.requestId === id)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ already: true, id }));
      }
      try {
        replyRequest(id, { text: '（已取消等待，可重新发起分析或提问）', author: 'system' }, cwd);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'cancel_failed', detail: error.message }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ cancelled: true, id }));
    }

    // Marking a unit as learned is the second (and only other) student write.
    if (p === '/api/progress') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
        return res.end(JSON.stringify({ error: 'method_not_allowed' }));
      }
      if (!sameOrigin(req) || req.headers['x-blackboard-request'] !== REQUEST_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'expected application/json' }));
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_json', detail: error.message }));
      }
      try {
        const unit = setLearned(payload.unitId, payload.learned !== false, cwd);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ unit: { id: unit.id, learned: Boolean(unit.learned), learnedAt: unit.learnedAt || null } }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_progress', detail: error.message }));
      }
    }


    if (p === '/api/import') {
      const payload = await guardedJson(req, res, 32 * 1024);
      if (!payload) return;
      if (!payload.source || typeof payload.source !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'source_required' }));
      }
      try {
        const fetched = await fetchIntoBoard(payload.source, { cwd, dest: payload.dest || null });
        const result = await importFetched(cwd, fetched);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'import_failed', detail: error.message }));
      }
    }

    if (p === '/api/import/upload') {
      if (req.method !== 'POST' || !sameOrigin(req) || req.headers['x-blackboard-request'] !== REQUEST_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
      const name = String(req.headers['x-filename'] || 'poc.zip');
      if (!/\.(zip|tar\.gz|tgz)$/i.test(name)) {
        res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'expected_archive', detail: 'upload a .zip / .tar.gz / .tgz' }));
      }
      const tmp = path.join(paths(cwd).root, 'sources', `.upload-${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      try {
        await receiveUpload(req, tmp, 200 * 1024 * 1024);
        const fetched = await fetchIntoBoard(tmp, { cwd, dest: slugify(name) });
        const result = await importFetched(cwd, fetched);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'upload_failed', detail: error.message }));
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    }

    if (p === '/api/roles') {
      const payload = await guardedJson(req, res, 256 * 1024);
      if (!payload) return;
      try {
        const updated = setUnitRoles(payload.roles || {}, cwd);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ updated }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_roles', detail: error.message }));
      }
    }

    if (p === '/api/chain') {
      const payload = await guardedJson(req, res, 256 * 1024);
      if (!payload) return;
      try {
        const result = addChain(payload.stages, { replace: payload.replace !== false }, cwd);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_chain', detail: error.message }));
      }
    }

    if (p === '/api/lesson') {
      const payload = await guardedJson(req, res, 512 * 1024);
      if (!payload) return;
      try {
        const result = addLesson(payload.lesson || payload, cwd);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_lesson', detail: error.message, errors: error.errors || [] }));
      }
    }


    if (p === '/api/export/drawio' || p === '/api/export/xmind') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' });
        return res.end(JSON.stringify({ error: 'method_not_allowed' }));
      }
      const group = url.searchParams.get('group') === 'file' ? 'file' : 'stage';
      const stage = url.searchParams.get('stage') || null;
      const g = replay(cwd);
      const title = String(g.meta.title || 'blackboard').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
      const suffix = stage ? '当前阶段' : group === 'file' ? '文件模块' : '攻击阶段';
      if (p.endsWith('/drawio')) {
        const body = drawioXml(g, group, stage);
        res.writeHead(200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="blackboard-modules.drawio"; filename*=UTF-8''${encodeURIComponent(title)}-${encodeURIComponent(suffix)}.drawio`,
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }
      const body = xmindZip(g, group, stage);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="blackboard-modules.xmind"; filename*=UTF-8''${encodeURIComponent(title)}-${encodeURIComponent(suffix)}.xmind`,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    if (p === '/api/export') {
      try {
        const html = renderExport({ cwd });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="blackboard.html"',
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'export_failed', detail: error.message }));
      }
    }


    if (p === '/api/agent/settings') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(publicAgentConfig(cwd)));
      }
      const payload = await guardedJson(req, res, 64 * 1024);
      if (!payload) return;
      try {
        const config = saveAgentConfig(cwd, payload);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(config));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_settings', detail: error.message }));
      }
    }

    if (p === '/api/agent/stop') {
      const payload = await guardedJson(req, res, 8 * 1024);
      if (!payload) return;
      const session = agentSessions.get(String(payload.sessionId || ''));
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'session_not_found' }));
      }
      session.stopped = true;
      session.reason = 'stopped';
      try { session.abort.abort(); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ stopped: true, sessionId: payload.sessionId }));
    }

    if (p === '/api/agent/stream') {
      const payload = await guardedJson(req, res, 256 * 1024);
      if (!payload) return;
      const question = String(payload.question || '').trim();
      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'question_required' }));
      }
      const config = loadAgentConfig(cwd);
      if (config.runtime === 'external') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'external_runtime', detail: '在设置里选择模型 API 或本地 CLI，外部轮询请用 /api/request' }));
      }
      if (!isConfigured(config)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'not_configured', detail: '请先在 Agent 设置里填写模型/CLI' }));
      }
      let request;
      try {
        request = addRequest({
          question,
          unitId: payload.unitId || null,
          file: payload.file || null,
          startLine: payload.startLine || null,
          endLine: payload.endLine || null,
          agentId: 'agent:web',
        }, cwd);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_request', detail: error.message }));
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event, data) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
      };
      const sessionId = `ags_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const abort = new AbortController();
      const session = { abort, stopped: false, reason: null };
      agentSessions.set(sessionId, session);
      send('start', { sessionId, requestId: request.id, runtime: config.runtime });

      let text = '';
      let thinking = '';
      let tools = [];
      let finished = false;
      const timeoutMs = config.runtime === 'cli' ? 35 * 60 * 1000 : 10 * 60 * 1000;
      const timeout = setTimeout(() => { session.stopped = true; session.reason = 'timeout'; abort.abort(); }, timeoutMs);
      const onEvent = (event) => {
        if (event.type === 'text') { text += event.delta; send('text', { delta: event.delta }); }
        else if (event.type === 'thinking') { thinking += event.delta; send('thinking', { delta: event.delta }); }
        else if (event.type === 'tool') { tools.push({ name: event.name, detail: event.detail }); send('tool', { name: event.name, detail: event.detail }); }
      };

      const context = boardContextForAgent(cwd, {
        unitId: payload.unitId || null,
        file: payload.file || null,
        startLine: payload.startLine || null,
        endLine: payload.endLine || null,
      });
      const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];
      const prompt = buildAgentPrompt({ question, boardContext: context, history });
      const messages = [
        { role: 'system', content: config.api.systemPrompt || '' },
        { role: 'user', content: prompt },
      ];

      Promise.resolve()
        .then(() => runAgent(config, { prompt, messages, cwd, signal: abort.signal, onEvent }))
        .then((result) => {
          finished = true;
          clearTimeout(timeout);
          text = result.text || text;
          thinking = result.thinking || thinking;
          tools = result.tools?.length ? result.tools : tools;
          if (session.stopped || abort.signal.aborted) {
            if (text) replyRequest(request.id, { text, thinking, tools, runtime: config.runtime, stopped: true, stopReason: session.reason || 'stopped' }, cwd);
            send('stopped', { text, thinking, tools, reason: session.reason || 'stopped' });
            return;
          }
          if (!text) throw new Error('模型没有返回文本');
          const reply = replyRequest(request.id, { text, thinking, tools, runtime: config.runtime }, cwd);
          send('done', { replyId: reply.id, text, thinking, tools });
        })
        .catch((error) => {
          finished = true;
          clearTimeout(timeout);
          if (session.stopped || abort.signal.aborted) {
            if (text) replyRequest(request.id, { text, thinking, tools: [],
              runtime: config.runtime, stopped: true, stopReason: session.reason || 'stopped' }, cwd);
            send('stopped', { text, thinking, reason: session.reason || 'stopped' });
          } else {
            if (text) replyRequest(request.id, { text, thinking, tools, runtime: config.runtime, stopped: true }, cwd);
            send('error', { error: error.message || 'agent failed' });
          }
        })
        .finally(() => {
          agentSessions.delete(sessionId);
          if (!res.writableEnded) res.end();
        });

      req.on('close', () => {
        if (!finished) { session.stopped = true; session.reason = session.reason || 'disconnected'; abort.abort(); }
      });
      return;
    }

    if (p === '/api/file') {
      const rel = url.searchParams.get('path');
      if (!rel) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'path_required' }));
      }
      const start = Number(url.searchParams.get('start')) || 1;
      const end = Number(url.searchParams.get('end')) || null;
      let slice = null;
      let failure = null;
      try {
        slice = readCodeFile(cwd, rel, { start, end, maxLines: 4000 });
      } catch (error) {
        failure = error.message;
      }
      if (failure) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'invalid_path', detail: failure }));
      }
      if (!slice) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'file_not_readable', path: rel }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(slice));
    }

    if (p === '/api/context') {
      const g = replay(cwd);
      const focus = url.searchParams.get('focus') || null;
      if (focus && !g.nodes[focus]) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ error: 'focus_not_found', focus }));
      }
      const body = JSON.stringify(buildAgentContext(g, {
        agentId: url.searchParams.get('agent') || 'agent:primary',
        focus,
        depth: url.searchParams.get('depth') ?? 2,
        budgetTokens: url.searchParams.get('budget') ?? 4000,
        since: url.searchParams.get('since') ?? undefined,
        maxItems: url.searchParams.get('limit') ?? undefined,
        readCode: (file, start, end) => readCodeFile(cwd, file, { start, end, maxLines: 200 }),
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    if (p === '/api/graph' || p === '/api/digest') {
      const snap = snapshot(cwd);
      const body = p === '/api/digest' ? JSON.stringify({ digest: snap.digest }) : JSON.stringify(snap);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    let file = p === '/' ? '/index.html' : p;
    const abs = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!abs.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (!fs.existsSync(abs)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
  });

  // Tests and `serve` shutdowns should not leave the process alive.
  server.on('close', () => clearInterval(tickTimer));

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = `http://127.0.0.1:${port}`;
      console.log(`blackboard 服务已启动  ${addr}`);
      console.log(`  图快照 ${addr}/api/graph · Agent 上下文 ${addr}/api/context · 摘要 ${addr}/api/digest · SSE ${addr}/events`);
      console.log(`  代码 ${addr}/api/file?path=… · 学生提问 POST ${addr}/api/request`);
      if (open) {
        import('node:child_process').then(({ exec }) => {
          const cmd =
            process.platform === 'darwin'
              ? `open "${addr}"`
              : process.platform === 'win32'
              ? `start "" "${addr}"`
              : `xdg-open "${addr}"`;
          exec(cmd);
        });
      }
      resolve(server);
    });
  });
}
