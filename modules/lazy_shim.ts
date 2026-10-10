/** Lazy named-export pass-through shared by the Node-only runtime modules. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Build a lazy pass-through to a named export. The require runs on each call
 * (Node caches modules), which keeps heavy or circular targets out of the
 * static import graph without a hand-written wrapper per function. The
 * returned function keeps the previous `(...args: unknown[]) => any` shape.
 *
 * Lives directly under modules/ so `require(modulePath)` resolves relative
 * paths identically to the runtime modules that call it.
 */
export function lazyShim(modulePath: string, exportName: string): (...args: unknown[]) => any {
    return (...args: unknown[]) => require(modulePath)[exportName](...args);
}
