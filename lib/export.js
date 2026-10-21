// Export the whole viewer as one self-contained HTML file: chrome, renderer and
// the current graph snapshot inlined. No server, no network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, readState, stats, readCodeFile } from './store.js';
import { buildDigest } from './digest.js';
import { coverage } from './teach.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');

function read(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

function inlineBuiltAssets(html) {
  let output = html;
  output = output.replace(/<link rel="stylesheet"[^>]*href="\/([^"?]+)"[^>]*>/g, (_tag, href) => {
    return `<style>\n${read(href)}\n</style>`;
  });
  output = output.replace(/<script[^>]*src="\/([^"?]+)"[^>]*><\/script>/g, (_tag, src) => {
    const js = read(src).replace(/<\/script/gi, '<\\/script');
    // Preserve module/deferred execution: Vite places the entry in <head>,
    // so an eager classic script would run before #root exists.
    return `<script type="module">\n${js}\n</script>`;
  });
  return output;
}

export function renderExport({ cwd = process.cwd() } = {}) {
  const g = replay(cwd);
  const state = readState(cwd);
  const snap = {
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
    // Export activity metadata only; raw tool input/output may contain secrets.
    activities: Object.fromEntries(
      Object.values(g.activities).map((a) => [a.id, {
        id: a.id,
        tool: a.tool,
        status: a.status,
        at: a.at,
        linkedNodeIds: a.linkedNodeIds,
      }]),
    ),
    checkpoints: g.checkpoints,
    files: g.files,
    lessons: g.lessons,
    requests: g.requests,
    replies: g.replies,
    coverage: coverage(g),
    // Offline code: lessons point at files, so the export carries the content
    // they annotate. Bounded, because an export must stay a single HTML file.
    code: {},
    codeOmitted: [],
    stats: stats(g),
    digest: buildDigest(g, cwd),
  };

  const CODE_BUDGET = 1_500_000;
  const wanted = new Set();
  for (const unit of Object.values(g.nodes)) {
    if (unit.type === 'unit' && unit.file) wanted.add(unit.file);
  }
  for (const lesson of Object.values(g.lessons || {})) {
    if (lesson.target?.file) wanted.add(lesson.target.file);
    for (const range of lesson.target?.lines || []) wanted.add(range.file);
    for (const note of lesson.lineNotes || []) wanted.add(note.file);
    if (lesson.target?.unit) {
      const unit = g.nodes[lesson.target.unit];
      if (unit?.file) wanted.add(unit.file);
    }
  }
  let used = 0;
  for (const file of [...wanted].sort()) {
    let slice = null;
    try { slice = readCodeFile(cwd, file, { start: 1, maxLines: 4000 }); } catch { slice = null; }
    if (!slice) {
      snap.codeOmitted.push(file);
      continue;
    }
    const content = slice.slice.map((line) => line.text);
    const bytes = content.join('\n').length;
    if (used + bytes > CODE_BUDGET) {
      snap.codeOmitted.push(file);
      continue;
    }
    used += bytes;
    snap.code[file] = {
      path: file,
      hash: slice.hash,
      lines: slice.lines,
      truncated: slice.end < slice.lines,
      content,
    };
  }

  const html = read('index.html');

  const data = JSON.stringify(snap).replace(/</g, '\\u003c');
  const inline = `<script>
window.__BLACKBOARD_DATA__ = ${data};
try { document.documentElement.setAttribute('data-theme', 'light'); } catch (e) {}
</script>`;

  return inlineBuiltAssets(html)
    .replace('<head>', `<head>\n${inline}`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(snap.meta.title || 'blackboard')} — 思考工作台</title>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
