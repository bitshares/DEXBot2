'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');

function clearModule(modulePath: string) {
  delete require.cache[modulePath];
}

function testClawCatalog() {
  const catalog = require('../modules/claw_catalog');
  const commands = catalog.listClawCommandNames();

  assert.ok(commands.length > 20);
  assert.strictEqual(commands.length, new Set(commands).size);
  assert.ok(commands.includes('manifest'));
  assert.ok(commands.includes('create-limit-order'));
  assert.ok(commands.includes('bot-settings-apply'));

  const createLimitOrder = catalog.getClawToolByCommand('create-limit-order');
  assert.strictEqual(createLimitOrder.risk, 'execute');
  assert.strictEqual(createLimitOrder.toolName, 'claw_create_limit_order');
  assert.ok(createLimitOrder.inputSchema.required.includes('sellAsset'));

  const sameTool = catalog.getClawToolByName('claw_create_limit_order');
  assert.strictEqual(sameTool.command, 'create-limit-order');

  const catalogCopy = catalog.getClawToolCatalog();
  catalogCopy[0].command = 'mutated';
  assert.notStrictEqual(catalog.getClawToolCatalog()[0].command, 'mutated');

  const examples = catalog.buildClawCommandExamples('node dist/claw/scripts/claw_bridge.js');
  assert.ok(examples.some((line: any) => line.startsWith('node dist/claw/scripts/claw_bridge.js manifest')));
  assert.ok(examples.some((line: any) => line.includes('bot-settings-apply')));
}

async function testCredentialDaemonClient() {
  const clientPath = require.resolve('../modules/dexbot_credential_client');
  const runtimePath = require.resolve('../../modules/credential_runtime');
  clearModule(clientPath);
  clearModule(runtimePath);
  const client = require('../modules/dexbot_credential_client');
  const runtime = require('../../modules/credential_runtime');

  const originalExistsSync = fs.existsSync;
  const originalLstatSync = fs.lstatSync;
  const originalCreateConnection = net.createConnection;

  const credStatFor = (filePath: any) => ({
    isSymbolicLink: () => false,
    isFile: () => !String(filePath).endsWith('.sock'),
    isSocket: () => String(filePath).endsWith('.sock'),
    isDirectory: () => false,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    mode: 0o100600,
  });

  fs.lstatSync = (filePath: any) => {
    if (String(filePath).includes('cred')) return credStatFor(filePath);
    return originalLstatSync.call(fs, filePath);
  };

  try {
    assert.strictEqual(client.DEFAULT_SOCKET_PATH, runtime.getCredentialSocketPath());
    assert.strictEqual(client.DEFAULT_READY_FILE, runtime.getCredentialReadyFilePath());

    let readyChecks = 0;
    fs.existsSync = (filePath: any) => {
      if (String(filePath).includes('cred')) {
        readyChecks += 1;
        return readyChecks >= 2;
      }
      return originalExistsSync.call(fs, filePath);
    };

    await client.waitForCredentialDaemon(50, {
      pollIntervalMs: 0,
      readyFilePath: '/tmp/dexbot-cred.ready',
      socketPath: '/tmp/dexbot-cred.sock'
    });
    assert.ok(readyChecks >= 2);

    fs.existsSync = () => false;
    await assert.rejects(
      client.waitForCredentialDaemon(5, {
        pollIntervalMs: 0,
        readyFilePath: '/tmp/dexbot-cred.ready',
        socketPath: '/tmp/dexbot-cred.sock'
      }),
      /Timed out waiting for DEXBot2 credential daemon/
    );

    fs.existsSync = () => true;
    assert.strictEqual(
      client.isCredentialDaemonReady({
        readyFilePath: '/tmp/dexbot-cred.ready',
        socketPath: '/tmp/dexbot-cred.sock'
      }),
      true
    );
  } finally {
    fs.existsSync = originalExistsSync;
    fs.lstatSync = originalLstatSync;
    net.createConnection = originalCreateConnection;
    clearModule(clientPath);
    clearModule(runtimePath);
  }
}

function testDexbotBridgeRootResolution() {
  const bridge = require('../modules/dexbot_bridge');
  const root = bridge.getDexbot2Root();

  // The resolved root must be a real DEXBot2 checkout that contains this
  // test's compiled location and the module tree the bridge resolves against.
  const rel = path.relative(root, __dirname);
  assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), 'resolved DEXBot2 root must contain this test');
  assert.ok(fs.existsSync(path.join(root, 'package.json')), 'resolved DEXBot2 root must contain package.json');
}

async function main() {
  testClawCatalog();
  testDexbotBridgeRootResolution();
  await testCredentialDaemonClient();
  console.log('claw catalog and credential client tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
