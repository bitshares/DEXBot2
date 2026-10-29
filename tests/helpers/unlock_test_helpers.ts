const { EventEmitter } = require('events');
const { PATHS } = require('../../modules/paths');
const { loadSettingsFile, resolveRawBotEntries } = require('../../modules/bot_settings');

// Resolve through PATHS so the bots fixture is found from both the source
// tree (tsx era) and dist/tests when compiled (__dirname arithmetic would
// point at dist/profiles otherwise).
const botsFile = PATHS.PROFILES.BOTS_JSON;

export function getActiveBotNames() {
    const { config } = loadSettingsFile(botsFile, { silent: true, exitOnError: false });
    return resolveRawBotEntries(config)
        .filter((bot) => bot && bot.active !== false)
        .map((bot) => String(bot.name));
}

export function stripAnsi(text: string) {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

export function makeFakeChild(options: any = {}) {
    const { withStdio = false, emitClose = true } = options;
    const child = new EventEmitter() as any;
    child.killed = false;
    child.pid = 9999;
    child.kill = () => { child.killed = true; };
    child.unref = () => {};

    if (withStdio) {
        child.stdout = new EventEmitter();
        child.stdout.pipe = (dest) => dest;
        child.stderr = new EventEmitter();
        child.stderr.pipe = (dest) => dest;
    }

    process.nextTick(() => {
        child.emit('spawn');
        if (emitClose) {
            setImmediate(() => child.emit('close', 0));
        }
    });
    return child;
}

export function captureConsole() {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) errors.push(line);
    };

    return {
        logs,
        errors,
        restore() {
            console.log = originalLog;
            console.error = originalError;
        },
    };
}

export function hasActiveAmaBot() {
    const { config } = loadSettingsFile(botsFile, { silent: true, exitOnError: false });
    return resolveRawBotEntries(config)
        .some((bot) => {
            const gridPrice = typeof bot?.gridPrice === 'string' ? bot.gridPrice.trim().toLowerCase() : '';
            return bot && bot.active !== false && /^ama(?:[1-4])?$/.test(gridPrice);
        });
}

export function makeControllerStub(overrides: any = {}) {
    return {
        authenticateCredential: async () => ({ kind: 'vault', version: 1, vaultKeyHex: '00'.repeat(32) }),
        ensureCredentialDaemon: async () => false,
        getManagedDaemonPid: () => null,
        releaseManagedDaemon: () => {},
        isDaemonReady: async () => true,
        stopManagedDaemon: async () => {},
        waitForManagedDaemon: async () => 0,
        ...overrides,
    };
}
