'use strict';

/**
 * Lazy Node Buffer accessor for the serial layer.
 *
 * `node:buffer` must not be pulled in eagerly in browser bundles, so this
 * exposes a Proxy that resolves the real Buffer constructor on first property
 * access via `createRequire`. Shared by serializer.ts and types.ts so the
 * lazy-loading semantics are defined once.
 */

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
type BufferCtor = typeof import('node:buffer').Buffer;
let _Buffer: BufferCtor | undefined;

const Buffer: BufferCtor = new Proxy({} as BufferCtor, {
    get(_, prop) {
        if (!_Buffer && _require) _Buffer = _require('buffer').Buffer as BufferCtor;
        return _Buffer ? (_Buffer as unknown as Record<string | symbol, unknown>)[prop] : undefined;
    }
});

export { Buffer };
