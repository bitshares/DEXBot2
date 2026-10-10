#!/usr/bin/env node
/**
 * Explicit-`any` budget ratchet.
 *
 * DEXBot2 has ~5k explicit `any` occurrences. Removing them is a long program;
 * this gate makes progress monotonic by failing when the code-line count rises
 * above the committed budget in `any-budget.json`.
 *
 * The root scopes (`modules/`, `market_adapter/`, `analysis/`, `scripts/`) and
 * the experimental `claw/` subtree are tracked with independent budgets so the
 * now-clean root count is not inflated by claw, which is still being paid down.
 *
 * Counts `any` tokens on code lines only (comment / JSDoc lines are ignored so
 * documentation cleanup is not double-counted).
 *
 * Usage:
 *   node dist/scripts/check_any.js            # compare against any-budget.json
 *   node dist/scripts/check_any.js --update   # write the current count as budget
 *   node dist/scripts/check_any.js --list     # print per-file counts
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../modules/paths');
const ROOT: string = PATHS.PROJECT_ROOT;

const BUDGET_FILE = path.join(ROOT, 'any-budget.json');
const SCAN_DIRS = ['modules', 'market_adapter', 'analysis', 'scripts'];
const SCAN_ROOT_FILES = true;
const ROOT_SCOPE = 'root';
const CLAW_SCOPE = 'claw';
const CLAW_DIR = 'claw';

interface FileCount {
  file: string;
  count: number;
}

// `any` as an explicit type token only: not preceded by an identifier char or
// `.` (so the `Promise.any` built-in / member named `any` is not counted) and
// not inside a string or template literal (log/help prose is not counted).
const ANY_RE = new RegExp('(?<![\\w.])any\\b', 'g');
const COMMENT_LINE_RE = /^\s*(\/\/|\*|\/\*)/;

/** Blank out string and template-literal spans so their prose is not counted. */
function stripStrings(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < line.length && line[i] !== ch) {
        if (line[i] === '\\') i++;
        i++;
      }
      i++; // closing quote
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests') continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) files.push(...walk(path.join(ROOT, dir)));
  if (SCAN_ROOT_FILES) {
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(path.join(ROOT, entry.name));
      }
    }
  }
  return files;
}

function clawFiles(): string[] {
  return [...walk(path.join(ROOT, CLAW_DIR))];
}

function countAny(file: string): number {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (COMMENT_LINE_RE.test(line)) continue;
    const matches = stripStrings(line).match(ANY_RE);
    if (matches) count += matches.length;
  }
  return count;
}

interface ScopeCount {
  scope: string;
  files: FileCount[];
  total: number;
}

function countScope(scope: string, files: string[]): ScopeCount {
  const fileCounts = files
    .map((file) => ({ file: path.relative(ROOT, file), count: countAny(file) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  return { scope, files: fileCounts, total: fileCounts.reduce((sum, entry) => sum + entry.count, 0) };
}

const scopes: ScopeCount[] = [
  countScope(ROOT_SCOPE, sourceFiles()),
  countScope(CLAW_SCOPE, clawFiles())
];

const listMode = process.argv.includes('--list');
const updateMode = process.argv.includes('--update');

if (listMode) {
  for (const scope of scopes) {
    for (const entry of scope.files) console.log(`${String(entry.count).padStart(5)}  ${entry.file}`);
    console.log(`${String(scope.total).padStart(5)}  ${scope.scope.toUpperCase()} SUBTOTAL (${scope.files.length} files)`);
  }
  process.exit(0);
}

if (updateMode) {
  const next = {
    root: scopes.find((scope) => scope.scope === ROOT_SCOPE)!.total,
    claw: scopes.find((scope) => scope.scope === CLAW_SCOPE)!.total,
    updated: new Date().toISOString().slice(0, 10)
  };
  fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`budget file updated: root=${next.root} claw=${next.claw}`);
  process.exit(0);
}

const fileBudget: Record<string, number> = fs.existsSync(BUDGET_FILE)
  ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'))
  : {};

let exceeded = false;
for (const scope of scopes) {
  const committed = typeof fileBudget[scope.scope] === 'number'
    ? fileBudget[scope.scope]
    // Backward compatibility with the original single-scope `{ total }` file.
    : (scope.scope === ROOT_SCOPE && typeof fileBudget.total === 'number' ? fileBudget.total : Infinity);

  if (scope.total > committed) {
    console.error(`\u2716 explicit type budget exceeded [${scope.scope}]: ${scope.total} > ${committed}`);
    exceeded = true;
  } else if (scope.total < committed) {
    console.log(`\u2713 [${scope.scope}] explicit type count ${scope.total} is below budget ${committed}. Lower the budget file to ${scope.total} to lock in the gain.`);
  } else {
    console.log(`\u2713 [${scope.scope}] explicit type count ${scope.total} is at budget ${committed}.`);
  }
}

if (exceeded) {
  console.error('  Reduce usages, or run `node dist/scripts/check_any.js --update` only when lowering the budget.');
  process.exit(1);
}
