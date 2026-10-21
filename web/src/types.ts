export type BoardNode = {
  id: string;
  type: string;
  title: string;
  detail?: string;
  status?: string;
  severity?: string;
  confidence?: string;
  difficulty?: string;
  /** Code units carry a file/line anchor and a parsed kind. */
  file?: string;
  kind?: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  tags?: string[];
  calls?: string[];
  phase?: string;
  role?: string;
  learned?: boolean;
  learnedAt?: number | null;
  ts?: number;
  updated?: number;
  session?: string;
  [key: string]: unknown;
};

export type BoardEdge = {
  id: string;
  from: string;
  to: string;
  kind: string;
  ts?: number;
};

export type Activity = {
  id: string;
  tool?: string;
  summary?: string;
  status?: string;
  agentId?: string;
  at?: number;
  linkedNodeIds?: string[];
};

export type Cursor = {
  id: string;
  agentId: string;
  from?: string;
  to?: string;
  at?: number;
};

export type CodeFile = {
  path: string;
  lang: string;
  hash: string;
  lines: number;
  bytes?: number;
  includes?: string[];
  ts?: number;
};

export type LineRange = { file: string; start: number; end: number };

export type LineNote = {
  file: string;
  line: number;
  kind: string;
  note: string;
  lessonId?: string;
  lessonTitle?: string;
};

export type Lesson = {
  id: string;
  level: 'overview' | 'unit' | 'line';
  title: string;
  summary?: string;
  target: { board?: boolean; unit?: string; file?: string; lines?: LineRange[] };
  sections: { heading: string; body: string; refs?: string[] }[];
  lineNotes: LineNote[];
  concepts: { term: string; explain: string }[];
  exercises: { prompt: string; answer?: string }[];
  prerequisites: string[];
  difficulty?: string | null;
  skill?: { name?: string; version?: string } | null;
  codeHashes?: Record<string, string>;
  ts?: number;
};

export type StudentRequest = {
  id: string;
  question: string;
  unitId?: string | null;
  file?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  agentId?: string;
  status: string;
  at?: number;
};

export type Reply = {
  id: string;
  requestId: string;
  text: string;
  author: string;
  at?: number;
  thinking?: string;
  runtime?: string;
  stopped?: boolean;
  stopReason?: 'stopped' | 'timeout' | 'disconnected' | string;
  tools?: { name: string; detail: string }[];
};

export type TeachingCoverage = {
  units: { total: number; covered: number; ratio: number };
  files: { path: string; units: number; covered: number; lessons: number; lineNotes: number }[];
  lessons: { total: number; stale: number; staleIds: string[]; lineNotes: number };
  requests: { total: number; open: number; answered: number };
};

export type EmbeddedCode = {
  path: string;
  hash: string;
  lines: number;
  truncated?: boolean;
  content: string[];
};

export type GraphSnapshot = {
  meta: {
    title?: string;
    focus?: string;
    count?: number;
    session?: string;
  };
  nodes: Record<string, BoardNode> | BoardNode[];
  edges: Record<string, BoardEdge> | BoardEdge[];
  cursors?: Record<string, Cursor>;
  cursorTrail?: unknown[];
  activities?: Record<string, Activity> | Activity[];
  checkpoints?: Record<string, unknown>;
  files?: Record<string, CodeFile>;
  lessons?: Record<string, Lesson>;
  requests?: Record<string, StudentRequest>;
  replies?: Record<string, Reply>;
  coverage?: TeachingCoverage;
  requestToken?: string;
  code?: Record<string, EmbeddedCode>;
  codeOmitted?: string[];
  stats?: {
    total?: number;
    edges?: number;
    activities?: number;
    checkpoints?: number;
    frontier?: number;
    confirmed?: number;
    candidates?: number;
    byType?: Record<string, number>;
    vulns?: Record<string, number>;
    confidence?: Record<string, number>;
    units?: number;
    learned?: number;
    stages?: number;
    lessons?: number;
    requests?: { total: number; open: number; answered: number };
    coverage?: { total: number; covered: number; ratio: number };
  };
  digest?: string;
};

export type ViewMode = 'context' | 'logic' | 'all' | 'teaching';

export const values = <T,>(input: Record<string, T> | T[] | undefined): T[] =>
  Array.isArray(input) ? input : Object.values(input || {});
