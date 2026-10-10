'use strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);


import * as chainKeys from './chain_keys.js';
import * as credentialPolicy from './credential_policy.js';
import * as credentialRuntime from './credential_runtime.js';
import {
    executeOperationsViaCredentialDaemon,
    BroadcastUncertainError,
} from './dexbot_credential_client.js';
import { DAEMON_ERRORS } from './constants.js';
import { PATHS } from './paths.js';
import { getStorage } from './storage/index.js';
import { runtime } from './runtime.js';
import { sleep } from './order/utils/system.js';
import { getErrorMessage } from './utils/errors.js';
import { registerExitWipe } from './graceful_shutdown.js';
import Logger from './order/logger.js';

const storage = getStorage();
const keyStoreLogger = new Logger('key-store');

/** A daemon-issued signing token (structural view). */
interface DaemonSigningTokenLike {
    socketPath?: string;
    sessionId?: string | null;
    botHmacSecret?: string | null;
    batchId?: string | null;
}

/** One chain operation to sign/broadcast. */
interface ChainOrderOperation {
    op_name: string;
    op_data: unknown;
}

const liveDaemonTokens = new Set<{ botHmacSecret?: string | null }>();
let exitWipeRegistered = false;

function trackDaemonTokenForExitWipe(token: unknown): void {
    if (!token || typeof token !== 'object') return;
    liveDaemonTokens.add(token as { botHmacSecret?: string | null });
    if (exitWipeRegistered) return;
    exitWipeRegistered = true;
    registerExitWipe('SigningTokenHmacSecretWipe', () => {
        for (const t of liveDaemonTokens) {
            try { t.botHmacSecret = null; } catch (_) {}
        }
        liveDaemonTokens.clear();
    });
}

export interface SigningResult {
    success: boolean;
    raw?: unknown;
    operation_results?: unknown[];
}

export interface KeyStore {
    resolveSigningKey(accountName: string, vaultSecret?: unknown, chainClient?: unknown): Promise<unknown>;
    isDaemonSigningKey(key: unknown): boolean;
    executeOperations(accountName: string, operations: ChainOrderOperation[], signingKey: unknown, extraOptions?: Record<string, unknown>): Promise<SigningResult>;
}

function buildDaemonBroadcastOptions(signingKey: DaemonSigningTokenLike, extraOptions: Record<string, unknown>, sessionIdOverride?: string): Record<string, unknown> {
    return {
        socketPath: signingKey.socketPath,
        sessionId: sessionIdOverride !== undefined ? sessionIdOverride : (signingKey.sessionId || null),
        botHmacSecret: signingKey.botHmacSecret || null,
        requestType: 'broadcast',
        batchId: signingKey.batchId || null,
        ...(extraOptions.nodeUrl ? { nodeUrl: extraOptions.nodeUrl } : {}),
        ...(typeof extraOptions.onNodeFailed === 'function' ? { onNodeFailed: extraOptions.onNodeFailed } : {}),
    };
}

function normalizeDaemonResult(result: { raw?: unknown; operation_results?: unknown[] }): SigningResult {
    return {
        success: true,
        raw: result.raw || null,
        operation_results: Array.isArray(result.operation_results) ? result.operation_results : [],
    };
}

async function broadcastViaChainOrders(accountName: string, operations: ChainOrderOperation[], signingKey: unknown): Promise<SigningResult> {
    const { createAccountClient, broadcastTxWithClassification } = require('./chain_orders');
    const acc = await createAccountClient(accountName, signingKey);
    await acc.initPromise;
    const tx = acc.newTx();
    for (const op of operations) {
        const methodName = op.op_name;
        if (typeof tx[methodName] === 'function') {
            tx[methodName](op.op_data);
        } else {
            throw new Error(`Transaction builder does not support ${methodName}`);
        }
    }
    await broadcastTxWithClassification(tx, accountName, operations);
    return { success: true };
}

export class DaemonKeyStore implements KeyStore {
    async resolveSigningKey(accountName: string, vaultSecret?: unknown, chainClient?: unknown): Promise<unknown> {
        if (vaultSecret) {
            return chainKeys.resolvePrivateKey(accountName, vaultSecret, chainClient);
        }

        if (await chainKeys.isDaemonResponsive()) {
            try {
                const sessionId = await chainKeys.probeAccountInDaemon(accountName);
                const botHmacSecret = credentialPolicy.loadBotHmacSecret(
                    accountName,
                    PATHS.PROFILES.DAEMON_POLICIES_JSON,
                    { quiet: true }
                );
                const token = chainKeys.createDaemonSigningToken(accountName, { sessionId, botHmacSecret });
                trackDaemonTokenForExitWipe(token);
                return token;
            } catch {
                const unlockSecret = await chainKeys.authenticate();
                return chainKeys.resolvePrivateKey(accountName, unlockSecret, chainClient);
            }
        }

        const unlockSecret = await chainKeys.authenticate();
        return chainKeys.resolvePrivateKey(accountName, unlockSecret, chainClient);
    }

    isDaemonSigningKey(key: unknown): boolean {
        return chainKeys.isDaemonSigningToken(key);
    }

    async executeOperations(accountName: string, operations: ChainOrderOperation[], signingKey: unknown, extraOptions: Record<string, unknown> = {}): Promise<SigningResult> {
        const daemonKey = signingKey as DaemonSigningTokenLike;
        if (this.isDaemonSigningKey(signingKey)) {
            if (!daemonKey.botHmacSecret) {
                keyStoreLogger.error(
                    `Daemon signing token for ${accountName} has no botHmacSecret — the daemon will reject this request ` +
                    `(Strict Mode). This happens when a broadcast is attempted after the bot shut down or the token lost ` +
                    `its secret. Restarting the bot resolves it.`
                );
            }
            try {
                const result = await executeOperationsViaCredentialDaemon(accountName, operations, buildDaemonBroadcastOptions(daemonKey, extraOptions));
                return normalizeDaemonResult(result);
            } catch (err) {
                if (err instanceof BroadcastUncertainError) throw err;
                if (getErrorMessage(err) && (getErrorMessage(err).includes(DAEMON_ERRORS.SESSION_EXPIRED) || getErrorMessage(err).includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED))) {
                    const isSourceAuthError = getErrorMessage(err).includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED);
                    if (isSourceAuthError) {
                        try {
                            const readyFile = credentialRuntime.getCredentialReadyFilePath();
                            if (storage.exists(readyFile)) {
                                const daemonInfo = storage.readJSON(readyFile);
                                if (daemonInfo && typeof daemonInfo.pid === 'number') {
                                    runtime.kill(daemonInfo.pid, 'SIGHUP');
                                }
                            }
                        } catch {}
                    }

                    const newSessionId = await chainKeys.probeAccountInDaemon(accountName);
                    daemonKey.sessionId = newSessionId as string | null;

                    if (isSourceAuthError) {
                        try {
                            const freshSecret = credentialPolicy.loadBotHmacSecret(
                                accountName,
                                PATHS.PROFILES.DAEMON_POLICIES_JSON,
                                { quiet: true }
                            );
                            if (freshSecret && freshSecret !== daemonKey.botHmacSecret) {
                                daemonKey.botHmacSecret = freshSecret;
                                keyStoreLogger.warn(`Reloaded botHmacSecret from disk for ${accountName} before retry`);
                            }
                        } catch (_) {}
                        await sleep(500);
                    }

                    const retryResult = await executeOperationsViaCredentialDaemon(accountName, operations, buildDaemonBroadcastOptions(daemonKey, extraOptions, daemonKey.sessionId ?? undefined));
                    return normalizeDaemonResult(retryResult);
                }
                throw err;
            }
        }

        return broadcastViaChainOrders(accountName, operations, signingKey);
    }
}

let _instance: KeyStore | null = null;

export function setKeyStore(impl: KeyStore | null): void {
    _instance = impl;
}

export function resetKeyStore(): void {
    _instance = null;
}

export function getKeyStore(): KeyStore {
    if (!_instance) {
        _instance = new DaemonKeyStore();
    }
    return _instance;
}
