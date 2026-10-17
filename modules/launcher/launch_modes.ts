
import { Config } from '../config.js';
const CONTROL_COMMANDS = new Set(['status', 'stat', 'stop', 'delete', 'restart', 'reload', 'stop-all', 'restart-all', 'reload-all', 'shutdown']);

/**
 * Internal command word for the supervisor-spawned bot worker. Shared by the
 * spawn site and the CLI intercept so the two cannot drift apart.
 */
const LAUNCHER_WORKER_COMMAND = 'worker';

function findFirstPositionalArg(args: string[]): string | null {
    return args.find((arg: string) => !arg.startsWith('-') && arg !== 'claw-only' && !CONTROL_COMMANDS.has(arg)) || null;
}

function extractPasswordFileArg(args: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--password-file' && i + 1 < args.length) {
            return args[i + 1];
        }
        const match = args[i].match(/^--password-file=(.+)$/);
        if (match) return match[1];
    }
    return null;
}

function stripUnlockFlags(args: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--headless' || a === '--isolated' || a === '--dryrun' || a === '--foreground' || a === 'claw-only' || a === '--claw-only' || a === 'credit' || a === '--credit') {
            continue;
        }
        if (a === '--password-file') {
            if (i < args.length - 1) {
                i++; // skip the value
            }
            continue;
        }
        if (a.startsWith('--password-file=')) {
            continue;
        }
        result.push(a);
    }
    return result;
}

function parseUnlockArgs(argv = process.argv) {
    const args = argv.slice(2);
    const clawOnly = args.includes('--claw-only') || args.includes('claw-only');
    const creditOnly = args.includes('--credit') || args.includes('credit');
    const isolated = args.includes('--isolated');
    const dryrun = args.includes('--dryrun');
    const headless = args.includes('--headless');
    const passwordFile = extractPasswordFileArg(args);
    const positionalArgs = stripUnlockFlags(args);

    if (positionalArgs[0] && CONTROL_COMMANDS.has(positionalArgs[0])) {
        let cmd = positionalArgs[0];
        const target = positionalArgs[1] || null;

        // Normalize whole-runtime controls: restart/reload/stop (no target or 'all') → *-all
        // and delete (no target or 'all') → delete. reload mirrors restart but
        // skips the credential daemon re-unlock.
        const wholeRuntime = cmd === 'restart' || cmd === 'reload' || cmd === 'stop' || cmd === 'delete';
        const consumedAll = wholeRuntime && (!target || target === 'all');
        if (consumedAll) {
            if (cmd !== 'delete') cmd += '-all';
        }

        return {
            botName: null,
            clawOnly: false,
            creditOnly: false,
            isolated: false,
            dryrun: false,
            headless: false,
            passwordFile: null,
            control: { cmd, target: consumedAll ? null : target },
        };
    }

    const resolvedBotName = clawOnly ? null : (findFirstPositionalArg(positionalArgs) || Config.BOT_NAME || null);
    return {
        botName: resolvedBotName,
        clawOnly,
        creditOnly,
        isolated,
        dryrun,
        headless,
        passwordFile,
    };
}

/**
 * Parse the arguments of the internal supervised worker command
 * (`dexbot worker [--dryrun] [bot]`). Reuses the launcher's flag-stripping and
 * positional resolution so the worker honors the same flag rules as `unlock`.
 *
 * @param args - Arguments following the `worker` command word.
 */
function parseWorkerArgs(args: string[]) {
    const dryrun = args.includes('--dryrun');
    const positionalArgs = stripUnlockFlags(args);
    return { dryrun, botName: findFirstPositionalArg(positionalArgs) };
}

function parsePm2Args(argv = process.argv) {
    const args = argv.slice(2);
    const headless = args.includes('--headless');
    const passwordFile = extractPasswordFileArg(args);

    // Strip known flags and their values before determining the command/target
    const filteredArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--headless') continue;
        if (a === '--password-file') { i++; continue; }
        if (a.startsWith('--password-file=')) continue;
        filteredArgs.push(a);
    }
    const command = filteredArgs[0] || null;
    const knownCommands = new Set(['claw-only', '--claw-only', 'update', 'stop', 'delete', 'restart', 'reload', 'help']);

    if (command === 'claw-only' || command === '--claw-only') {
        return {
            command: 'claw-only',
            target: null,
            clawOnly: true,
            headless,
            passwordFile,
        };
    }

    if (!command || !knownCommands.has(command)) {
        return {
            command: null,
            target: command,
            clawOnly: false,
            headless,
            passwordFile,
        };
    }

    return {
        command,
        target: filteredArgs[1] || null,
        clawOnly: false,
        headless,
        passwordFile,
    };
}

export { parsePm2Args, parseUnlockArgs, parseWorkerArgs, LAUNCHER_WORKER_COMMAND }

