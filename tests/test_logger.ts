const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
console.log('Running logger tests');

const Logger = require('../modules/order/index').default.logger;
const { createPm2AwareLogger, isPm2LogCaptureActive } = require('../modules/order/logger');
const { unlink: safeUnlink } = require('../modules/storage').getStorage();

// Capture console output by stream
let captured: any[] = [];
let capturedWarn: any[] = [];
let capturedError: any[] = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...args) => { captured.push(args.join(' ')); };
console.warn = (...args) => { capturedWarn.push(args.join(' ')); };
console.error = (...args) => { capturedError.push(args.join(' ')); };

const logger = new Logger('Test', { level: 'debug' });
logger.marketName = 'TEST/PAIR';

// Should log when level is debug (and info > debug)
logger.log('hello world', 'info');
logger.log('debug message', 'debug');
logger.log('warning message', 'warn');
logger.log('error message', 'error');

// logOrderGrid should print header and market
const sampleOrders = [ { price: 100, type: 'buy', state: 'virtual', size: 1 }, { price: 200, type: 'sell', state: 'virtual', size: 2 } ];
logger.logOrderGrid(sampleOrders, 150);

// Test logFundsStatus and displayStatus using a small manager-like stub
const mgrStub = {
	marketName: 'TEST/PAIR',
	config: { assetA: { symbol: 'BASE', precision: 8 }, assetB: { symbol: 'QUOTE', precision: 4 }, market: 'TEST/PAIR' },
	funds: { available: { buy: 1.2345, sell: 2.3456 }, committed: { buy: 0.5, sell: 0.25 }, total: { buy: 10, sell: 20 } },
	currentSpreadCount: 2,
	initialSpreadCount: 3,
	outOfSpread: 0,
	getOrdersByTypeAndState: (type, state) => {
		if (state === 'active') return [1,2];
		if (state === 'partial') return [1];
		if (state === 'virtual') return [1,2,3,4];
		return [];
	},
	calculateCurrentSpread: () => 3.1415
};

logger.logFundsStatus(mgrStub, '', true);  // Force display for testing (forceDetailed=true)
logger.displayStatus(mgrStub, true);  // Force display for testing (forceOutput=true)

// Restore console.log
console.log = origLog;
console.warn = origWarn;
console.error = origError;

// Assertions
const joined = captured.join('\n');
assert(joined.includes('hello world'), 'should include the info message');
assert(joined.includes('debug message'), 'should include debug message');
assert.strictEqual(capturedWarn.length, 1, 'warn messages should use console.warn');
assert(capturedWarn[0].includes('warning message'), 'warn stream should include warning message');
assert.strictEqual(capturedError.length, 1, 'error messages should use console.error');
assert(capturedError[0].includes('error message'), 'error stream should include error message');
assert(joined.includes('ORDER GRID') || joined.includes('ORDER GRID'), 'should include ORDER GRID header');
assert(joined.includes('TEST/PAIR'), 'should include market name in grid');
// Ensure funds are displayed in the output
assert(joined.includes('funds.available') || joined.includes('Available'), 'should include available funds label');
assert(joined.includes('total.chain') || joined.includes('total.grid'), 'should include total funds labels');

const { Config } = require('../modules/config');
const originalPmExecPath = process.env.pm_exec_path;
const originalPmOutLogPath = process.env.pm_out_log_path;
const originalPmErrLogPath = process.env.pm_err_log_path;
const origConfigPmExec = Config.pm_exec_path;
const origConfigPmOut = Config.pm_out_log_path;
const origConfigPmErr = Config.pm_err_log_path;
process.env.pm_exec_path = 'pm2';
process.env.pm_out_log_path = '/tmp/dexbot-test.log';
Config.pm_exec_path = 'pm2';
Config.pm_out_log_path = '/tmp/dexbot-test.log';
assert.strictEqual(isPm2LogCaptureActive(), true, 'pm_out_log_path/pm_err_log_path presence must classify PM2 log capture as active');
assert.strictEqual(createPm2AwareLogger('default').quiet, false, 'PM2-aware logger must NOT auto-quiet: PM2 captures stdout and direct file writes are suppressed');
assert.strictEqual(createPm2AwareLogger('verbose', { quietUnderPm2: false }).quiet, false, 'explicit quietUnderPm2=false keeps stdout enabled under PM2');
assert.strictEqual(createPm2AwareLogger('legacy-quiet', { quietUnderPm2: true }).quiet, true, 'explicit quietUnderPm2=true opts back into the legacy silent behaviour');

// Regression: the OrderManager-style logger (logFile set, no quiet override)
// must still reach stdout under PM2, otherwise every bot log line is dropped.
const pm2DirectLogFile = path.join(os.tmpdir(), `dexbot-logger-pm2-${process.pid}.log`);
safeUnlink(pm2DirectLogFile)
const pm2Logger = new Logger('pm2-direct-file', { logFile: pm2DirectLogFile });
let pm2Captured: any[] = [];
console.log = (...args) => { pm2Captured.push(args.join(' ')); };
pm2Logger.info('pm2 stdout should remain visible');
console.log = origLog;
assert(pm2Captured.some((line) => line.includes('pm2 stdout should remain visible')), 'PM2 logger should emit stdout for PM2 capture');
assert(!pm2Captured.some((line) => /\d{4}-\d{2}-\d{2}T/.test(line)), 'PM2 logger should not add its own timestamp');
assert.strictEqual(fs.existsSync(pm2DirectLogFile), false, 'direct logger file writes should be suppressed when PM2 log paths are active');

// The exact OrderManager configuration that silently dropped every bot log
// line: logFile set, no quiet override. It must not be quiet under PM2.
const mgrLogger = new Logger('mgr-pm2', { logFile: path.join(os.tmpdir(), 'mgr-pm2.log') });
assert.strictEqual(mgrLogger.quiet, false, 'manager-style logger must stay on under PM2');

Config.pm_out_log_path = undefined;
Config.pm_err_log_path = undefined;
assert.strictEqual(isPm2LogCaptureActive(), false, 'clearing PM2 log paths must classify PM2 log capture as inactive');
Config.pm_exec_path = origConfigPmExec;
Config.pm_out_log_path = origConfigPmOut;
Config.pm_err_log_path = origConfigPmErr;
if (originalPmExecPath === undefined) delete process.env.pm_exec_path;
else process.env.pm_exec_path = originalPmExecPath;
if (originalPmOutLogPath === undefined) delete process.env.pm_out_log_path;
else process.env.pm_out_log_path = originalPmOutLogPath;
if (originalPmErrLogPath === undefined) delete process.env.pm_err_log_path;
else process.env.pm_err_log_path = originalPmErrLogPath;

// ---- New feature tests ----

// 1. critical level
const critLogger = new Logger('CritTest', { level: 'warn' });
let critCaptured: any[] = [];
console.log = (...args) => { critCaptured.push(args.join(' ')); };
critLogger.critical('this is critical');
console.log = origLog;
assert(critCaptured.some(line => line.includes('[CRITICAL]') && line.includes('this is critical')), 'critical() should produce CRITICAL level output');

// critical passes when logger level is error (critical > error)
const filteredLogger = new Logger('FilterTest', { level: 'error' });
let filteredCaptured: any[] = [];
console.log = (...args) => { filteredCaptured.push(args.join(' ')); };
filteredLogger.critical('critical should appear with level=error');
console.log = origLog;
assert(filteredCaptured.some(line => line.includes('critical should appear')), 'critical should pass when level=error (4 >= 3)');

// debug suppressed when level=warn
const warnLogger = new Logger('WarnFilter', { level: 'warn' });
let warnCaptured: any[] = [];
console.log = (...args) => { warnCaptured.push(args.join(' ')); };
warnLogger.debug('should not appear at warn');
console.log = origLog;
assert.strictEqual(warnCaptured.length, 0, 'debug should be suppressed when level=warn');

// 2. correlation ID
const corrLogger = new Logger('CorrTest', { correlationId: 'abc-123' });
assert.strictEqual(corrLogger.correlationId, 'abc-123', 'correlationId should be set from constructor');
corrLogger.setCorrelationId('xyz-789');
assert.strictEqual(corrLogger.correlationId, 'xyz-789', 'setCorrelationId should update the value');
corrLogger.setCorrelationId(null);
assert.strictEqual(corrLogger.correlationId, null, 'setCorrelationId(null) should clear');

// 3. JSON output
const jsonLogFile = path.join(os.tmpdir(), `dexbot-logger-json-${process.pid}.log`);
safeUnlink(jsonLogFile)
const jsonLogger = new Logger('JsonTest', {
    logFile: jsonLogFile,
    level: 'info',
    configOverride: { json: { enabled: true }, display: {}, changeTracking: { enabled: false }, categories: {}, rotation: { enabled: false, maxSize: 0, maxFiles: 0 } }
});
jsonLogger.info('test json message');
jsonLogger.setCorrelationId('corr-999');
jsonLogger.warn('json with corr id');
await jsonLogger.flush();
const jsonContent = fs.readFileSync(jsonLogFile, 'utf8');
const jsonLines = jsonContent.trim().split('\n').filter(l => l.startsWith('{'));
assert(jsonLines.length >= 2, 'JSON output should produce at least 2 JSON lines');
const parsed1 = JSON.parse(jsonLines[0]);
assert.strictEqual(parsed1.level, 'INFO', 'JSON level should be INFO');
assert.strictEqual(parsed1.category, 'JsonTest', 'JSON category should be JsonTest');
assert(parsed1.message.includes('test json message'), 'JSON should contain the message');
assert.strictEqual(parsed1.correlationId, undefined, 'first JSON line should not have correlationId');
const parsed2 = JSON.parse(jsonLines[1]);
assert.strictEqual(parsed2.correlationId, 'corr-999', 'second JSON line should include correlationId');
assert.strictEqual(parsed2.level, 'WARN', 'JSON level should be WARN');
safeUnlink(jsonLogFile)

// 4. flush()
const flushLogFile = path.join(os.tmpdir(), `dexbot-logger-flush-${process.pid}.log`);
safeUnlink(flushLogFile)
const flushLogger = new Logger('FlushTest', {
    logFile: flushLogFile,
    level: 'info',
    configOverride: { json: { enabled: false }, display: {}, changeTracking: { enabled: false }, categories: {}, rotation: { enabled: false, maxSize: 0, maxFiles: 0 } }
});
flushLogger.info('flush test message');
await flushLogger.flush();
const flushContent = fs.readFileSync(flushLogFile, 'utf8');
assert(flushContent.includes('flush test message'), 'flush() should ensure data is written to file');
safeUnlink(flushLogFile)

// 5. Levels map includes critical
assert.strictEqual(logger.levels.critical, 4, 'critical should be level 4 in the levels map');

// 6. Info level suppresses debug
const infoLogger = new Logger('InfoTest', { level: 'info' });
let infoCaptured: any[] = [];
console.log = (...args) => { infoCaptured.push(args.join(' ')); };
infoLogger.debug('should be suppressed');
infoLogger.info('should appear');
console.log = origLog;
assert.strictEqual(infoCaptured.length, 1, 'info-level logger should suppress debug');
assert(infoCaptured[0].includes('should appear'), 'info-level logger should show info messages');

// 7. Rotation — write enough to trigger rotate, verify .1 exists with expected content
const rotateLogFile = path.join(os.tmpdir(), `dexbot-logger-rotate-${process.pid}.log`);
safeUnlink(rotateLogFile)
safeUnlink(rotateLogFile + '.1')
safeUnlink(rotateLogFile + '.2')
const rotateLogger = new Logger('RotateTest', {
    logFile: rotateLogFile,
    level: 'info',
    configOverride: {
        json: { enabled: false },
        display: {},
        changeTracking: { enabled: false },
        categories: {},
        rotation: { enabled: true, maxSize: 500, maxFiles: 2 }
    }
});
// perFileLimit = 500 / 3 ≈ 166 bytes. Each line is ~230 bytes.
// First write creates the file (no rotation — file didn't exist at check time).
rotateLogger.info('X'.repeat(200));
await rotateLogger.flush();
// Second write triggers rotation: file now exists at ~230 bytes >= 166
rotateLogger.info('Y'.repeat(200));
await rotateLogger.flush();
assert(fs.existsSync(rotateLogFile), 'current log file should exist');
assert(fs.existsSync(rotateLogFile + '.1'), 'rotated file .1 should exist');
const rotatedContent = fs.readFileSync(rotateLogFile + '.1', 'utf8');
assert(rotatedContent.includes('X'.repeat(200)), 'rotated .1 should contain first write');
assert(!rotatedContent.includes('Y'.repeat(200)), 'rotated .1 should NOT contain second write');
// Third write triggers second rotation: .1 → .2, current → .1
rotateLogger.info('Z'.repeat(200));
await rotateLogger.flush();
assert(fs.existsSync(rotateLogFile + '.1'), 'rotated .1 should exist after third write');
assert(fs.existsSync(rotateLogFile + '.2'), 'rotated .2 should exist after third write');
const rotated2Content = fs.readFileSync(rotateLogFile + '.2', 'utf8');
assert(rotated2Content.includes('X'.repeat(200)), 'rotated .2 should contain first write');
// Fourth write triggers third rotation → .3 should be pruned (maxFiles=2)
rotateLogger.info('W'.repeat(200));
await rotateLogger.flush();
assert(!fs.existsSync(rotateLogFile + '.3'), 'rotated .3 should be pruned (maxFiles=2)');
safeUnlink(rotateLogFile)
safeUnlink(rotateLogFile + '.1')
safeUnlink(rotateLogFile + '.2')

console.log('logger tests passed');
}

main().catch(err => { console.error('Logger test failed:', err); process.exit(1); });
