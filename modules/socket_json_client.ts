'use strict';
/**
 * modules/socket_json_client.ts - Newline-delimited JSON socket client
 *
 * Shared Unix-socket request client used by chain_keys.sendDaemonRequest and
 * dexbot_credential_client.sendCredentialDaemonRequest. Both talk to the
 * credential daemon over a socket with one JSON request per line and one JSON
 * response per line, and both must settle every request even when the daemon
 * dies mid-write (a truncated stream must not leave the caller hanging
 * forever).
 *
 * The caller owns the request/response protocol:
 *  - writePayload: writes the request line once the socket connects;
 *  - handleResponse: resolves/rejects with a fully parsed response line
 *    (throwing rejects the request);
 *  - buildError: builds the failure error per kind — 'timeout' (outer socket
 *    timer), 'connection' (socket error), 'closed' (socket ended before a
 *    complete line), 'invalid' (a response line was not JSON).
 */

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

export type SocketJsonFailureKind = 'timeout' | 'connection' | 'closed' | 'invalid';

interface SocketJsonRequestOptions {
    socketPath: string;
    timeoutMs: number;
    /** Write the request to the connected socket (one JSON line). */
    writePayload: (socket: { write(data: string): unknown; destroy(): void }) => void;
    /** Build the failure error for timeout / connection / truncated-stream / invalid-response cases. */
    buildError: (kind: SocketJsonFailureKind, detail?: unknown) => Error;
    /** Handle a fully parsed response line: resolve or reject the request. */
    handleResponse: (parsed: unknown, resolve: (value: unknown) => void, reject: (err: unknown) => void) => void;
}

export function sendSocketJsonRequest(options: SocketJsonRequestOptions): Promise<unknown> {
    const net = _require ? _require('net') : null;
    if (!net) {
        return Promise.reject(new Error('Unix socket IPC unavailable in this environment'));
    }
    const { socketPath, timeoutMs, writePayload, buildError, handleResponse } = options;

    return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const socket = net.createConnection(socketPath, () => {
            try {
                writePayload(socket);
            } catch (error) {
                socket.destroy();
                clearTimeout(timer);
                if (!settled) {
                    settled = true;
                    reject(buildError('connection', error));
                }
            }
        });

        let responseBuffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            if (!settled) {
                settled = true;
                reject(buildError('timeout'));
            }
        }, timeoutMs);

        socket.on('data', (data: Buffer) => {
            responseBuffer += data.toString();
            const lines = responseBuffer.split('\n');
            responseBuffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.trim()) continue;
                clearTimeout(timer);
                socket.end();
                if (!settled) {
                    settled = true;
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(line);
                    } catch {
                        reject(buildError('invalid'));
                        return;
                    }
                    // Handler errors (e.g. an extractResult throw) propagate
                    // to the caller like the original per-file handlers.
                    handleResponse(parsed, resolve, reject);
                }
                return;
            }
        });

        socket.on('error', (error: unknown) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                reject(buildError('connection', error));
            }
        });

        socket.on('end', () => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                if (responseBuffer.trim()) {
                    // The daemon closed the socket without a trailing newline.
                    // A complete buffered line is a valid response; a partial
                    // line means the daemon was killed mid-write — either way
                    // the request MUST settle (a truncated stream must not
                    // leave the caller hanging forever).
                    try {
                        handleResponse(JSON.parse(responseBuffer), resolve, reject);
                        return;
                    } catch {
                        // fall through to the rejection below
                    }
                }
                reject(buildError('closed'));
            }
        });
    });
}
