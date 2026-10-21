// Source-code ingestion for kernel exploit teaching boards.
//
// The parser is deliberately dependency-free and conservative: it never
// executes code, never claims semantic correctness, and only exposes anchors
// (file, line range, symbol, heuristics) that a teacher/Agent can refine.
// Unsupported languages fall back to one file-level unit.

import crypto from 'node:crypto';

export const LANG_BY_EXT = {
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.ts': 'typescript',
  '.sh': 'shell', '.bash': 'shell', '.yaml': 'yaml', '.yml': 'yaml',
  '.json': 'json', '.md': 'markdown', '.txt': 'text', '.S': 'asm', '.s': 'asm',
};

export const UNIT_KINDS = ['function', 'struct', 'enum', 'macro', 'file'];
export const STAGE_PHASES = [
  'entry', 'surface', 'trigger', 'primitive', 'leak', 'spray',
  'overwrite', 'bypass', 'escalate', 'impact', 'cleanup',
];
export const STAGE_TITLES = {
  entry: '入口与参数',
  surface: '攻击面 / 内核接口',
  trigger: '触发漏洞',
  primitive: '拿到利用原语',
  leak: '信息泄露 / 绕过 KASLR',
  spray: '堆布局与喷洒',
  overwrite: '覆写控制数据',
  bypass: '绕过缓解措施',
  escalate: '提权',
  impact: '影响与落地',
  cleanup: '清理与稳定化',
};

export function languageOf(filePath) {
  const lower = String(filePath || '');
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return 'text';
  return LANG_BY_EXT[lower.slice(dot)] || LANG_BY_EXT[lower.slice(dot).toLowerCase()] || 'text';
}

export function hashContent(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

/** Replace comments and string/char literals with spaces, keeping newlines and length. */
export function maskSource(src) {
  const text = String(src ?? '');
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (ch === '"' || ch === "'") { state = ch === '"' ? 'string' : 'char'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += '\n'; } else out += ch === '\r' ? '\r' : ' ';
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += ch === '\n' ? '\n' : ' ';
      i += 1; continue;
    }
    // string / char literal
    if (ch === '\\') { out += '  '; i += 2; continue; }
    if ((state === 'string' && ch === '"') || (state === 'char' && ch === "'")) {
      state = 'code'; out += ch; i += 1; continue;
    }
    out += ch === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}


/** Blank out preprocessor directive lines for structure scanning (macros are collected separately). */
export function maskDirectives(masked) {
  return masked
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}

const C_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return',
  'sizeof', 'typeof', '__typeof__', 'alignof', '_Alignof', 'static_assert',
  'defined', 'asm', '__asm__', 'goto', 'break', 'continue', 'typedef',
  'struct', 'union', 'enum', 'inline', '__inline', '__inline__',
]);

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  // binary search: last start <= index
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function matchBrace(masked, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function depthAt(masked) {
  const depth = new Int32Array(masked.length + 1);
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    depth[i] = d;
    if (masked[i] === '{') d += 1;
    else if (masked[i] === '}') d = Math.max(0, d - 1);
  }
  depth[masked.length] = d;
  return depth;
}

/** Heuristic teaching tags; they describe the code, never assert correctness. */
const TAG_RULES = [
  ['entry', /\b(main|usage|banner|parse_args?|parse_options?)\b/i],
  ['surface', /\b(ioctl|mmap|munmap|socket|setsockopt|sendmsg|recvmsg|msg_msg|pipe|pipe_buffer|tty|binder|ashmem|ion|dma_buf|keyctl|add_key|userfaultfd)\b/i],
  ['trigger', /\b(trigger|exploit|pwn|race|thread|pthread_create|fork|clone|userfaultfd|fuse)\b/i],
  ['primitive', /\b(uaf|use.?after.?free|oob|out_of_bounds|overflow|double.?free|arbitrary|arb_|freed|dangling|stale)\b/i],
  ['leak', /\b(leak|kaslr|slide|kernel_base|read64|dump|info_leak)\b/i],
  ['spray', /\b(spray|groom|heap_|slab|msg_msg|sk_buff|shm|fanout)\b/i],
  ['overwrite', /\b(overwrite|write64|write32|arb_write|cross_cache|rop|jop|pivot)\b/i],
  ['bypass', /\b(selinux|cfi|kcfi|pan|smap|smep|mte|scs|stack_canary|bypass)\b/i],
  ['escalate', /\b(commit_creds|prepare_kernel_cred|cred|root|escalat|suid|init_cred)\b/i],
  ['impact', /\b(modprobe_path|core_pattern|init_task|init_nsproxy|setuid|execve)\b/i],
  ['cleanup', /\b(cleanup|restore|unlock|close|free_all|sleep)\b/i],
];

/** Cue words that a piece of code touches a mitigation or a kernel surface. */
export const TAG_ORDER = [
  'entry', 'surface', 'trigger', 'primitive', 'leak', 'spray', 'overwrite',
  'bypass', 'escalate', 'impact', 'cleanup',
];

export function inferTags(text) {
  // Underscores are word characters for regex `\b`, so snake_case symbols like
  // `leak_kernel_pointer` would never match `\bleak\b`. Test both forms.
  const raw = String(text || '');
  const normalized = raw.replace(/_/g, ' ');
  const tags = new Set();
  for (const [tag, re] of TAG_RULES) if (re.test(raw) || re.test(normalized)) tags.add(tag);
  return TAG_ORDER.filter((tag) => tags.has(tag));
}

/**
 * Name wins over body. A container function (`main`) mentions every stage in
 * its body; letting that vote would tag it with the whole chain.
 */
export function tagsForUnit(symbol, body) {
  const nameTags = inferTags(symbol);
  if (nameTags.length) {
    const specific = nameTags.filter((tag) => tag !== 'surface');
    return specific.length ? specific : nameTags;
  }
  const bodyTags = inferTags(body);
  const specific = bodyTags.filter((tag) => tag !== 'surface').slice(0, 2);
  return specific.length ? specific : bodyTags.slice(0, 1);
}

function callsIn(maskedBody, known = null) {
  const calls = [];
  const seen = new Set();
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(maskedBody))) {
    const name = m[1];
    if (C_KEYWORDS.has(name) || seen.has(name)) continue;
    seen.add(name);
    if (known && !known.has(name)) continue;
    calls.push(name);
  }
  return calls;
}

function collectMacros(text, starts, mask) {
  const units = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*#\s*define[ \t]+([A-Za-z_]\w*)/.exec(lines[i]);
    if (!m) continue;
    // A definition can continue with trailing backslashes.
    let end = i;
    while (end < lines.length - 1 && /\\[ \t]*$/.test(lines[end])) end += 1;
    const body = lines.slice(i, end + 1).join('\n');
    units.push({
      kind: 'macro',
      symbol: m[1],
      startLine: i + 1,
      endLine: end + 1,
      signature: lines[i].trim().slice(0, 200),
      calls: [],
      tags: tagsForUnit(m[1], body),
    });
    i = end;
  }
  return units;
}

function collectIncludes(text) {
  const includes = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = /^[ \t]*#\s*include[ \t]*[<"]([^>"]+)[>"]/.exec(line);
    if (m) includes.push(m[1]);
  }
  return includes;
}

function collectAggregates(masked, original, starts, depth) {
  const units = [];
  const re = /\b(struct|union|enum)[ \t]+([A-Za-z_]\w*)[ \t]*\{/g;
  let m;
  while ((m = re.exec(masked))) {
    const index = m.index;
    if (depth[index] !== 0) continue;
    const open = masked.indexOf('{', index);
    if (open === -1) continue;
    const close = matchBrace(masked, open);
    if (close === -1) continue;
    const name = m[2];
    const startLine = lineOf(starts, index);
    const endLine = lineOf(starts, close);
    const body = original.slice(index, close + 1);
    units.push({
      kind: m[1] === 'enum' ? 'enum' : 'struct',
      symbol: name,
      startLine,
      endLine,
      signature: `${m[1]} ${name}`,
      calls: [],
      tags: tagsForUnit(name, body),
    });
    re.lastIndex = close + 1;
  }
  return units;
}

function collectFunctions(masked, original, starts, depth) {
  const units = [];
  // Return type + name + params + optional trailing qualifiers + `{`
  const re = /([A-Za-z_][A-Za-z0-9_ \t\*]*?)\b([A-Za-z_]\w*)[ \t]*\(([^;{}()]*)\)\s*(?:__attribute__\s*\(\([\s\S]*?\)\)\s*)?\{/g;
  let m;
  while ((m = re.exec(masked))) {
    const index = m.index;
    if (depth[index] !== 0) continue;
    const name = m[2];
    if (C_KEYWORDS.has(name)) continue;
    const open = masked.indexOf('{', m.index + m[0].length - 1);
    if (open === -1) continue;
    const close = matchBrace(masked, open);
    if (close === -1) continue;
    const body = masked.slice(open, close + 1);
    const raw = original.slice(index, close + 1);
    const signature = original.slice(index, open).replace(/\s+/g, ' ').trim().slice(0, 300);
    units.push({
      kind: 'function',
      symbol: name,
      startLine: lineOf(starts, index),
      endLine: lineOf(starts, close),
      signature,
      calls: callsIn(body),
      tags: tagsForUnit(name, raw),
    });
    re.lastIndex = close + 1;
  }
  return units;
}

/**
 * Parse one source file into units.
 * @returns {{lang:string, units:Array, includes:string[], hash:string, lines:number}}
 */
export function parseSource(text, { path = 'source.c', lang = null } = {}) {
  const src = String(text ?? '');
  const language = lang || languageOf(path);
  const lines = src.split('\n');
  const hash = hashContent(src);
  if (language !== 'c' && language !== 'cpp') {
    return {
      lang: language,
      hash,
      lines: lines.length,
      includes: [],
      units: [{
        kind: 'file',
        symbol: String(path).split('/').pop() || path,
        startLine: 1,
        endLine: Math.max(1, lines.length),
        signature: String(path),
        calls: [],
        tags: tagsForUnit(String(path).split('/').pop() || '', src.slice(0, 20000)),
      }],
    };
  }

  const masked = maskDirectives(maskSource(src));
  const starts = lineIndex(src);
  const depth = depthAt(masked);
  const macros = collectMacros(src, starts, masked);
  const aggregates = collectAggregates(masked, src, starts, depth);
  const functions = collectFunctions(masked, src, starts, depth);
  const units = [...macros, ...aggregates, ...functions].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  // Calls stay raw here; the importer resolves them against known symbols.
  for (const unit of units) {
    unit.calls = [...new Set(unit.calls)].slice(0, 40);
  }

  return {
    lang: language,
    hash,
    lines: lines.length,
    includes: collectIncludes(src),
    units,
  };
}

/** Replace values with stable placeholders for re-import diffing; keeps symbols readable. */
export function unitKey(file, unit) {
  return `${file}|${unit.kind}|${unit.symbol}|${unit.startLine}`;
}

/**
 * Suggest a coarse exploit chain from parsed units. Order is heuristic and is
 * meant to be reviewed by a teacher/Agent, never treated as ground truth.
 */
export function suggestChain(units, { maxStages = 12 } = {}) {
  const matched = new Map();
  for (const unit of units) {
    for (const tag of unit.tags || []) {
      if (!STAGE_PHASES.includes(tag)) continue;
      if (!matched.has(tag)) matched.set(tag, []);
      matched.get(tag).push(unit);
    }
  }
  const chain = [];
  for (const phase of STAGE_PHASES) {
    const list = matched.get(phase);
    if (!list || !list.length) continue;
    chain.push({
      phase,
      title: STAGE_TITLES[phase],
      units: list.slice(0, 24),
    });
    if (chain.length >= maxStages) break;
  }
  return chain;
}
