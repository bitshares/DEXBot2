'use strict';
/**
 * modules/broadcast_failure.ts - Broadcast failure classification
 *
 * Decides whether a failed credential-daemon broadcast may be retried without
 * risking duplicate on-chain orders. The cardinal rule: a transaction may
 * only be re-signed when it PROVABLY never reached the chain. Anything that
 * could have been transmitted is 'uncertain' and must be deferred to the
 * bot's verify-before-retry machinery (COW retry verification, startup
 * adoption) instead of being re-broadcast.
 *
 * Mirrors the failure modes produced by modules/bitshares-native/transport.ts
 * call() and the signing client (modules/bitshares-native/signing_client.ts).
 */

type BroadcastFailureClass = 'retryable' | 'uncertain' | 'definite';

/**
 * Classify a broadcast-phase failure.
 *
 * 'retryable' — the transaction provably never reached the chain: pre-send
 *               failures in transport.call() (WebSocket not open, frame send
 *               errors) and connect-sweep failures.
 * 'uncertain' — the transaction may have landed (RPC timeout, connection
 *               dropped while the response was pending, unknown errors).
 *               Must NOT be re-signed, or the order is duplicated on chain.
 * 'definite'  — the chain rejected the transaction (numeric JSON-RPC error,
 *               e.g. 10 = insufficient balance) or the transaction could not
 *               be built: nothing landed and retrying the identical ops
 *               cannot change the outcome.
 *
 * @param {unknown} err - The thrown error (code + message).
 * @returns {BroadcastFailureClass}
 */
export function classifyBroadcastFailure(err: unknown): BroadcastFailureClass {
    if (!err) return 'definite';
    const e = err as { code?: unknown; message?: unknown };
    const code = String(e.code || '');
    if (code === 'CONNECTION_ERROR') {
        const msg = String(e.message || '');
        // Pre-send rejections in transport.call() — the RPC frame was never
        // written to the socket, so no transaction was transmitted.
        if (msg === 'WebSocket not open' || msg.startsWith('Failed to send') || msg === 'No servers provided') {
            return 'retryable';
        }
        // 'Connection closed' while a response was pending: the request WAS
        // written to the socket — the transaction may have landed.
        return 'uncertain';
    }
    if (code === 'ALL_NODES_FAILED') return 'retryable'; // connect sweep only
    if (code === 'RPC_TIMEOUT') return 'uncertain';
    // Graphene JSON-RPC error codes are integers — the node processed and
    // REJECTED the transaction, so it definitively did not land.
    if (/^\d+$/.test(code)) return 'definite';
    if (code === 'BROADCAST_ERROR' || code === 'CHAIN_CONFIG_ERROR') return 'definite';
    // Local transaction build/sign failures (modules/bitshares-native/tx/builder.ts
    // and signing_client.ts): the transaction was never transmitted, so the
    // broadcast provably did not leave the machine. Two sub-classes:
    //  - Deterministic build errors (identical ops fail identically on every
    //    node): 'definite'. Classifying them as 'retryable' would make the
    //    credential daemon rotate through every healthy node, reporting each
    //    rotation as a node failure — after the threshold, healthy nodes get
    //    blacklisted for BLACKLIST_COOLDOWN_MS and removed from the shared
    //    health cache over a broadcast that never reached the wire. Retrying
    //    them cannot change the outcome.
    //  - Node-dependent build failures (fee-schedule / reference-block
    //    fetches, stale signing clients): 'retryable' — they can succeed on
    //    another node and nothing landed.
    if (code === 'TX_TOO_LARGE') return 'definite';
    const msg = String(e.message || '');
    if (
        msg === 'Operation must have op_name and op_data'
        || msg === 'Each operation requires op_name and op_data'
        || /^Max operations per tx/.test(msg)
        || msg === 'Broadcast API does not support transaction broadcast'
        || msg === 'accountName is required'
        || msg === 'privateKey is required'
        || msg === 'chainClient is required'
        || /^Transaction builder does not support /.test(msg)
    ) {
        return 'definite';
    }
    if (
        /^Failed to fetch required fees/.test(msg)
        || /^Failed to fetch reference block/.test(msg)
        || /^Invalid chain id for transaction signing/.test(msg)
        || msg === 'Signing client has been disposed'
    ) {
        return 'retryable';
    }
    // Anything else during the broadcast phase — conservative: uncertain.
    return 'uncertain';
}
