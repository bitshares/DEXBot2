#!/usr/bin/env node

/**
 * Bot Configuration Validator
 *
 * Validates that the live bot configuration file contains all required fields
 * for each bot entry. This is a health check to ensure configurations are
 * valid before being used by the system.
 *
 * Required fields for each bot: assetA, assetB, coreOrders, botFunds
 * Optional field: gridPrice (number | null | "ama"/"ama1".."ama4")
 *
 * Usage: node dist/scripts/validate_bots.js
 * Exit code: 0 (always, even if warnings found)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const { PATHS } = require('../modules/paths');
const { getErrorMessage } = require('../modules/utils/errors');

const livePath = PATHS.PROFILES.BOTS_JSON;

/**
 * checkConfig: Validate bot configuration entries
 *
 * Verifies that each bot entry contains all required configuration fields.
 * Handles both single bot objects and arrays of bots in {bots: [...]}.
 *
 * Required fields:
 * - assetA: Base currency symbol (e.g., 'XRP')
 * - assetB: Quote currency symbol (e.g., 'BTS')
 * - coreOrders: Number of orders in the grid
 * - botFunds: Amount of funds allocated to the bot
 *
 * Output:
 * - Prints OK status for valid bots
 * - Warns about missing fields with bot index and name
 * - Summary message if all bots are valid
 *
 * @param {Object} obj - Parsed configuration object (single bot or {bots: [...]})
 * @param {string} src - Source name for display (e.g., 'profiles/bots.json')
 */
function checkConfig(obj: unknown, src: string) {
  // Normalize: convert single bot to array format for uniform processing
  const o = (obj && typeof obj === 'object') ? obj as Record<string, unknown> : {};
  const bots: Record<string, unknown>[] = Array.isArray(o.bots) && o.bots.length ? o.bots as Record<string, unknown>[] : [o];
  console.log(`\n== Checking ${src}: found ${bots.length} bot entries`);

  // List of required fields that every bot must have
  const required = ['assetA', 'assetB', 'coreOrders', 'botFunds'];
  let anyMissing = false;
  let anyGridPriceWarnings = false;

  // Validate each bot entry
  bots.forEach((b, i) => {
    // Use bot name if available, otherwise use index
    const name = b.name || `<unnamed-${i}>`;
    // Find which required fields are missing from this bot
    const missing = required.filter(k => !(k in b));

    if (missing.length) {
      // Bot is missing required fields
      anyMissing = true;
      console.warn(`- Bot[${i}] '${name}' is MISSING: ${missing.join(', ')}`);
    } else {
      // Bot has all required fields
      console.log(`- Bot[${i}] '${name}' OK`);
    }

    if (b.gridPrice !== undefined && b.gridPrice !== null) {
      const gp = b.gridPrice;
      const gpText = String(gp).trim().toLowerCase();
      const gpNum = Number(gp);
      const isAmaKeyword = /^ama(?:[1-4])?$/.test(gpText);
      const isNumeric = Number.isFinite(gpNum) && gpNum > 0;
      if (!isAmaKeyword && !isNumeric) {
        anyGridPriceWarnings = true;
        console.warn(`  └─ gridPrice warning: expected ama/ama1..ama4/positive number/null, got '${gp}'`);
      }
    }
  });

  // Print summary if all bots are valid
  if (!anyMissing) {
    console.log(`-> ${src}: all required fields present for every bot entry`);
  }
  if (!anyGridPriceWarnings) {
    console.log(`-> ${src}: gridPrice settings valid (or omitted) for every bot entry`);
  }
}

/**
 * Validate Live Configuration
 *
 * The live config (profiles/bots.json) is plain JSON.
 * It's used at runtime, so it must be valid JSON.
 * Parse errors are caught and reported without stopping execution.
 */
try {
  if (fs.existsSync(livePath)) {
    const rawLive = fs.readFileSync(livePath, 'utf8');
    const live = JSON.parse(rawLive);
    checkConfig(live, 'profiles/bots.json (live JSON)');
  } else {
    console.warn(`live config not found, skipping: ${livePath}`);
  }
} catch (err) {
  console.error('live config: parse error ->', getErrorMessage(err));
}

// Exit with success code (validation warnings don't cause non-zero exit)
process.exit(0);
export {};
