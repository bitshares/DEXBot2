#!/usr/bin/env node
'use strict';

import '../modules/storage/index.js';
import { getErrorMessage } from '../modules/utils/errors.js';
import { Config } from '../modules/config.js';
/**
 * AMA SIGNAL RUNNER
 *
 * Runs one candle-sync cycle (same logic as market_adapter), then returns
 * machine-readable AMA outputs per bot.
 *
 * Usage:
 *   node dist/market_adapter/ama_signal_runner.js
 *   node dist/market_adapter/ama_signal_runner.js --bot <bot>
 *   node dist/market_adapter/ama_signal_runner.js --bot <bot> --compact
 */

import { runOnceForAma } from './market_adapter.js';
import { walkCliArgs } from './cli_args.js';

interface AmaOverrides {
    deltaThresholdPercent?: number;
    bootstrapLookbackHours?: number;
    nativeBackfillHours?: number;
    maxStaleHours?: number;
    sourceRetries?: number;
    retryDelayMs?: number;
    maxPages?: number;
    pageLimit?: number;
}

interface CliArgs {
    bot: string | null;
    compact: boolean;
    overrides: AmaOverrides;
}

interface BotResult {
    botName: string;
    botKey: string;
    ok: boolean;
    source?: string;
    candleCount?: number;
    amaPrice?: number;
    previousCenterPrice?: number;
    deltaPercent?: number;
    thresholdPercent?: number;
    weights?: { meta?: { finalOffset?: number } };
    amaSlope?: { amaSlopeGated?: number; regimeMultiplier?: number };
    triggered?: boolean;
    triggerPath?: string;
    reason?: string;
}

interface AmaPayload {
    updatedAt?: string;
    results?: BotResult[];
    metrics?: Record<string, unknown> | null;
}

interface OutputBot {
    botName: string;
    botKey: string;
    ok: boolean;
    source: string | null;
    candleCount: number | null;
    amaPrice: number | null;
    previousCenterPrice: number | null;
    deltaPercent: number | null;
    thresholdPercent: number | null;
    finalOffset: number | null;
    amaSlopeGated: number | null;
    regimeMultiplier: number | null;
    triggered: boolean;
    triggerPath: string | null;
    reason: string | null;
}

interface OutputPayload {
    ok: boolean;
    updatedAt: string;
    metrics: Record<string, unknown> | null;
    botCount: number;
    bots: OutputBot[];
}

function printHelp(): void {
    console.log('AMA signal runner (one cycle): updates candles and returns latest AMA values.');
    console.log('');
    console.log('Usage:');
    console.log('  node dist/market_adapter/ama_signal_runner.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --bot <name|key>           Filter output to a specific bot name or botKey');
    console.log('  --deltaPercent <n>         Override trigger threshold percent');
    console.log('  --bootstrapHours <n>       Kibana bootstrap lookback hours');
    console.log('  --nativeBackfillHours <n>  Native incremental lookback hours');
    console.log('  --maxStaleHours <n>        Max accepted candle staleness');
    console.log('  --sourceRetries <n>        Retries for source calls');
    console.log('  --retryDelayMs <n>         Base retry delay in milliseconds');
    console.log('  --maxPages <n>             Max native history pages');
    console.log('  --pageLimit <n>            Native page size (max 101)');
    console.log('  --compact                  Print compact JSON');
    console.log('  --help, -h                 Show this help');
}

function parseArgs(): CliArgs {
    const args = Config.ARGS;
    const out: CliArgs = {
        bot: null,
        compact: false,
        overrides: {},
    };

    walkCliArgs(args, {
        onHelp: () => {
            printHelp();
            process.exit(0);
        },
        flag: {
            '--compact': () => { out.compact = true; },
        },
        value: {
            '--bot': (v) => { out.bot = v ?? null; },
            '--deltaPercent': (v) => { out.overrides.deltaThresholdPercent = Number(v); },
            '--bootstrapHours': (v) => { out.overrides.bootstrapLookbackHours = Number(v); },
            '--nativeBackfillHours': (v) => { out.overrides.nativeBackfillHours = Number(v); },
            '--maxStaleHours': (v) => { out.overrides.maxStaleHours = Number(v); },
            '--sourceRetries': (v) => { out.overrides.sourceRetries = Number(v); },
            '--retryDelayMs': (v) => { out.overrides.retryDelayMs = Number(v); },
            '--maxPages': (v) => { out.overrides.maxPages = Number(v); },
            '--pageLimit': (v) => { out.overrides.pageLimit = Number(v); },
        },
    });

    return out;
}

function isFiniteOrNull(v: unknown): number | null {
    return Number.isFinite(v) ? (v as number) : null;
}

function buildOutput(payload: AmaPayload | undefined | null, botFilter: string | null): OutputPayload {
    const bots: OutputBot[] = (payload?.results || []).map((r: BotResult) => ({
        botName: r.botName,
        botKey: r.botKey,
        ok: !!r.ok,
        source: r.source || null,
        candleCount: Number.isFinite(r.candleCount) ? (r.candleCount as number) : null,
        amaPrice: isFiniteOrNull(r.amaPrice),
        previousCenterPrice: isFiniteOrNull(r.previousCenterPrice),
        deltaPercent: isFiniteOrNull(r.deltaPercent),
        thresholdPercent: isFiniteOrNull(r.thresholdPercent),
        finalOffset: isFiniteOrNull(r.weights?.meta?.finalOffset),
        amaSlopeGated: isFiniteOrNull(r.amaSlope?.amaSlopeGated),
        regimeMultiplier: isFiniteOrNull(r.amaSlope?.regimeMultiplier),
        triggered: !!r.triggered,
        triggerPath: r.triggerPath || null,
        reason: r.reason || null,
    }));

    let filtered: OutputBot[] = bots;
    if (botFilter) {
        const target = String(botFilter).trim().toLowerCase();
        filtered = bots.filter((b: OutputBot) => String(b.botName || '').toLowerCase() === target || String(b.botKey || '').toLowerCase() === target);
    }

    return {
        ok: true,
        updatedAt: payload?.updatedAt || new Date().toISOString(),
        metrics: payload?.metrics || null,
        botCount: filtered.length,
        bots: filtered,
    };
}

async function main(): Promise<void> {
    const cli = parseArgs();
    const fixtureRaw: string | undefined = Config.AMA_SIGNAL_RUNNER_FIXTURE_JSON;
    let payload: AmaPayload;
    if (fixtureRaw) {
        payload = JSON.parse(fixtureRaw) as AmaPayload;
    } else {
        const originalStdoutWrite = process.stdout.write.bind(process.stdout) as (buffer: string | Uint8Array) => boolean;
        process.stdout.write = () => true;
        try {
            payload = (await runOnceForAma(cli.overrides)) as unknown as AmaPayload;
        } finally {
            process.stdout.write = originalStdoutWrite;
        }
    }
    const out = buildOutput(payload, cli.bot);
    const json = cli.compact ? JSON.stringify(out) : JSON.stringify(out, null, 2);
    process.stdout.write(`${json}\n`);
    process.exit(0);
}

main().catch((err: Error) => {
    const out = {
        ok: false,
        error: getErrorMessage(err),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
});
