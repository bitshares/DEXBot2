#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ORDERS_DIR = path.join(__dirname, '..', 'profiles', 'orders');
const SHARED_ORDERS_FILE = path.join(__dirname, '..', 'profiles', 'orders.json');

function migrateFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.bots) return null;

    let changed = false;
    for (const key of Object.keys(data.bots)) {
      const entry = data.bots[key];
      if (!entry) continue;
      const pp = entry.pendingProceeds;
      if (pp && (typeof pp.buy === 'number' || typeof pp.sell === 'number')) {
        const buy = Number(pp.buy || 0);
        const sell = Number(pp.sell || 0);
        if (!entry.cacheFunds) entry.cacheFunds = { buy: 0, sell: 0 };
        entry.cacheFunds.buy = (Number(entry.cacheFunds.buy || 0) + buy);
        entry.cacheFunds.sell = (Number(entry.cacheFunds.sell || 0) + sell);
        delete entry.pendingProceeds;
        entry.lastUpdated = new Date().toISOString();
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      return true;
    }
    return false;
  } catch (e) {
    console.error('Failed to migrate', filePath, e.message);
    return null;
  }
}

function run() {
  console.log('Starting pendingProceeds -> cacheFunds migration...');
  // Migrate shared file if exists
  if (fs.existsSync(SHARED_ORDERS_FILE)) {
    const res = migrateFile(SHARED_ORDERS_FILE);
    console.log(`Migrated ${SHARED_ORDERS_FILE}:`, res === true ? 'changed' : res === false ? 'no-change' : 'skipped');
  }

  // Per-bot files
  if (fs.existsSync(ORDERS_DIR) && fs.statSync(ORDERS_DIR).isDirectory()) {
    const files = fs.readdirSync(ORDERS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const fp = path.join(ORDERS_DIR, f);
      const res = migrateFile(fp);
      console.log(`Migrated ${fp}:`, res === true ? 'changed' : res === false ? 'no-change' : 'skipped');
    }
  } else {
    console.log('No per-bot orders directory found; skipping.');
  }

  console.log('Migration complete.');
}

if (require.main === module) run();
