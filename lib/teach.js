// Teaching overlays for code boards: lesson schema, validation, coverage and
// staleness. This module is additive: a board without files/lessons behaves
// exactly like before, and every helper returns empty/false for such boards.
//
// A lesson is anchored, not authoritative: it points at code ids and line
// ranges, records the file hashes it was written against, and is never used to
// gate an Agent action.

import {
  LESSON_SCHEMA, LESSON_LEVELS, LINE_NOTE_KINDS, DIFFICULTY_LEVELS, isUnit,
} from './model.js';

const LIMIT = {
  title: 300,
  summary: 12000,
  heading: 200,
  body: 20000,
  note: 2000,
  term: 120,
  explain: 6000,
  prompt: 2000,
  answer: 12000,
  sections: 200,
  lineNotes: 800,
  concepts: 60,
  exercises: 60,
  refs: 80,
};

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
};

const asString = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Accept `{start,end}`, `[start,end]` or `{line:start}`; keep the file optional. */
export function normalizeRange(input, fallbackFile = null) {
  if (!input) return null;
  let file = fallbackFile;
  let start = null;
  let end = null;
  if (Array.isArray(input)) {
    [start, end] = input;
  } else if (typeof input === 'object') {
    file = input.file || fallbackFile;
    start = input.start ?? input.line ?? input.from;
    end = input.end ?? input.to ?? start;
  } else if (typeof input === 'string') {
    const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(input.trim());
    if (m) {
      file = m[1] || fallbackFile;
      start = m[2] || null;
      end = m[3] || m[2] || null;
    }
  }
  const s = positiveInt(start);
  const e = positiveInt(end) ?? s;
  if (!file || !s) return null;
  return { file: String(file), start: s, end: Math.max(s, e || s) };
}

/** Read a lesson from JSON (or a JS object) and normalize it without touching the board. */
export function normalizeLesson(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('lesson must be a JSON object');
  }
  if (input.schema && input.schema !== LESSON_SCHEMA) {
    throw new Error(`unsupported lesson schema: ${input.schema} (expected ${LESSON_SCHEMA})`);
  }
  const targetIn = input.target && typeof input.target === 'object' ? input.target : {};
  const target = {};
  if (targetIn.board) target.board = true;
  if (typeof targetIn.unit === 'string' && targetIn.unit.trim()) target.unit = targetIn.unit.trim();
  const ranges = [];
  if (Array.isArray(targetIn.lines)) {
    for (const item of targetIn.lines) {
      const range = normalizeRange(item, targetIn.file || null);
      if (range) ranges.push(range);
    }
  }
  if (ranges.length) target.lines = ranges;
  if (typeof targetIn.file === 'string' && !ranges.length && !target.unit) {
    target.file = targetIn.file;
  }

  const level = LESSON_LEVELS.includes(input.level)
    ? input.level
    : target.board ? 'overview' : target.lines ? 'line' : 'unit';

  const sections = Array.isArray(input.sections)
    ? input.sections.slice(0, LIMIT.sections).map((section, index) => {
      if (!section || typeof section !== 'object') throw new Error(`sections[${index}] must be an object`);
      return {
        heading: clip(asString(section.heading), LIMIT.heading),
        body: clip(asString(section.body), LIMIT.body),
        refs: Array.isArray(section.refs) ? section.refs.slice(0, LIMIT.refs).map(asString) : [],
      };
    })
    : [];

  const lineNotes = Array.isArray(input.lineNotes)
    ? input.lineNotes.slice(0, LIMIT.lineNotes).map((note, index) => {
      if (!note || typeof note !== 'object') throw new Error(`lineNotes[${index}] must be an object`);
      const range = normalizeRange(note, target.lines?.[0]?.file || target.file || null);
      if (!range) throw new Error(`lineNotes[${index}] needs a file and a line`);
      if (range.start !== range.end) throw new Error(`lineNotes[${index}] must point at one line`);
      const kind = LINE_NOTE_KINDS.includes(note.kind) ? note.kind : 'note';
      return { file: range.file, line: range.start, kind, note: clip(asString(note.note), LIMIT.note) };
    })
    : [];

  const concepts = Array.isArray(input.concepts)
    ? input.concepts.slice(0, LIMIT.concepts).map((concept, index) => {
      if (!concept || typeof concept !== 'object') throw new Error(`concepts[${index}] must be an object`);
      return { term: clip(asString(concept.term), LIMIT.term), explain: clip(asString(concept.explain), LIMIT.explain) };
    })
    : [];

  const exercises = Array.isArray(input.exercises)
    ? input.exercises.slice(0, LIMIT.exercises).map((exercise, index) => {
      if (!exercise || typeof exercise !== 'object') throw new Error(`exercises[${index}] must be an object`);
      return { prompt: clip(asString(exercise.prompt), LIMIT.prompt), answer: clip(asString(exercise.answer), LIMIT.answer) };
    })
    : [];

  const lesson = {
    schema: LESSON_SCHEMA,
    level,
    title: clip(asString(input.title).trim(), LIMIT.title),
    summary: clip(asString(input.summary), LIMIT.summary),
    target,
    sections,
    lineNotes,
    concepts,
    exercises,
    prerequisites: Array.isArray(input.prerequisites) ? input.prerequisites.slice(0, 40).map((x) => clip(asString(x), 300)) : [],
    difficulty: DIFFICULTY_LEVELS.includes(input.difficulty) ? input.difficulty : null,
    skill: input.skill && typeof input.skill === 'object'
      ? { name: clip(asString(input.skill.name), 120), version: clip(asString(input.skill.version), 40) }
      : null,
    codeHashes: {},
  };
  if (!lesson.title) throw new Error('lesson.title is required');
  return lesson;
}

/**
 * Semantic validation against a replayed board. Returns { lesson, errors, warnings }.
 * `files` defaults to g.files; the store passes the freshly replayed graph.
 */
export function validateLesson(g, input) {
  const lesson = normalizeLesson(input);
  const errors = [];
  const warnings = [];
  const files = g.files || {};

  const target = lesson.target;
  if (!target.board && !target.unit && !target.lines && !target.file) {
    errors.push('lesson.target must be one of: {board:true}, {unit:"u12"}, {file,lines:[...]}');
  }
  if (target.unit) {
    const node = g.nodes?.[target.unit];
    if (!node) errors.push(`target unit does not exist: ${target.unit}`);
    else if (!isUnit(node)) errors.push(`target ${target.unit} is a ${node.type}, not a code unit`);
  }
  for (const range of target.lines || []) {
    const file = files[range.file];
    if (!file) {
      errors.push(`target file is not imported: ${range.file} (run blackboard code import first)`);
      continue;
    }
    if (range.start > (file.lines || 0)) errors.push(`target range ${range.file}:${range.start} is past end of file (${file.lines} lines)`);
    if (range.end > (file.lines || 0)) errors.push(`target range ${range.file}:${range.end} is past end of file (${file.lines} lines)`);
  }
  if (target.file && !files[target.file]) errors.push(`target file is not imported: ${target.file}`);

  for (const note of lesson.lineNotes) {
    const file = files[note.file];
    if (!file) {
      errors.push(`lineNotes file is not imported: ${note.file}`);
      continue;
    }
    if (note.line > (file.lines || 0)) errors.push(`lineNotes ${note.file}:${note.line} is past end of file`);
  }

  if (!lesson.sections.length) warnings.push('lesson has no sections');
  if (lesson.level === 'line' && !lesson.lineNotes.length) warnings.push('a line-level lesson without lineNotes cannot annotate code');
  if (lesson.level === 'overview' && lesson.lineNotes.length) warnings.push('overview lessons usually explain the chain, not single lines');
  for (const ref of lesson.sections.flatMap((s) => s.refs)) {
    if (/^[a-z]{1,3}\d+$/i.test(ref) && !g.nodes?.[ref]) warnings.push(`section ref does not resolve to a node: ${ref}`);
  }

  return { lesson, errors, warnings };
}

/** Fill codeHashes from the current files so later edits can detect staleness. */
export function stampLesson(lesson, g) {
  const stamped = { ...lesson, codeHashes: {} };
  const paths = new Set();
  if (lesson.target.file) paths.add(lesson.target.file);
  for (const range of lesson.target.lines || []) paths.add(range.file);
  for (const note of lesson.lineNotes) paths.add(note.file);
  if (lesson.target.unit) {
    const unit = g.nodes?.[lesson.target.unit];
    if (unit?.file) paths.add(unit.file);
  }
  for (const path of paths) {
    const file = g.files?.[path];
    if (file?.hash) stamped.codeHashes[path] = file.hash;
  }
  return stamped;
}

export function lessonStaleFiles(g, lesson) {
  const changed = [];
  for (const [path, hash] of Object.entries(lesson.codeHashes || {})) {
    const file = g.files?.[path];
    if (!file) changed.push(path);
    else if (file.hash && file.hash !== hash) changed.push(path);
  }
  return changed;
}

export function lessonCoversUnit(lesson, unit) {
  if (!unit || !isUnit(unit)) return false;
  if (lesson.target?.unit === unit.id) return true;
  const ranges = lesson.target?.lines || [];
  if (!ranges.length || !unit.file) return false;
  return ranges.some((range) => range.file === unit.file
    && range.start <= (unit.endLine || unit.startLine || 0)
    && range.end >= (unit.startLine || 0));
}

export function lessonsForUnit(g, unitId) {
  const unit = g.nodes?.[unitId];
  if (!unit) return [];
  return Object.values(g.lessons || {})
    .filter((lesson) => lessonCoversUnit(lesson, unit))
    .sort((a, b) => (a.level === 'overview' ? -1 : b.level === 'overview' ? 1 : (a.ts || 0) - (b.ts || 0)));
}

export function lessonsForFile(g, file) {
  return Object.values(g.lessons || {}).filter((lesson) =>
    (lesson.target?.file === file)
    || (lesson.target?.lines || []).some((range) => range.file === file)
    || lesson.lineNotes.some((note) => note.file === file));
}

/** file → line → notes, for the code panel gutter. */
export function lineNoteIndex(g) {
  const index = new Map();
  for (const lesson of Object.values(g.lessons || {})) {
    for (const note of lesson.lineNotes || []) {
      if (!index.has(note.file)) index.set(note.file, new Map());
      const byLine = index.get(note.file);
      if (!byLine.has(note.line)) byLine.set(note.line, []);
      byLine.get(note.line).push({ ...note, lessonId: lesson.id, lessonTitle: lesson.title });
    }
  }
  return index;
}

/**
 * Units that teaching coverage counts. Macros stay visible and explainable, but
 * they are declarations rather than logic, so they would distort the ratio.
 */
export function teachingUnits(g) {
  return Object.values(g.nodes || {}).filter(isUnit)
    .filter((unit) => unit.status !== 'removed' && unit.kind !== 'macro');
}

/** Units that at least one lesson explains (unit target or overlapping lines). */
export function coveredUnitIds(g) {
  const units = teachingUnits(g);
  const lessons = Object.values(g.lessons || {});
  const covered = new Set();
  for (const unit of units) {
    if (lessons.some((lesson) => lessonCoversUnit(lesson, unit))) covered.add(unit.id);
  }
  return covered;
}

/** Whole-board teaching coverage; cheap enough to call in lint/snapshot. */
export function coverage(g) {
  const units = teachingUnits(g);
  const lessons = Object.values(g.lessons || {});
  const requests = Object.values(g.requests || {});
  const replies = Object.values(g.replies || {});
  const covered = coveredUnitIds(g);
  const files = {};
  for (const unit of units) {
    const key = unit.file || '(unknown)';
    if (!files[key]) files[key] = { path: key, units: 0, covered: 0, lessons: 0, lineNotes: 0 };
    files[key].units += 1;
    if (covered.has(unit.id)) files[key].covered += 1;
  }
  const lineNotes = new Map();
  for (const lesson of lessons) {
    for (const note of lesson.lineNotes || []) {
      lineNotes.set(note.file, (lineNotes.get(note.file) || 0) + 1);
      if (files[note.file]) files[note.file].lineNotes += 1;
    }
  }
  for (const lesson of lessons) {
    const targets = new Set();
    if (lesson.target?.file) targets.add(lesson.target.file);
    for (const range of lesson.target?.lines || []) targets.add(range.file);
    for (const note of lesson.lineNotes || []) targets.add(note.file);
    for (const path of targets) if (files[path]) files[path].lessons += 1;
  }
  const stale = lessons.filter((lesson) => lessonStaleFiles(g, lesson).length > 0);
  const answered = new Set(replies.map((reply) => reply.requestId));
  return {
    units: { total: units.length, covered: covered.size, ratio: units.length ? covered.size / units.length : 0 },
    files: Object.values(files).sort((a, b) => a.path.localeCompare(b.path)),
    lessons: {
      total: lessons.length,
      stale: stale.length,
      staleIds: stale.map((lesson) => lesson.id),
      lineNotes: [...lineNotes.values()].reduce((sum, n) => sum + n, 0),
    },
    requests: {
      total: requests.length,
      open: requests.filter((request) => !answered.has(request.id) && request.status !== 'closed').length,
      answered: requests.filter((request) => answered.has(request.id)).length,
    },
  };
}

/** Lessons have a markdown body; this renderer is used by the CLI and export. */
export function renderLessonMarkdown(lesson) {
  const lines = [];
  lines.push(`# ${lesson.title}`);
  lines.push('');
  const target = lesson.target || {};
  const where = target.unit ? `unit ${target.unit}`
    : target.board ? '整块黑板'
      : (target.lines || []).map((range) => `${range.file}:${range.start}-${range.end}`).join(', ') || target.file || '未指定目标';
  lines.push(`- 级别: ${lesson.level} · 目标: ${where}${lesson.difficulty ? ` · 难度: ${lesson.difficulty}` : ''}`);
  if (lesson.skill?.name) lines.push(`- 来源: ${lesson.skill.name}${lesson.skill.version ? ` ${lesson.skill.version}` : ''}`);
  if (lesson.summary) {
    lines.push('', lesson.summary);
  }
  for (const section of lesson.sections) {
    lines.push('', `## ${section.heading || '说明'}`, '', section.body);
    if (section.refs?.length) lines.push('', `引用: ${section.refs.join(', ')}`);
  }
  if (lesson.concepts.length) {
    lines.push('', '## 概念');
    for (const concept of lesson.concepts) lines.push('', `### ${concept.term}`, '', concept.explain);
  }
  if (lesson.prerequisites.length) {
    lines.push('', '## 前置知识');
    for (const item of lesson.prerequisites) lines.push(`- ${item}`);
  }
  if (lesson.lineNotes.length) {
    lines.push('', '## 逐行批注');
    const sorted = [...lesson.lineNotes].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
    for (const note of sorted) lines.push(`- \`${note.file}:${note.line}\` **${note.kind}** ${note.note}`);
  }
  if (lesson.exercises.length) {
    lines.push('', '## 练习');
    lesson.exercises.forEach((exercise, index) => {
      lines.push('', `${index + 1}. ${exercise.prompt}`);
      if (exercise.answer) lines.push(`   <details>答案：${exercise.answer}</details>`);
    });
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function lessonBrief(lesson) {
  return {
    id: lesson.id,
    level: lesson.level,
    title: lesson.title,
    target: lesson.target,
    difficulty: lesson.difficulty || null,
    skill: lesson.skill?.name || null,
    lineNotes: (lesson.lineNotes || []).length,
    at: lesson.ts || lesson.at || null,
  };
}
