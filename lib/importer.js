// Code ingestion: walk files, parse them, and write files/units/edges/chain.
//
// Kept separate from lib/store.js so the event store stays domain-agnostic and
// the pentest workflow never pays for teaching code paths.

import fs from 'node:fs';
import path from 'node:path';
import { parseSource, languageOf, hashContent, suggestChain, LANG_BY_EXT } from './code.js';
import {
  addFile, upsertUnits, addStageChain, replay, stats,
} from './store.js';
import { unitsOf } from './model.js';

export const DEFAULT_IGNORE = new Set([
  '.git', '.flow', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', 'target', 'vendor', '.claude', '.agents', '.idea', '.vscode',
]);

export const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANG_BY_EXT));
// Teaching content (lesson JSON, notes, templates) is not source code; keep it
// out of the unit graph even when it sits next to the exploit.
export const CODE_EXTENSIONS = new Set([
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.py', '.js', '.mjs', '.ts',
  '.sh', '.bash', '.S', '.s',
]);

function isSupported(file) {
  const ext = path.extname(file);
  return CODE_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext.toLowerCase());
}

/** Collect importable files under `target` (file or directory), deterministic order. */
export function collectFiles(target, { ignore = DEFAULT_IGNORE, maxFiles = 500 } = {}) {
  const abs = path.resolve(target);
  const found = [];
  const skipped = [];

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      skipped.push({ path: dir, reason: error.message });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isSupported(entry.name)) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      if (size > 2_000_000) {
        skipped.push({ path: full, reason: `larger than 2MB (${size} bytes)` });
        continue;
      }
      found.push(full);
      if (found.length >= maxFiles) return;
    }
  };

  let stat;
  try { stat = fs.statSync(abs); } catch (error) {
    throw new Error(`path does not exist: ${target} (${error.code || error.message})`);
  }
  if (stat.isDirectory()) walk(abs);
  else if (stat.isFile()) {
    if (isSupported(abs)) found.push(abs);
    else skipped.push({ path: abs, reason: `unsupported extension (${path.extname(abs) || 'none'})` });
  } else {
    throw new Error(`not a file or directory: ${target}`);
  }
  return { root: stat.isDirectory() ? abs : path.dirname(abs), files: found.slice(0, maxFiles), skipped };
}

function relPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * Import a file or directory into an existing board.
 * Returns a summary; individual file failures are reported, not fatal.
 */
export function importCode(cwd, target, { chain = false, lang = null, ignore = DEFAULT_IGNORE } = {}) {
  const { root, files, skipped } = collectFiles(target, { ignore });
  const boardRoot = path.resolve(cwd);
  const results = [];
  for (const file of files) {
    // Anchors must stay readable later (serve/export), so code has to live
    // inside the board root. Importing an external tree is a clear error
    // instead of producing units that point at unreadable paths.
    const rel = path.relative(boardRoot, file).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      skipped.push({ path: file, reason: `outside board root ${boardRoot}; init the board in the project that contains the code` });
      continue;
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const language = lang || languageOf(rel);
      const parsed = parseSource(text, { path: rel, lang: language });
      const record = addFile({
        path: rel,
        lang: parsed.lang,
        hash: parsed.hash,
        lines: parsed.lines,
        bytes: Buffer.byteLength(text),
        includes: parsed.includes,
      }, cwd);
      const written = upsertUnits(record, parsed.units, cwd);
      results.push({
        path: rel,
        lang: parsed.lang,
        lines: parsed.lines,
        units: parsed.units.length,
        created: written.created.length,
        updated: written.updated.length,
        removed: written.removed.length,
        edges: written.edges.length,
        includes: parsed.includes,
      });
    } catch (error) {
      skipped.push({ path: file, reason: error.message });
    }
  }

  let chainResult = null;
  if (chain) {
    const g = replay(cwd);
    const existingStages = Object.values(g.nodes).filter((node) => node.type === 'stage');
    if (existingStages.length) {
      chainResult = { skipped: true, reason: "board already has stage nodes; run 'blackboard chain rm' or edit them instead" };
    } else {
      const suggested = suggestChain(unitsOf(g));
      chainResult = addStageChain(suggested.map((stage) => ({
        phase: stage.phase,
        title: stage.title,
        units: stage.units.filter((unit) => unit.id && unit.status !== 'removed'),
      })), cwd);
    }
  }

  const board = replay(cwd);
  return {
    root,
    files: results,
    skipped,
    chain: chainResult,
    stats: stats(board),
    coverage: stats(board).coverage,
    hash: hashContent(files.join('\n')),
  };
}
