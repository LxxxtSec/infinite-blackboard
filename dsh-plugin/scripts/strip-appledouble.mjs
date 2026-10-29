#!/usr/bin/env node
// Remove macOS AppleDouble companions (`._*`) from this plugin tree.
//
// Non-APFS volumes (exFAT, some USB drives, SMB shares) create one next to every
// file they hold. DSH's plugin metadata reader scans `locale/` and requires every
// `*.json` filename to be a language id, so a single `locale/._en.json` turns the
// whole plugin's metadata into an error ("must use a language id as its filename").
//
// Run this after writing files on such a volume: `npm run clean:meta`.

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let removed = 0;

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('._')) {
      rmSync(full, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    if (entry.isDirectory()) walk(full);
  }
};

walk(root);
console.log(`stripped ${removed} AppleDouble ${removed === 1 ? 'entry' : 'entries'} under ${root}`);
