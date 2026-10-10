'use strict';

import { createTransport, ConnectionError } from './transport.js';
import { GRAPHENE_CHAIN_ID, GRAPHENE_ADDRESS_PREFIX } from './serial/chain_constants.js';
import { NATIVE_CLIENT } from '../constants.js';
import { getErrorMessage } from '../utils/errors.js';

const { CHAIN, TRANSPORT } = NATIVE_CLIENT;


class ChainConfigError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.code = 'CHAIN_CONFIG_ERROR';
    }
}

function toRpcMethodName(method: string): string {
    return String(method).replace(/([A-Z])/g, (_: string, ch: string) => `_${ch.toLowerCase()}`);
}

/**
 * True when an RPC error means the api_id we sent is not registered on the
 * current websocket login session. bitshares-core returns:
 *   Execution error: Assert Exception: _local_apis.size() > api_id:
 * A cached api id can outlive its session when a reconnect swaps the socket
 * without a status 'closed' event, or when the node drops the login session
 * server-side; the id then points past the new session's _local_apis map.
 */
function isStaleApiIdError(err: unknown): boolean {
    const e = err as { message?: unknown } | null | undefined;
    const message = e && e.message ? String(e.message) : String(err ?? '');
    if (!message) return false;
    return message.includes('_local_apis') || (message.includes('api_id') && message.includes('Assert Exception'));
}

interface ChainClientConfig {
    nodes?: string[];
    onStatusChange?: ((status: string, nodeUrl: string | null) => void) | null;
    onNodeFailure?: ((nodeUrl: string, message: string, source: string) => void) | null;
    shouldSkipNode?: ((nodeUrl: string) => boolean) | null;
    rpcTimeoutMs?: number;
    connectTimeoutMs?: number;
    autoreconnect?: boolean;
    validateChainId?: boolean;
    expectedChainId?: string;
}

interface ChainConfig {
    chainId: string;
    addressPrefix: string;
    coreAsset: string;
}

/**
 * Outcome of a forced-reconnect request.
 * - `issued`      a fresh teardown/reconnect was started by this call.
 * - `coalesced`   a forced reconnect was already issued within the cooldown (by
 *                 this or another escalation source); nothing was torn down
 *                 again, but a recovery attempt is in flight/recent.
 * - `unavailable` no live socket to tear down, so no recovery attempt exists.
 */
export type ForcedReconnectOutcome = 'issued' | 'coalesced' | 'unavailable';

/**
 * Build the per-client forced-reconnect gate shared by the main and read-only
 * clients, and transitively by the stale-api window and the subscriptions
 * fill-channel watchdog. One cooldown per client stops a wedged session from
 * stacking concurrent reconnects; the outcome lets a caller distinguish a
 * genuinely new teardown from one coalesced onto another source's, so
 * escalation accounting is not starved when the cooldown is already spent.
 */
function createForcedReconnectGate(transport: ReturnType<typeof createTransport>): (reason?: string) => ForcedReconnectOutcome {
    const cooldownMs = Number.isFinite(TRANSPORT.FORCED_RECONNECT_COOLDOWN_MS)
        ? Math.max(0, TRANSPORT.FORCED_RECONNECT_COOLDOWN_MS)
        : 30000;
    let lastForcedReconnectAt = 0;
    return function forceReconnect(reason: string = 'forced'): ForcedReconnectOutcome {
        const now = Date.now();
        // Coalesce is checked before connectivity: immediately after a teardown
        // the socket is null while the reconnect is in flight, and that must
        // still read as `coalesced`, not `unavailable`.
        if (now - lastForcedReconnectAt < cooldownMs) return 'coalesced';
        // No live socket: there is nothing to tear down, so this is not a
        // recovery attempt. Reporting it as `issued` would let callers count a
        // no-op as a cycle and burn the cooldown.
        if (typeof transport?.isConnected === 'function' && !transport.isConnected()) return 'unavailable';
        lastForcedReconnectAt = now;
        try {
            transport.forceReconnect(reason);
        } catch (_) {
            // Keep the stamp: a throwing recovery must not become a tight loop.
        }
        return 'issued';
    };
}

/**
 * Build the windowed stale-api-id escalation shared by the main and read-only
 * clients. Counting is windowed: a rare stale id (the normal reconnect-race
 * case) never trips the escalation, while a session that fails every call
 * trips it within a few RPCs. The window/threshold/reset policy lives here
 * once; each caller supplies its own reconnect request and reason wording.
 *
 * @param forceReconnect - Client-local forced-reconnect request
 * @param describe - Builds the reconnect reason from the api name and threshold
 * @returns A controller exposing note() and reset()
 */
function createStaleApiEscalation(
    forceReconnect: (reason: string) => unknown,
    describe: (apiName: string | undefined, threshold: number) => string,
): { note: (apiName?: string) => void; reset: () => void } {
    let errorCount = 0;
    let windowStartedAt = 0;
    return {
        reset(): void {
            errorCount = 0;
            windowStartedAt = 0;
        },
        note(apiName?: string): void {
            const now = Date.now();
            const windowMs = Number.isFinite(TRANSPORT.STALE_API_WINDOW_MS) ? TRANSPORT.STALE_API_WINDOW_MS : 60000;
            const threshold = Number.isFinite(TRANSPORT.STALE_API_FORCE_RECONNECT_AFTER)
                ? TRANSPORT.STALE_API_FORCE_RECONNECT_AFTER
                : 3;
            if (now - windowStartedAt > windowMs) {
                windowStartedAt = now;
                errorCount = 0;
            }
            errorCount++;
            if (errorCount < threshold) return;
            errorCount = 0;
            windowStartedAt = now;
            forceReconnect(describe(apiName, threshold));
        },
    };
}

function createChainClient(config: ChainClientConfig = {}) {
    const {
        nodes = [],
        onStatusChange = null,
        onNodeFailure = null,
        shouldSkipNode = null,
        rpcTimeoutMs,
        connectTimeoutMs,
        autoreconnect = true,
        validateChainId = true,
        expectedChainId = GRAPHENE_CHAIN_ID,
    } = config;

    const wrappedOnStatusChange = (status: string, nodeUrl: string | null) => {
        if (status === 'closed') {
            resetApiIds();
            _chainConfig = null;
        }
        if (onStatusChange) onStatusChange(status, nodeUrl);
    };

    const transport = createTransport({
        onStatusChange: wrappedOnStatusChange,
        onNodeFailure,
        shouldSkipNode,
        rpcTimeoutMs,
        connectTimeoutMs,
        validateNode: validateChainId ? async () => {
            await login();
        } : null,
        onReconnect: async () => {
            if (typeof client.onReconnect === 'function') {
                await client.onReconnect();
            }
        },
    });
    let _dbApiId: number | null = null;
    let _historyApiId: number | null = null;
    let _broadcastApiId: number | null = null;
    let _chainConfig: ChainConfig | null = null;

    function resetApiIds(): void {
        _dbApiId = null;
        _historyApiId = null;
        _broadcastApiId = null;
    }
    let _loginPromise: Promise<ChainConfig | undefined> | null = null;
    let _apiLimitGetAccountHistory: number | null = null;
    // Shared forced-reconnect debounce. Both escalation sources — the stale
    // api_id window below and the subscriptions fill-channel watchdog — call
    // forceReconnect(), so the cooldown lives here, once per client, instead of
    // being duplicated (and independently tuned) at each call site. A wedged
    // session trips both counters in the same tick; without this they would
    // stack two reconnects on top of each other.
    //
    // Public entry point for higher layers (subscriptions watchdog) to recover
    // a session that is nominally connected but rejecting every call.
    // @returns the {@link ForcedReconnectOutcome} of the request.
    const forceReconnect = createForcedReconnectGate(transport);
    const staleApiEscalation = createStaleApiEscalation(
        forceReconnect,
        (apiName, threshold) => `repeated stale api_id for ${apiName} (${threshold}x)`,
    );
    if (Array.isArray(nodes) && nodes.length > 0) {
        transport._setNodes(nodes);
    }

    async function login(): Promise<ChainConfig | undefined> {
        if (_loginPromise) return _loginPromise;

        _loginPromise = (async () => {
            // validateNode() runs login() on every (re)connect. A new websocket
            // session starts with an empty _local_apis map, so api ids cached
            // from the previous session are no longer addressable — the node
            // rejects them with "Assert Exception: _local_apis.size() > api_id".
            // Drop them so every accessor re-registers against this session.
            resetApiIds();
            // A fresh login session is a clean slate for the stale-id escalation.
            staleApiEscalation.reset();

            const result = await transport.call('call', [1, 'login', ['', '']]);
            if (!result) {
                throw new ConnectionError('Login error');
            }

            if (_dbApiId == null) {
                _dbApiId = await registerApi('database');
            }

            const chainId = await transport.call('call', [_dbApiId, 'get_chain_id', []]) as string;
            let addressPrefix = GRAPHENE_ADDRESS_PREFIX;
            let coreAsset = CHAIN.CORE_ASSET_ID;

            try {
                const props = await transport.call('call', [_dbApiId, 'get_chain_properties', []]) as { address_prefix?: string } | null;
                if (props && props.address_prefix) addressPrefix = props.address_prefix;
            } catch (err) { console.warn('[chain_client]', 'get_chain_properties failed:', getErrorMessage(err)); }

            try {
                const globals = await transport.call('call', [_dbApiId, 'get_global_properties', []]) as { parameters?: { core_asset?: string } } | null;
                if (globals && globals.parameters && globals.parameters.core_asset) {
                    coreAsset = globals.parameters.core_asset;
                }
            } catch (err) { console.warn('[chain_client]', 'get_global_properties failed:', getErrorMessage(err)); }

            try {
                // login_api.get_config() returns application_options (which
                // includes api_limit_get_account_history). database_api.get_config()
                // returns the chain config (GRAPHENE_* constants only) and does
                // NOT expose api_limit_* fields, so we must call login_api
                // (API id 1) directly. get_config requires the user to be
                // logged in; the empty-creds login above is sufficient on nodes
                // with the default api_access.json (anonymous full access).
                const nodeConfig = await transport.call('call', [1, 'get_config', []]) as { api_limit_get_account_history?: number } | null;
                if (nodeConfig && typeof nodeConfig.api_limit_get_account_history === 'number') {
                    _apiLimitGetAccountHistory = nodeConfig.api_limit_get_account_history;
                }
            } catch (_) {
                // get_config may be denied (locked-down node) or unsupported;
                // fall back to the static HISTORY_LOOKBACK_MAX default.
            }

            if (validateChainId && chainId !== expectedChainId) {
                _dbApiId = null;
                throw new ChainConfigError(
                    `Chain ID mismatch: expected ${expectedChainId}, got ${chainId}`
                );
            }

            _chainConfig = {
                chainId,
                addressPrefix,
                coreAsset,
            };

            return _chainConfig;
        })().finally(() => {
            _loginPromise = null;
            return undefined;
        });

        return _loginPromise;
    }

    async function registerApi(apiName: string): Promise<number> {
        const apiId = await transport.call('call', [1, apiName, []]);
        return apiId as number;
    }

    /**
     * Invoke a login_api-registered RPC namespace, transparently recovering
     * from a stale api id. If the node rejects the call because the id is not
     * registered on the current session, drop the cached id, re-register the
     * namespace on this session, and retry once. This is what keeps the fill
     * history channel alive across a node failover without a process restart.
     */
    async function callWithApiRecovery(
        apiName: string,
        method: string,
        args: unknown[],
        getApiId: () => number | null,
        setApiId: (id: number | null) => void,
    ): Promise<unknown> {
        let apiId = getApiId();
        if (apiId == null) {
            apiId = await registerApi(apiName);
            setApiId(apiId);
        }
        try {
            return await transport.call('call', [apiId, method, args]);
        } catch (err) {
            if (!isStaleApiIdError(err)) throw err;
            noteStaleApiError(apiName);
            setApiId(null);
            const freshId = await registerApi(apiName);
            setApiId(freshId);
            return transport.call('call', [freshId, method, args]);
        }
    }

    /**
     * Record a stale-api error and escalate to a forced reconnect when the
     * session keeps rejecting ids. Counting is windowed: a rare stale id (the
     * normal reconnect-race case) never trips the escalation, while a session
     * that fails every call trips it within a few RPCs. The forced reconnect
     * marks the active node failed, so the transport prefers another node.
     */
    function noteStaleApiError(apiName: string): void {
        staleApiEscalation.note(apiName);
    }

    /**
     * Bind a login_api namespace to its cached api-id slot. Centralizes the
     * `callWithApiRecovery` wiring shared by dbCall/historyCall/broadcastCall.
     */
    function apiCaller(
        apiName: string,
        normalizeMethod: (method: string) => string,
        getApiId: () => number | null,
        setApiId: (id: number | null) => void,
    ): (method: string, args?: unknown[]) => Promise<unknown> {
        return (method, args) => callWithApiRecovery(apiName, normalizeMethod(method), args || [], getApiId, setApiId);
    }

    const dbCall = apiCaller('database', toRpcMethodName, () => _dbApiId, (id) => { _dbApiId = id; });
    const historyCall = apiCaller('history', toRpcMethodName, () => _historyApiId, (id) => { _historyApiId = id; });
    const broadcastCall = apiCaller('network_broadcast', (method) => method, () => _broadcastApiId, (id) => { _broadcastApiId = id; });

    async function broadcastTx(signedTx: unknown): Promise<unknown> {
        return broadcastCall('broadcast_transaction', [signedTx]);
    }

    async function connect(servers?: string[]): Promise<void> {
        if (Array.isArray(servers)) {
            setNodes(servers);
        } else if (transport._getNodes().length === 0 && Array.isArray(nodes) && nodes.length > 0) {
            setNodes(nodes);
        }
        await transport.connect(undefined, autoreconnect);
    }

    function disconnect(): void {
        resetApiIds();
        _chainConfig = null;
        transport.disconnect();
    }

    function setNodes(servers: string[]): void {
        transport._setNodes(servers);
    }

    function getNodes(): string[] { return transport._getNodes(); }
    function getStatus(): string { return transport.getStatus(); }
    function getConfig(): ChainConfig | null { return _chainConfig; }
    function getCoreAsset(): string { return _chainConfig ? _chainConfig.coreAsset : CHAIN.CORE_ASSET_ID; }
    function getApiLimitGetAccountHistory(): number | null { return _apiLimitGetAccountHistory; }

    const db: Record<string, (...args: never[]) => Promise<unknown>> = {};

    const DB_METHODS = [
        'get_assets', 'getAssets', 'lookup_asset_symbols', 'lookupAssetSymbols',
        'get_full_accounts', 'getFullAccounts', 'get_order_book', 'getOrderBook', 'get_ticker', 'getTicker',
        'get_objects', 'getObjects', 'getGlobalProperties', 'get_global_properties', 'get_dynamic_global_properties',
        'get_liquidity_pools_by_both_assets', 'get_liquidity_pools_by_share_asset',
        'list_liquidity_pools', 'get_call_orders', 'list_assets',
        'get_account_count', 'get_block', 'get_account_balances',
        'get_key_references', 'get_block_header',
    ];

    for (const method of DB_METHODS) {
        db[method] = (...args: unknown[]) => dbCall(method, args);
    }

    db.call = dbCall;

    const history: Record<string, (...args: never[]) => Promise<unknown>> = {};

    const HISTORY_METHODS = [
        'getMarketHistory', 'get_market_history', 'getMarketHistoryBuckets', 'get_market_history_buckets',
        'get_account_history_by_operations', 'getAccountHistory', 'get_account_history',
        'getAccountHistoryOperations', 'get_account_history_operations',
        'get_liquidity_pool_history', 'get_liquidity_pool_history_by_sequence',
        'get_relative_account_history',
    ];

    for (const method of HISTORY_METHODS) {
        history[method] = (...args: unknown[]) => historyCall(method, args);
    }

    history.call = historyCall;

    const broadcast: Record<string, (...args: never[]) => Promise<unknown>> = {
        call: broadcastCall,
        broadcast_transaction: (tx: unknown) => broadcastTx(tx),
        broadcast_transaction_synchronous: (tx: unknown) => broadcastCall('broadcast_transaction_synchronous', [tx]),
    };

    const client = {
        transport,
        connect,
        disconnect,
        forceReconnect,
        setNodes,
        getNodes,
        getStatus,
        getConfig,
        getCoreAsset,
        getApiLimitGetAccountHistory,
        db,
        history,
        broadcast,
        login,
        onReconnect: null as (() => Promise<void>) | null,
    };

    return client;
}

interface ReadOnlyClientConfig {
    nodes?: string[];
    rpcTimeoutMs?: number;
    connectTimeoutMs?: number;
    validateChainId?: boolean;
    expectedChainId?: string;
}

function createReadOnlyClient(config: ReadOnlyClientConfig = {}) {
    const {
        nodes = [],
        validateChainId = true,
        expectedChainId = GRAPHENE_CHAIN_ID,
    } = config;

    let _dbApiId: number | null = null;
    let _historyApiId: number | null = null;
    let _recoverPromise: Promise<void> | null = null;

    function resetApiIds(): void {
        _dbApiId = null;
        _historyApiId = null;
    }

    const transport = createTransport({
        rpcTimeoutMs: config.rpcTimeoutMs,
        connectTimeoutMs: config.connectTimeoutMs,
        onStatusChange: (status: string) => {
            if (status === 'closed') resetApiIds();
        },
    });
    // Shared forced-reconnect debounce for the read channel, mirroring the main
    // client: one cooldown and one outcome for every forced reconnect raised on
    // this client (stale api_id escalation today).
    const forceReconnect = createForcedReconnectGate(transport);
    const staleApiEscalation = createStaleApiEscalation(
        forceReconnect,
        (_apiName, threshold) => `repeated stale api_id on read channel (${threshold}x)`,
    );

    async function connect(servers?: string[]): Promise<void> {
        const effectiveNodes = Array.isArray(servers) && servers.length > 0
            ? servers
            : nodes;
        await transport.connect(effectiveNodes, false);
        await recoverApis();
        const err = await validateChain();
        if (err) throw err;
    }

    async function recoverApis(): Promise<void> {
        // Serialize concurrent db()/history() recoveries after reconnect
        if (_recoverPromise) return _recoverPromise;
        _recoverPromise = (async () => {
            const loginOk = await transport.call('call', [1, 'login', ['', '']]);
            if (!loginOk) {
                resetApiIds();
                throw new ConnectionError('Login error');
            }
            if (_dbApiId == null) {
                _dbApiId = await transport.call('call', [1, 'database', []]) as number;
            }
            if (_historyApiId == null) {
                _historyApiId = await transport.call('call', [1, 'history', []]) as number;
            }
        })().finally(() => {
            _recoverPromise = null;
        });
        return _recoverPromise;
    }

    async function validateChain(): Promise<Error | null> {
        if (!validateChainId || _dbApiId == null) return null;
        try {
            const chainId = await transport.call('call', [_dbApiId, 'get_chain_id', []]) as string;
            if (chainId !== expectedChainId) {
                disconnect();
                return new ChainConfigError(
                    `Chain ID mismatch: expected ${expectedChainId}, got ${chainId}`
                );
            }
        } catch (err) {
            if (err instanceof ChainConfigError) return err;
            // Transient RPC failure — reset API IDs so the next call retries cleanly.
            // The caller must treat null API IDs after validateChain() as a failure
            // and abort the current call; the next call will recover.
            resetApiIds();
            return new ConnectionError('Chain validation failed after reconnect');
        }
        return null;
    }

    function disconnect(): void {
        resetApiIds();
        transport.disconnect();
    }

    /**
     * Invoke a read-only RPC namespace, recovering from a stale api id by
     * re-registering on the current session and retrying once. Mirrors the
     * main client's callWithApiRecovery so a missed 'closed' event cannot
     * permanently wedge the read channel.
     */
    async function callWithRecovery(
        method: string,
        args: unknown[],
        getApiId: () => number | null,
        setApiId: (id: number | null) => void,
    ): Promise<unknown> {
        if (getApiId() == null) {
            await recoverApis();
            const err = await validateChain();
            if (err) throw err;
        }
        const apiId = getApiId();
        try {
            return await transport.call('call', [apiId, method, args]);
        } catch (err) {
            if (!isStaleApiIdError(err)) throw err;
            noteStaleApiError();
            setApiId(null);
            await recoverApis();
            const freshId = getApiId();
            if (freshId == null) throw err;
            return transport.call('call', [freshId, method, args]);
        }
    }

    /**
     * Windowed stale-id escalation for the read channel. Mirrors the main
     * client: a rare reconnect-race stale id recovers in place, a sustained
     * run forces a fresh connection on another node.
     */
    function noteStaleApiError(): void {
        staleApiEscalation.note();
    }

    /** Read-channel caller: wraps `callWithRecovery` for a bound api-id slot. */
    function recoveredCaller(
        getApiId: () => number | null,
        setApiId: (id: number | null) => void,
    ): (method: string, args?: unknown[]) => Promise<unknown> {
        return (method, args) => callWithRecovery(toRpcMethodName(method), args || [], getApiId, setApiId);
    }

    const db = recoveredCaller(() => _dbApiId, (id) => { _dbApiId = id; });
    const history = recoveredCaller(() => _historyApiId, (id) => { _historyApiId = id; });

    function setNodes(servers: string[]): void {
        transport._setNodes(servers);
    }

    function getNodes(): string[] {
        return transport._getNodes();
    }

    return {
        connect,
        disconnect,
        forceReconnect,
        db,
        history,
        setNodes,
        getNodes,
        getNodeUrl: () => transport.getNodeUrl(),
        isConnected: () => transport.isConnected(),
    };
}

export { createChainClient, createReadOnlyClient, ChainConfigError }

