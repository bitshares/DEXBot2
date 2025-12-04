const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { IndexDB } = require('../modules/indexdb');

async function main() {
  const tmpFile = path.join(__dirname, 'tmp', 'indexdb_test.json');
  try { fs.rmSync(tmpFile, { force: true }); } catch (e) {}
  // ensure directory
  try { fs.mkdirSync(path.dirname(tmpFile), { recursive: true }); } catch (e) {}

  const db = new IndexDB({ profilesPath: tmpFile });

  const bots = [{ name: 'My Bot', assetA: 'ASSET.A', assetB: 'ASSET.B', active: true }];
  db.ensureBotEntries(bots);
  const botKey = bots[0].botKey;

  const orders = [
    { id: '1', type: 'sell', state: 'virtual', size: 1 },
    { id: '2', type: 'sell', state: 'active', size: 2 },
    { id: '3', type: 'buy', state: 'virtual', size: 5 },
    { id: '4', type: 'buy', state: 'active', size: 3 },
    { id: '5', type: 'spread', state: 'virtual', size: 10 }
  ];

  db.storeMasterGrid(botKey, orders);

  const resByKey = db.getDBAssetBalances(botKey);
  assert(resByKey, 'Expected non-null result for botKey');
  assert.strictEqual(resByKey.assetA.virtual, 1);
  assert.strictEqual(resByKey.assetA.active, 2);
  assert.strictEqual(resByKey.assetB.virtual, 5);
  assert.strictEqual(resByKey.assetB.active, 3);

  const resByName = db.getDBAssetBalances('My Bot');
  assert(resByName, 'Expected non-null result for bot name');
  assert.deepStrictEqual(resByKey, resByName);

  console.log('IndexDB getDBAssetBalances tests passed');
  process.exit(0);
}

main().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(2); });
