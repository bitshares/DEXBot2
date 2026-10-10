#!/usr/bin/env node
/**
 * Sync DEXBot2-owned manifest versions and hardcoded version strings
 * from root package.json.
 *
 * package.json has to remain the source of truth because npm requires
 * a literal JSON version field.
 *
 * Usage:
 *   node dist/scripts/sync-version.js           # write changes
 *   node dist/scripts/sync-version.js --check    # exit 1 if any mismatch
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../modules/paths');
const ROOT = PATHS.PROJECT_ROOT;

const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const targetVersion = rootPackage.version;
const checkOnly = process.argv.includes('--check');

if (!targetVersion) {
  throw new Error('Root package.json is missing a version field');
}

interface Target {
  file: string;
  update: (content: string, version: string) => string | null;
}

const targets: Target[] = [
  // ── JSON manifests ──────────────────────────────────────────
  {
    file: 'package-lock.json',
    update(content, version) {
      const json = JSON.parse(content);
      if (json.version === version && json.packages?.['']?.version === version) return null;
      json.version = version;
      if (json.packages?.['']) json.packages[''].version = version;
      return JSON.stringify(json, null, 2) + '\n';
    },
  },
  {
    file: 'claw/package.json',
    update(content, version) {
      const json = JSON.parse(content);
      if (json.version === version) return null;
      json.version = version;
      return JSON.stringify(json, null, 2) + '\n';
    },
  },
  {
    file: 'claw/runtimes/openclaw-plugin/package.json',
    update(content, version) {
      const json = JSON.parse(content);
      if (json.version === version) return null;
      json.version = version;
      return JSON.stringify(json, null, 2) + '\n';
    },
  },
  {
    file: 'claw/runtimes/openclaw-plugin/openclaw.plugin.json',
    update(content, version) {
      const json = JSON.parse(content);
      if (json.version === version) return null;
      json.version = version;
      return JSON.stringify(json, null, 2) + '\n';
    },
  },

  // ── Source files (regex replacements) ──────────────────────
  {
    file: 'claw/tests/test_claw_mcp_transport.ts',
    update(content, version) {
      const replaced = content.replace(
        /(version: )'\d+\.\d+\.\d+'/g,
        `$1'${version}'`,
      );
      return replaced !== content ? replaced : null;
    },
  },

  // ── Doc files (regex replacements) ─────────────────────────
  {
    file: 'docs/README.md',
    update(content, version) {
      let result = content;
      result = result.replace(
        /(v)\d+\.\d+\.\d+( is the current release)/g,
        `$1${version}$2`,
      );
      result = result.replace(
        /(v)\d+\.\d+\.\d+( \(released\))/g,
        `$1${version}$2`,
      );
      result = result.replace(
        /(through the v)\d+\.\d+\.\d+( stable release)/g,
        `$1${version}$2`,
      );
      return result !== content ? result : null;
    },
  },
  {
    file: 'docs/DEXBOT_COMPARISON.md',
    update(content, version) {
      let result = content;
      // DEXBot2 prose reference (not DEXBot Python's v1.0.0)
      result = result.replace(
        /(DEXBot2 \(TypeScript, v)\d+\.\d+\.\d+\)/g,
        `$1${version})`,
      );
      // DEXBot2 table cells — v-prefixed cells in the right column
      result = result.replace(
        /(\|\s+v)\d+\.\d+\.\d+(\s+\|)/g,
        `$1${version}$2`,
      );
      return result !== content ? result : null;
    },
  },
  {
    file: 'docs/FUND_MOVEMENT_AND_ACCOUNTING.md',
    update(content, version) {
      const replaced = content.replace(
        /(DEXBot2 v)\d+\.\d+\.\d+( release)/g,
        `$1${version}$2`,
      );
      return replaced !== content ? replaced : null;
    },
  },
  {
    file: 'docs/EVOLUTION.md',
    update(content, version) {
      let result = content;
      result = result.replace(
        /(through the current )\d+\.\d+\.\d+( stable release)/g,
        `$1${version}$2`,
      );
      result = result.replace(
        /(entries \(v0\.1\.0 to v)\d+\.\d+\.\d+\)/g,
        `$1${version})`,
      );
      return result !== content ? result : null;
    },
  },
];

// ── Execute ─────────────────────────────────────────────────
const mismatches: string[] = [];

for (const target of targets) {
  const filePath = path.join(ROOT, target.file);

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    console.error(`[SKIP] ${target.file} — not found`);
    continue;
  }

  const updated = target.update(content, targetVersion);

  if (updated === null) {
    continue; // no change needed
  }

  mismatches.push(target.file);
  if (!checkOnly) {
    fs.writeFileSync(filePath, updated);
  }
}

if (mismatches.length > 0) {
  if (checkOnly) {
    console.error(
      `Version mismatch with root package.json (${targetVersion}):`,
    );
    for (const file of mismatches) console.error(`  - ${file}`);
    process.exit(1);
  }

  console.log(
    `Synced ${mismatches.length} file(s) to ${targetVersion}:`,
  );
  for (const file of mismatches) console.log(`  - ${file}`);
} else {
  console.log(`All files already match version ${targetVersion}.`);
}
