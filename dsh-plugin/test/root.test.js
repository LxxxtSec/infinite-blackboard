// The distribution resolver: the plugin's only link to the blackboard CLI + lib.
//
// Nothing here drives a real board, and nothing depends on where this file is
// installed. The point is the contract that makes the package standalone: it
// finds a distribution by explicit configuration, an installed copy, a sibling
// checkout or PATH — and it never reaches outside its own directory for code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PLUGIN_ROOT, SOURCES, resolveBlackboard, resolveBlackboardRoot,
} from '../lib/blackboard-root.js';
import { FALLBACK_VOCABULARY, loadVocabulary } from '../lib/board-lib.js';
import { buildBoardSnapshot } from '../lib/snapshot.js';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'blackboard-root-'));

/** A distribution stub: only the files the resolver and the loader stat. */
function fakeDistribution() {
  const root = tempDir();
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'bin', 'blackboard.js'), '#!/usr/bin/env node\n');
  return root;
}

const cliOf = (root) => path.join(root, 'bin', 'blackboard.js');
const nowhere = () => path.join(tempDir(), 'nowhere');

test('a sibling checkout next to the plugin is a distribution (dev layout)', () => {
  // The blackboard repo keeps this plugin in <blackboard>/dsh-plugin, so the
  // parent directory is a distribution. A standalone clone has to be configured.
  const parent = tempDir();
  const plugin = path.join(parent, 'dsh-plugin');
  mkdirSync(path.join(parent, 'bin'), { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(parent, 'bin', 'blackboard.js'), '#!/usr/bin/env node\n');

  const found = resolveBlackboard(undefined, { env: {}, pluginRoot: plugin });
  assert.equal(found.source, SOURCES.SIBLING);
  assert.equal(found.root, parent);
  assert.equal(found.command, process.execPath);
  assert.deepEqual(found.prefix, [path.join(parent, 'bin', 'blackboard.js')]);
});

test('an explicit cliPath wins; a broken one throws instead of falling back', () => {
  const root = fakeDistribution();
  const found = resolveBlackboard(cliOf(root), { env: {} });
  assert.equal(found.source, SOURCES.CONFIG);
  assert.equal(found.root, root);
  assert.deepEqual(found.prefix, [cliOf(root)]);
  assert.throws(() => resolveBlackboard('/nope/blackboard.js', { env: {} }), /cliPath does not exist/);
});

test('BLACKBOARD_CLI and BLACKBOARD_ROOT are honoured, config ahead of both', () => {
  const viaCli = fakeDistribution();
  const viaRoot = fakeDistribution();
  assert.equal(resolveBlackboard(undefined, { env: { BLACKBOARD_CLI: cliOf(viaCli) } }).root, viaCli);
  assert.equal(resolveBlackboard(undefined, { env: { BLACKBOARD_ROOT: viaRoot } }).root, viaRoot);
  const both = resolveBlackboard(cliOf(viaCli), { env: { BLACKBOARD_ROOT: viaRoot } });
  assert.equal(both.root, viaCli);
});

test('a configured but broken environment fails loudly', () => {
  assert.throws(
    () => resolveBlackboard(undefined, { env: { BLACKBOARD_CLI: '/nope/blackboard.js' } }),
    /BLACKBOARD_CLI does not exist/,
  );
  assert.throws(
    () => resolveBlackboard(undefined, { env: { BLACKBOARD_ROOT: tempDir() } }),
    /not a blackboard distribution/,
  );
});

test('an installed copy under node_modules/blackboard is found', () => {
  const plugin = tempDir();
  const installed = path.join(plugin, 'node_modules', 'blackboard');
  mkdirSync(path.join(installed, 'bin'), { recursive: true });
  writeFileSync(path.join(installed, 'bin', 'blackboard.js'), '#!/usr/bin/env node\n');
  const found = resolveBlackboard(undefined, { env: {}, pluginRoot: plugin });
  assert.equal(found.source, SOURCES.NODE_MODULES);
  assert.equal(found.root, installed);
});

test('the project launcher shim on PATH yields the distribution it points at', () => {
  const root = fakeDistribution();
  const bin = tempDir();
  writeFileSync(
    path.join(bin, 'blackboard'),
    `#!/bin/sh\nexec "/usr/bin/node" "${cliOf(root)}" "$@"\n`,
    { mode: 0o755 },
  );
  const found = resolveBlackboard(undefined, { env: { PATH: bin }, pluginRoot: nowhere() });
  assert.equal(found.source, SOURCES.PATH);
  assert.equal(found.root, root);
  assert.equal(found.cliPath, cliOf(root));
});

test('nothing anywhere resolves to null rather than a bogus command', () => {
  const isolated = { env: {}, pluginRoot: nowhere() };
  assert.equal(resolveBlackboard(undefined, isolated), null);
  assert.equal(resolveBlackboardRoot(undefined, isolated), null);
});

test('resolveBlackboardRoot reports the CLI, root and source', () => {
  const root = fakeDistribution();
  const found = resolveBlackboardRoot(cliOf(root), { env: {} });
  assert.deepEqual(Object.keys(found).sort(), ['cliPath', 'root', 'source']);
  assert.equal(found.root, root);
});

test('the vocabulary is imported from the distribution, never vendored', async () => {
  const root = fakeDistribution();
  writeFileSync(
    path.join(root, 'lib', 'model.js'),
    "export const NODE_TYPES = ['probe-type'];\nexport const EDGE_KINDS = ['probe-edge'];\n",
  );
  writeFileSync(path.join(root, 'lib', 'store.js'), 'export const findRoot = () => null;\n');

  const vocabulary = await loadVocabulary(root);
  assert.deepEqual(vocabulary.NODE_TYPES, ['probe-type']);
  assert.deepEqual(vocabulary.EDGE_KINDS, ['probe-edge']);
  // A field the distribution does not export falls back instead of vanishing.
  assert.deepEqual(vocabulary.SEVERITIES, FALLBACK_VOCABULARY.SEVERITIES);
});

test('an unreachable distribution falls back to the frozen vocabulary', async () => {
  const fallback = await loadVocabulary(nowhere());
  assert.deepEqual(fallback.NODE_TYPES, FALLBACK_VOCABULARY.NODE_TYPES);
  assert.deepEqual(fallback.CONFIDENCE_LEVELS, FALLBACK_VOCABULARY.CONFIDENCE_LEVELS);
});

test('a missing distribution fails the snapshot request, never the process', async () => {
  const result = await buildBoardSnapshot(tempDir(), nowhere());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-distribution');
  assert.match(result.message, /blackboard/);
});

test('shipped code never climbs out of the plugin directory for a module', () => {
  // The regression guard for this whole refactor. The pre-refactor plugin
  // escaped in several shapes -- an `../../lib/model.js` import, an
  // `../../lib/store.js` import, `path.resolve(HERE, '..', '..', 'bin',
  // 'blackboard.js')`, and a reach for the parent `skills/` and `public/`
  // trees (directly, or through a local `const PLUGIN = path.resolve(HERE, '..')`
  // alias) -- so this looks at the positions that can actually name a path:
  // module specifiers, path.resolve/path.join arguments, and fs call paths.
  //
  // It resolves rather than spells: each reference is walked segment by segment
  // from the base it really starts at, and reported only if that walk leaves the
  // plugin directory. That is what catches a parent `skills/` or `public/` reach,
  // a chain that dips out and comes back, and Windows-style separators, none of
  // which a search for 'two levels of ..' would notice.
  //
  // Limits, deliberately: it is a static text check, so it stops at indirection
  // it cannot evaluate -- `const UP = '..'` used as a segment, a base that is
  // itself an unevaluated call, a computed/imported path. It also ignores
  // path-looking text that is not in a path-consuming position, because a
  // quoted path inside an error message is prose, not a reference.
  const offenders = [];

  /** Drop comments, leaving string and template content untouched. */
  const stripComments = (text) => {
    let out = '';
    let state = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (state) {
        out += ch;
        if (ch === '\\') { out += text[i + 1] ?? ''; i += 1; continue; }
        if (ch === state) state = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { state = ch; out += ch; continue; }
      if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
      if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
      out += ch;
    }
    return out;
  };

  /** The balanced argument text of the call whose '(' sits at `open`. */
  const argsAt = (code, open) => {
    let level = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '(') level += 1;
      else if (code[i] === ')') {
        level -= 1;
        if (level === 0) return code.slice(open + 1, i);
      }
    }
    return code.slice(open + 1);
  };

  /** Path segments named by the literals in a fragment (`\\` and `${…}` aware). */
  const segmentsIn = (fragment) => {
    const segments = [];
    for (const match of fragment.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
      const text = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, '');
      for (const segment of text.split(/[\\/]+/)) {
        if (segment && segment !== '.') segments.push(segment);
      }
    }
    return segments;
  };

  /**
   * Walk `segments` from `base` (levels below the plugin root) and report how
   * far it ends up, plus whether it ever left. The final segment names the file
   * being reached unless the whole chain names a directory.
   */
  const walk = (base, segments, { directory = false } = {}) => {
    let level = base;
    let escaped = false;
    for (const segment of (directory ? segments : segments.slice(0, -1))) {
      level += segment === '..' ? -1 : 1;
      if (level < 0) escaped = true;
    }
    return { level, escaped };
  };

  /**
   * Local names bound to a path chain, so a chain rooted at such a name is not
   * mistaken for one rooted at the file's own directory. The pre-refactor skill
   * installer did exactly this: `const PLUGIN = path.resolve(HERE, '..')` then
   * `path.resolve(PLUGIN, '..', 'skills', 'blackboard')`.
   */
  const aliasLevels = (code, depth) => {
    const levels = new Map();
    const aliases = [];
    for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:resolve|join)\s*\(/g)) {
      const args = argsAt(code, match.index + match[0].length - 1);
      const segments = segmentsIn(args);
      const { level, escaped } = walk(baseOf(args, depth, levels), segments, { directory: true });
      levels.set(match[1], level);
      if (escaped || level < 0) aliases.push(match[1]);
    }
    return { levels, aliases };
  };

  /** A chain rooted at PLUGIN_ROOT starts at the plugin root, a known alias at
   *  wherever that alias resolved, anything else at this file's directory. */
  const baseOf = (args, depth, aliases = new Map()) => {
    const token = args.trim().split(/[\s,(]/)[0];
    if (token === 'PLUGIN_ROOT') return 0;
    if (aliases.has(token)) return aliases.get(token);
    return depth;
  };

  const check = (full) => {
    if (!/\.(m?js)$/.test(path.basename(full))) return;
    const rel = path.relative(PLUGIN_ROOT, full);
    const dir = path.dirname(rel);
    const depth = dir === '.' ? 0 : dir.split(path.sep).length;
    const code = stripComments(readFileSync(full, 'utf8'));
    const found = [];
    const { levels: aliases, aliases: escaping } = aliasLevels(code, depth);
    for (const name of escaping) found.push(`alias ${name}`);

    for (const match of code.matchAll(/(?:from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|import\.meta\.resolve\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) {
      const specifier = match[2];
      if (!/^\.\.?[\\/]/.test(specifier)) continue;
      if (walk(depth, segmentsIn(match[0])).escaped) found.push(`import ${specifier}`);
    }

    for (const match of code.matchAll(/path\.(?:resolve|join)\s*\(/g)) {
      const args = argsAt(code, match.index + match[0].length - 1);
      const segments = segmentsIn(args);
      if (!segments.includes('..')) continue;
      if (walk(baseOf(args, depth, aliases), segments).escaped) found.push(`path ${segments.join('/')}`);
    }

    for (const match of code.matchAll(/\b(?:readFileSync|writeFileSync|readdirSync|existsSync|statSync|mkdirSync|rmSync|cpSync|unlinkSync|accessSync|openSync)\s*\(/g)) {
      const first = (argsAt(code, match.index + match[0].length - 1).split(',')[0] || '').trim();
      if (!/^['"`]\.\.?[\\/]/.test(first)) continue;
      const segments = segmentsIn(first);
      if (walk(depth, segments).escaped) found.push(`fs ${segments.join('/')}`);
    }

    if (found.length) offenders.push(`${rel} -> ${found.join(' | ')}`);
  };

  const scan = (target) => {
    if (statSync(target).isFile()) {
      check(target);
      return;
    }
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('._')) continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) scan(full);
      else check(full);
    }
  };
  for (const entry of ['index.js', 'lib', 'scripts']) scan(path.join(PLUGIN_ROOT, entry));
  assert.deepEqual(offenders, []);
});
