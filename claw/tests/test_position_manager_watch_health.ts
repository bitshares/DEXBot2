'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('../../tests/helpers/esm_mocks');

// Compiled ESM graphs cannot be mocked via require.cache or Module._load; the
// helper installs loader hooks so position_manager_watch links against the
// mock exports instead of running real chain code.
function clearModule(_modulePath: string) {
  /* no-op under ESM hooks */
}

function registerMock(modulePath: string, exports: any) {
  defineEsmMockAbs(modulePath, Object.keys(exports), exports);
}

async function testHealthWritesStayOrdered() {
  const watcherModulePath = require.resolve('../modules/position_manager_watch');
  const positionManagerPath = require.resolve('../modules/position_manager');
  const bitsharesClientPath = require.resolve('../modules/bitshares_client');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-watch-'));
  const healthPath = path.join(tmpDir, 'watcher-health.json');

  let syncCount = 0;
  class MockPositionManager {
    [key: string]: any;
    constructor() {}

    async syncAllPositions() {
      syncCount += 1;
      if (syncCount === 1) {
        return { ok: true };
      }
      if (syncCount === 2) {
        throw new Error('timer failure');
      }
      return { ok: true };
    }

    async watchAccount() {
      return async () => {};
    }
  }

  // ESM hooks turn mock keys into synthetic named re-exports, so every name
  // position_manager_watch statically imports must exist here.
  registerMock(positionManagerPath, {
    DEFAULT_STATE_PATH: path.join(os.tmpdir(), 'unused-positions.json'),
    PositionManager: MockPositionManager
  });

  registerMock(bitsharesClientPath, {
    waitForConnected: async () => {}
  });

  clearModule(watcherModulePath);
  const { createPositionManagerWatcher } = require('../modules/position_manager_watch');

  try {
    const watcher = createPositionManagerWatcher({
      accountName: 'tester',
      healthPath,
      maxConsecutiveFailures: 1,
      logger: {
        error: () => {},
        info: () => {},
        warn: () => {}
      },
      syncIntervalMs: 20
    });

    const started = await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await started.stop();

    const health = JSON.parse(await fs.readFile(healthPath, 'utf8'));
    assert.strictEqual(health.status, 'healthy', 'latest health write should win');
    assert.strictEqual(health.consecutiveFailures, 0, 'health should reset after a later success');
    assert.ok(syncCount >= 3, 'test should exercise the initial sync plus failure and recovery');
  } finally {
    clearModule(watcherModulePath);
    clearModule(positionManagerPath);
    clearModule(bitsharesClientPath);
  }
}

runEsmMockStages(
  ['health-writes-stay-ordered'],
  async (stage: string) => {
    if (stage === 'health-writes-stay-ordered') {
      await testHealthWritesStayOrdered();
      return;
    }
    throw new Error(`Unknown stage: ${stage}`);
  }
);
