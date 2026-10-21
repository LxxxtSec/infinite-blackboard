import type { ReactNode } from 'react';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseBlocks(text: string): Block[] {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    const fence = /^```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence (tolerate EOF)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+/.test(line);
    const unordered = /^\s*[-*]\s+/.test(line);
    if (ordered || unordered) {
      const items: string[] = [];
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      while (i < lines.length && re.test(lines[i])) {
        items.push(lines[i].replace(re, ''));
        i += 1;
        // Continuation lines indented under the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4})\s+/.test(lines[i]) && !/^```/.test(lines[i])
      && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE).filter((part) => part !== '');
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key} className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.92em]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>;
    return <span key={key}>{part}</span>;
  });
}

/** Small, dependency-free renderer for authored lesson bodies (no HTML, no raw injection). */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="lesson-prose flex flex-col gap-2.5 text-[13px] leading-[22px] text-subtle">
      {blocks.map((block, index) => {
        const key = `b-${index}`;
        if (block.kind === 'heading') {
          const level = Math.min(3, Math.max(2, block.level));
          const Tag = level === 2 ? 'h4' : 'h5';
          return <Tag key={key} className="m-0 mt-2 text-[13px] font-semibold text-foreground">{block.text}</Tag>;
        }
        if (block.kind === 'code') {
          return <pre key={key} className="m-0 overflow-x-auto rounded-lg border bg-secondary p-3 font-mono text-[11px] leading-[18px] text-foreground">{block.text}</pre>;
        }
        if (block.kind === 'list') {
          return block.ordered
            ? <ol key={key} className="m-0 flex list-decimal flex-col gap-1 pl-5">{block.items.map((item, n) => <li key={`${key}-${n}`}>{inline(item, `${key}-${n}`)}</li>)}</ol>
            : <ul key={key} className="m-0 flex list-disc flex-col gap-1 pl-5">{block.items.map((item, n) => <li key={`${key}-${n}`}>{inline(item, `${key}-${n}`)}</li>)}</ul>;
        }
        if (block.kind === 'quote') {
          return <blockquote key={key} className="m-0 border-l-2 border-strong pl-3 text-muted-foreground">{inline(block.text, key)}</blockquote>;
        }
        if (block.kind === 'table') {
          return (
            <div key={key} className="overflow-x-auto rounded-lg border">
              <table className="w-full table-fixed border-collapse text-[11.5px] leading-[18px]">
                <thead className="bg-secondary/70">
                  <tr>
                    {block.header.map((cell, n) => (
                      <th key={`${key}-h-${n}`} className={`break-words border-b border-r px-2 py-1.5 text-left font-medium last:border-r-0 ${block.header.length === 2 && n === 0 ? 'w-[30%]' : ''}`}>{inline(cell, `${key}-h-${n}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={`${key}-r-${r}`} className="border-b last:border-b-0">
                      {block.header.map((_, n) => (
                        <td key={`${key}-c-${r}-${n}`} className={`break-words border-r px-2 py-1.5 align-top last:border-r-0 ${block.header.length === 2 && n === 0 ? 'w-[30%]' : ''}`}>{inline(row[n] || '', `${key}-c-${r}-${n}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={key} className="m-0 whitespace-pre-wrap">{inline(block.text, key)}</p>;
      })}
    </div>
  );
}
