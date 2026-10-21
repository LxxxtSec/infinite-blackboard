// Fetch a PoC from a zip archive or a git repository into the board, so the
// student only has to hand the Agent a URL/archive. Nothing is executed here:
// archives are extracted into `.flow/sources/`, repos are cloned shallowly, and
// the importer only reads text files.
//
// Runtime dependencies stay at zero: git/unzip/tar are used when present, and
// remote archives are downloaded with Node's built-in fetch.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SOURCE_DIR = path.join('.flow', 'sources');
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export function slugify(value) {
  const base = String(value || 'source').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const name = base.split(/[/:]/).filter(Boolean).pop() || 'source';
  return name.replace(/\.(zip|tar\.gz|tgz|git)$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'source';
}

export function isGitUrl(value) {
  const text = String(value || '').trim();
  if (!text || /\s/.test(text)) return false;
  if (/^(git@|ssh:\/\/)/.test(text)) return true;
  if (/^(https?|file):\/\//.test(text)) {
    if (/\.(zip|tar\.gz|tgz)(\?.*)?$/i.test(text)) return false;
    return true;
  }
  return false;
}

export function isRemoteArchive(value) {
  return /^https?:\/\/.+\.(zip|tar\.gz|tgz)(\?.*)?$/i.test(String(value || '').trim());
}

export function archiveKind(file) {
  const name = String(file || '').toLowerCase();
  if (name.endsWith('.zip')) return 'zip';
  if (name.endsWith('.tar.gz')) return 'tar.gz';
  if (name.endsWith('.tgz')) return 'tar.gz';
  return null;
}

/** Detect what a student/Agent handed over, without touching the network. */
export function detectSource(input, { cwd = process.cwd(), shell = process.cwd() } = {}) {
  const text = String(input || '').trim();
  if (!text) return { kind: 'none', label: '' };
  if (isRemoteArchive(text)) return { kind: 'remote-archive', label: text, url: text };
  if (isGitUrl(text)) return { kind: 'git', label: text, url: text };
  const shellPath = path.resolve(shell, text);
  const boardPath = path.resolve(cwd, text);
  const local = fs.existsSync(shellPath) ? shellPath : fs.existsSync(boardPath) ? boardPath : shellPath;
  if (fs.existsSync(local) && fs.statSync(local).isFile() && archiveKind(local)) {
    return { kind: 'archive', label: text, path: local };
  }
  return { kind: 'local', label: text, path: local };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

export function unsafeEntries(entries) {
  const bad = [];
  for (const entry of entries) {
    const text = String(entry).trim();
    if (!text) continue;
    const normalized = text.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
      || normalized.split('/').includes('..')) {
      bad.push(text);
    }
  }
  return bad;
}

function assertInside(root, target) {
  const base = path.resolve(root);
  const abs = path.resolve(target);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`refusing to write outside ${base}: ${abs}`);
  return abs;
}

/** Remove symlinks that point outside the extracted tree (zip/tar can carry them). */
function sanitizeTree(root) {
  const base = path.resolve(root);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let real = null;
        try { real = fs.realpathSync(full); } catch { real = null; }
        if (!real || (real !== base && !real.startsWith(base + path.sep))) {
          try { fs.unlinkSync(full); } catch { /* best effort */ }
          continue;
        }
        continue;
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(base);
}

function extractZip(file, dest) {
  const entries = run('unzip', ['-Z1', file]).split('\n');
  const bad = unsafeEntries(entries);
  if (bad.length) throw new Error(`archive contains unsafe paths: ${bad.slice(0, 3).join(', ')}`);
  fs.mkdirSync(dest, { recursive: true });
  run('unzip', ['-q', '-o', file, '-d', dest]);
}

function extractTar(file, dest) {
  const entries = run('tar', ['-tzf', file]).split('\n');
  const bad = unsafeEntries(entries);
  if (bad.length) throw new Error(`archive contains unsafe paths: ${bad.slice(0, 3).join(', ')}`);
  fs.mkdirSync(dest, { recursive: true });
  run('tar', ['-xzf', file, '-C', dest, '--no-same-owner']);
}

async function download(url, destFile) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_ARCHIVE_BYTES) throw new Error(`archive is too large (${length} bytes)`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error(`archive is too large (${buffer.length} bytes)`);
  fs.writeFileSync(destFile, buffer);
}

/**
 * Resolve/fetch the input into a directory under the board root.
 * Returns { dir, kind, label, cached } — the caller imports `dir`.
 */
/**
 * Web-side import: local paths are copied into `.flow/sources/` first, so code
 * always lives under the board root; URLs/archives go through prepareSource.
 */
export async function fetchIntoBoard(input, { cwd = process.cwd(), dest = null } = {}) {
  const detected = detectSource(input, { cwd, shell: cwd });
  if (detected.kind === 'local') {
    if (!fs.existsSync(detected.path)) throw new Error(`path does not exist: ${input}`);
    const stat = fs.statSync(detected.path);
    if (stat.isDirectory()) {
      const dir = resolveDest(cwd, dest || slugify(detected.path), true);
      fs.cpSync(detected.path, dir, {
        recursive: true,
        filter: (source) => !/(^|\/)(\.git|node_modules|dist|build|\.flow)(\/|$)/.test(source),
      });
      sanitizeTree(dir);
      return { dir, kind: 'local-copy', label: detected.label, cached: false };
    }
    const kind = archiveKind(detected.path);
    if (kind) return prepareSource(detected.path, { cwd, dest: dest || slugify(detected.path), refresh: true });
    // Single source file: copy it in and import that directory.
    const dir = resolveDest(cwd, dest || slugify(detected.path), true);
    fs.copyFileSync(detected.path, path.join(dir, path.basename(detected.path)));
    return { dir, kind: 'local-copy', label: detected.label, cached: false };
  }
  return prepareSource(input, { cwd, shell: cwd, dest, refresh: true });
}

export async function prepareSource(input, { cwd = process.cwd(), shell = process.cwd(), dest = null, refresh = false } = {}) {
  const source = detectSource(input, { cwd, shell });
  if (source.kind === 'none') throw new Error('missing source path / URL');
  if (source.kind === 'local') {
    if (!fs.existsSync(source.path)) throw new Error(`path does not exist: ${input}`);
    const stat = fs.statSync(source.path);
    if (stat.isFile()) {
      const kind = archiveKind(source.path);
      if (!kind) throw new Error(`unsupported file (expected source code, .zip or .tar.gz): ${input}`);
      const dir = resolveDest(cwd, dest || slugify(source.path), refresh);
      if (kind === 'zip') extractZip(source.path, dir);
      else extractTar(source.path, dir);
      sanitizeTree(dir);
      return { dir, kind: 'archive', label: source.label, cached: false };
    }
    return { dir: source.path, kind: 'local', label: source.label, cached: true };
  }

  if (source.kind === 'archive') {
    const kind = archiveKind(source.path);
    const dir = resolveDest(cwd, dest || slugify(source.path), refresh);
    if (kind === 'zip') extractZip(source.path, dir);
    else extractTar(source.path, dir);
    sanitizeTree(dir);
    return { dir, kind: 'archive', label: source.label, cached: false };
  }

  const dir = resolveDest(cwd, dest || slugify(source.url), refresh);
  if (source.kind === 'git') {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length && !refresh) {
      return { dir, kind: 'git', label: source.url, cached: true };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      run('git', ['clone', '--depth', '1', '--single-branch', source.url, dir]);
    } catch (error) {
      throw new Error(`git clone failed: ${String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ')}`);
    }
    return { dir, kind: 'git', label: source.url, cached: false };
  }

  // remote archive
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !refresh) {
    return { dir, kind: 'remote-archive', label: source.url, cached: true };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const tmp = path.join(path.dirname(dir), `.download-${Date.now()}${archiveKind(source.url) === 'zip' ? '.zip' : '.tar.gz'}`);
  try {
    await download(source.url, tmp);
    if (archiveKind(source.url) === 'zip') extractZip(tmp, dir);
    else extractTar(tmp, dir);
    sanitizeTree(dir);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  return { dir, kind: 'remote-archive', label: source.url, cached: false };
}

function resolveDest(cwd, name, refresh) {
  const base = path.resolve(cwd, SOURCE_DIR);
  const target = assertInside(base, path.join(base, String(name || 'source')));
  if (refresh && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}
