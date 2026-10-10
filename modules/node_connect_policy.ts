'use strict';
/**
 * modules/node_connect_policy.ts - Pure post-connect node-quality policy
 *
 * The BitShares client's `handleConnectionStatus('connected')` has two
 * node-quality concerns after the transport reports a connection:
 *   1. an autonomous reconnect may have re-landed on a blacklisted node, so the
 *      client must switch to a healthy one (and never tear down a socket from
 *      inside the transport's own status callback — the caller defers), and
 *   2. otherwise the transport's candidate list should be aligned with the
 *      current healthy set so future reconnects avoid known-bad nodes.
 *
 * The decision is extracted here with no imports and no I/O so it can be
 * unit-tested without constructing the whole native client or a live
 * NodeManager. Callers own the side effects.
 */

interface ConnectedNodePolicyInput {
    /** `nodeConfig.healthCheck.enabled !== false`. */
    healthCheckEnabled: boolean;
    /** A restart/failover is already in progress; do not start another. */
    reconnectInProgress: boolean;
    /** Transport's currently active node (null/undefined when unknown). */
    activeNode: string | null | undefined;
    /** `nodeManager.isBlacklisted`. */
    isBlacklisted: (nodeUrl: string) => boolean;
    /** `nodeManager.getHealthyNodes`. */
    getHealthyNodes: () => string[];
}

type ConnectedNodePolicyAction =
    | { action: 'switch'; nodes: string[]; reason: 'connected-on-blacklisted-node' }
    | { action: 'align'; nodes: string[] }
    | { action: 'none' };

/**
 * Decide what the client should do after the transport connects.
 *
 * - `switch`: active node is blacklisted and healthy alternatives exist;
 *   reconnect to the healthy set (deferred by the caller).
 * - `align`: active node is fine; keep the transport candidate list aligned
 *   with the healthy set.
 * - `none`: nothing to do (health checks disabled, a reconnect is already in
 *   progress, or there is no usable healthy set).
 *
 * @param {ConnectedNodePolicyInput} input
 * @returns {ConnectedNodePolicyAction}
 */
export function resolveConnectedNodeAction(input: ConnectedNodePolicyInput): ConnectedNodePolicyAction {
    if (!input.healthCheckEnabled || input.reconnectInProgress) {
        return { action: 'none' };
    }

    const activeNode = input.activeNode || null;
    if (activeNode && input.isBlacklisted(activeNode)) {
        const healthy = input.getHealthyNodes();
        if (healthy.length > 0) {
            return { action: 'switch', nodes: healthy, reason: 'connected-on-blacklisted-node' };
        }
        // Blacklisted but no alternative: stay put rather than disconnect from
        // the only node we can currently reach.
        return { action: 'none' };
    }

    const healthy = input.getHealthyNodes();
    if (healthy.length > 0) {
        return { action: 'align', nodes: healthy };
    }
    return { action: 'none' };
}
