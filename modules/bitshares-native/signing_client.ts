'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { createTransactionBuilder } from './tx/builder.js';
import * as txCache from './tx/tx_cache.js';
import Logger from '../order/logger.js';
import { getErrorMessage } from '../utils/errors.js';


const signingClientLogger = new Logger('SigningClient');

type ChainClientRef = Parameters<typeof createTransactionBuilder>[0];

interface TxBuilderLike {
    sign(keyBuf: Buffer | Uint8Array): unknown;
    prepare(): Promise<unknown>;
    addOperation(type: string, params: unknown): unknown;
    getOperationCount(): number;
    setRequiredFees(feeAssetId: unknown): unknown;
    limit_order_create(data: Record<string, unknown>): unknown;
    limit_order_cancel(data: unknown): unknown;
    limit_order_update(data: unknown): unknown;
    call_order_update(data: unknown): unknown;
    asset_settle(data: unknown): unknown;
    transfer(data: unknown): unknown;
    [key: string]: unknown;
}

interface BroadcastReply {
    operation_results?: unknown[];
    trx?: { operation_results?: unknown[] };
    id?: unknown;
    [key: string]: unknown;
}

export interface BtsdexTx {
    initPromise: Promise<void> | null;
    limit_order_create(data: Record<string, unknown>): unknown;
    limit_order_cancel(data: unknown): unknown;
    limit_order_update(data: unknown): unknown;
    call_order_update(data: unknown): unknown;
    asset_settle(data: unknown): unknown;
    transfer(data: unknown): unknown;
    addOperation(type: string, params: unknown): unknown;
    broadcast(): Promise<unknown>;
    setRequiredFees(feeAssetId: unknown): unknown;
    getOperationCount(): number;
    [key: string]: unknown;
}

interface SigningClient {
    client: {
        initPromise: Promise<void> | null;
        newTx(): BtsdexTx;
        broadcast(operation: unknown): Promise<unknown>;
        readonly accountId: string | null;
        accountName: string;
    };
    newTx(): BtsdexTx;
    broadcast(operation: unknown): Promise<unknown>;
    accountName: string;
    accountId(): string | null;
    dispose(): void;
}

function wifToBuffer(wif: unknown): Buffer {
    if (typeof wif !== 'string') return wif as Buffer;
    try {
        const { wifDecode } = require('./crypto/ecc_selector').default();
        return wifDecode(wif).privateKey;
    } catch (_) {
        return Buffer.from(wif, 'hex');
    }
}

function createSigningClient(chainClient: ChainClientRef, accountName: string, privateKey: unknown): SigningClient {
    if (!chainClient) throw new Error('chainClient is required');
    if (!accountName) throw new Error('accountName is required');
    if (!privateKey) throw new Error('privateKey is required');

    let _accountId: string | null = null;
    let _disposed = false;
    let _initPromise: Promise<void> | null = null;

    _initPromise = (async () => {
        try {
            const db = chainClient.db as unknown as {
                get_full_accounts(accounts: string[], subscribe: boolean): Promise<unknown>;
            };
            const full = await db.get_full_accounts([accountName], false) as
                Array<[string, { account?: { id?: string } }]> | null;
            if (full && full[0]) {
                if (full[0][1] && full[0][1].account && full[0][1].account.id) {
                    _accountId = full[0][1].account.id;
                }
            }
            // _initResolved handled below
        } catch (err) {
            // _initResolved handled below
        }
    })();

    function newTx() {
        if (_disposed) throw new Error('Signing client has been disposed');
        const tx = createTransactionBuilder(chainClient);

        const origSign = tx.sign.bind(tx);
        tx.sign = function() {
            return origSign(Buffer.isBuffer(privateKey)
                ? privateKey
                : wifToBuffer(privateKey));
        };

        return wrapTxForBtsdexCompat(tx, chainClient, privateKey);
    }

    function wrapTxForBtsdexCompat(tx: TxBuilderLike, client: ChainClientRef, key: unknown): BtsdexTx {
        const wrapped = {
            initPromise: _initPromise,

            limit_order_create(data: Record<string, unknown>): unknown {
                if (data.on_fill && Array.isArray(data.on_fill)) {
                    data.extensions = data.extensions || {};
                    (data.extensions as Record<string, unknown>).on_fill = data.on_fill;
                }
                delete data.on_fill;
                return tx.limit_order_create(data);
            },

            limit_order_cancel(data: unknown): unknown { return tx.limit_order_cancel(data); },
            limit_order_update(data: unknown): unknown { return tx.limit_order_update(data); },
            call_order_update(data: unknown): unknown { return tx.call_order_update(data); },
            asset_settle(data: unknown): unknown { return tx.asset_settle(data); },
            transfer(data: unknown): unknown { return tx.transfer(data); },

            addOperation(type: string, params: unknown): unknown { return tx.addOperation(type, params); },

            async broadcast() {
                await tx.prepare();
                const keyBuf = wifToBuffer(key);
                const signed = tx.sign(keyBuf) as { signedTxObject?: unknown };
                const clientRef = client as unknown as { broadcast?: Record<string, (...a: unknown[]) => Promise<unknown>> };
                const broadcast = clientRef.broadcast || {};
                const broadcastFn = typeof broadcast.broadcast_transaction_synchronous === 'function'
                    ? broadcast.broadcast_transaction_synchronous.bind(broadcast)
                    : typeof broadcast.broadcast_transaction === 'function'
                        ? broadcast.broadcast_transaction.bind(broadcast)
                        : null;
                if (!broadcastFn) {
                    throw new Error('Broadcast API does not support transaction broadcast');
                }
                let result: unknown;
                try {
                    result = await broadcastFn(signed.signedTxObject);
                } catch (err) {
                    const msg = String(getErrorMessage(err) || err || '');
                    if (/fee/i.test(msg)) {
                        txCache.invalidateFees();
                    }
                    throw err;
                }

                const reply = result as BroadcastReply | BroadcastReply[] | null | undefined;

                if (reply && !Array.isArray(reply) && Array.isArray(reply.operation_results)) {
                    return { ...reply, operation_results: reply.operation_results };
                }

                if (reply && !Array.isArray(reply) && reply.trx && Array.isArray(reply.trx.operation_results)) {
                    return { ...reply, operation_results: reply.trx.operation_results };
                }

                if (Array.isArray(reply) && reply[0] && reply[0].trx && Array.isArray(reply[0].trx.operation_results)) {
                    return { raw: reply, operation_results: reply[0].trx.operation_results };
                }

                if (reply && !Array.isArray(reply) && reply.id && !reply.operation_results) {
                    signingClientLogger.warn('Async broadcast returned no operation_results — tx may not have been processed');
                }

                return { ...(reply as Record<string, unknown> | null | undefined), operation_results: [] };
            },

            setRequiredFees(feeAssetId: unknown): unknown {
                return tx.setRequiredFees(feeAssetId);
            },

            getOperationCount() { return tx.getOperationCount(); },
        };

        return new Proxy(wrapped, {
            get(target: BtsdexTx, prop: string | symbol): unknown {
                if (prop === 'sign') {
                    return (keyBuf: Buffer) => tx.sign(keyBuf);
                }
                if (typeof prop === 'string' && !(prop in target)) {
                    return (data: unknown): unknown => tx.addOperation(prop, data);
                }
                return (target as Record<string, unknown>)[prop as string];
            },
        });
    }

    async function broadcast(operation: unknown): Promise<unknown> {
        if (_disposed) throw new Error('Signing client has been disposed');
        const tx = newTx();
        const op = operation as { op_name?: string; op_data?: unknown } | null | undefined;
        const method = op?.op_name ? tx[op.op_name] : undefined;
        if (op && op.op_name && typeof method === 'function') {
            (method as (data: unknown) => unknown)(op.op_data);
        } else if (op && op.op_name) {
            tx.addOperation(op.op_name, op.op_data);
        } else {
            throw new Error('Operation must have op_name and op_data');
        }
        return tx.broadcast();
    }

    return {
        client: {
            initPromise: _initPromise,
            newTx,
            broadcast,
            get accountId() { return _accountId; },
            accountName,
        },
        newTx,
        broadcast,
        accountName,
        accountId(): string | null { return _accountId; },
        /**
         * Dispose the signing client: zeroes the WIF buffer (heap-dump safety) and
         * marks the client as disposed.  After calling dispose(), any subsequent
         * newTx() or broadcast() call throws.  The caller MUST delete the reference
         * from the cache immediately after disposal — never use a disposed client.
         */
        dispose(): void {
            _disposed = true;
            if (Buffer.isBuffer(privateKey)) {
                privateKey.fill(0);
            }
            privateKey = null;
        },
    };
}

export { createSigningClient, wifToBuffer }

