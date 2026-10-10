'use strict';

/**
 * Shared argument walker for the market_adapter CLI entry points.
 *
 * The runners expose an overlapping set of source/window tuning flags that
 * must behave identically everywhere (`--bootstrapHours`, `--sourceRetries`,
 * `--maxPages`, the unsupported `--gridResetFactor` guard, ...). Callers
 * register handlers instead of re-listing the same switch cases; the walker
 * owns value consumption, `--help`/`-h`, and the unknown-flag error.
 *
 * Deliberately free of Node globals: callers pass in their own argv and own
 * the `process.exit` policy via `onHelp`, so this module stays browser-safe.
 */

export interface CliArgHandlers {
    /** Flags that take a value; receives the raw next argv token. */
    value?: Record<string, (raw: string | undefined) => void>;
    /** Flags that take no value. */
    flag?: Record<string, () => void>;
    /** Invoked for `--help` / `-h`; the caller decides whether to exit. */
    onHelp: () => void;
}

export function walkCliArgs(args: readonly string[], handlers: CliArgHandlers): void {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];

        if (a === '--gridResetFactor') {
            throw new Error('--gridResetFactor is no longer supported; use --deltaPercent <percent>');
        }
        if (a === '--help' || a === '-h') {
            handlers.onHelp();
            continue;
        }

        const valueHandler = handlers.value?.[a];
        if (valueHandler) {
            valueHandler(args[i + 1]);
            i++;
            continue;
        }
        const flagHandler = handlers.flag?.[a];
        if (flagHandler) {
            flagHandler();
            continue;
        }
        throw new Error(`Unknown argument: ${a}`);
    }
}
