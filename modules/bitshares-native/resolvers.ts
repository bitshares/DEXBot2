'use strict';

import { NATIVE_CLIENT } from '../constants.js';
import { LRUCache } from './lru_cache.js';
import { getErrorMessage } from '../utils/errors.js';
import { normalizeAssetRef } from '../utils/asset_symbols.js';

const { RESOLVERS } = NATIVE_CLIENT;

const ASSET_TTL_MS: number = RESOLVERS.ASSET_TTL_MS;
const ACCOUNT_TTL_MS: number = RESOLVERS.ACCOUNT_TTL_MS;
const MAX_ASSETS: number = RESOLVERS.MAX_ASSETS;
const MAX_ACCOUNTS: number = RESOLVERS.MAX_ACCOUNTS;

interface AssetLike {
    id?: string;
    symbol?: string;
    [key: string]: unknown;
}

interface AccountLike {
    id?: string;
    name?: string;
    [key: string]: unknown;
}

interface ChainClientDb {
    get_assets(ids: string[]): Promise<AssetLike[]>;
    lookup_asset_symbols(symbols: string[]): Promise<AssetLike[]>;
    get_full_accounts(ids: string[], subscribe: boolean): Promise<Array<[string, { account?: AccountLike }]>>;
    [key: string]: (...args: never[]) => Promise<unknown>;
}

interface ChainClient {
    db: ChainClientDb;
}

function createResolvers(chainClient: ChainClient) {
    const assetCache = new LRUCache<AssetLike>(MAX_ASSETS, ASSET_TTL_MS);
    const accountCache = new LRUCache<AccountLike>(MAX_ACCOUNTS, ACCOUNT_TTL_MS);
    const accountIdCache = new LRUCache<string>(MAX_ACCOUNTS, ACCOUNT_TTL_MS);

    async function resolveAsset(idOrSymbol: string): Promise<AssetLike> {
        if (!idOrSymbol) throw new Error('asset id or symbol required');

        // Canonicalize before the cache key and the chain call: a lowercase
        // symbol would otherwise occupy a second cache slot and be echoed back
        // lowercase to every caller.
        idOrSymbol = normalizeAssetRef(idOrSymbol);
        const cacheKey = `asset:${idOrSymbol}`;
        const cached = assetCache.get(cacheKey);
        if (cached) return cached;

        let asset: AssetLike | undefined;
        try {
            if (/^1\.3\./.test(String(idOrSymbol))) {
                const assets = await chainClient.db.get_assets([idOrSymbol]);
                asset = assets && assets[0];
            } else {
                const assets = await chainClient.db.lookup_asset_symbols([idOrSymbol]);
                asset = assets && assets[0];
            }
        } catch (err) {
            throw new Error(`Failed to resolve asset ${idOrSymbol}: ${getErrorMessage(err)}`);
        }

        if (!asset) throw new Error(`Asset not found: ${idOrSymbol}`);

        assetCache.set(cacheKey, asset);
        if (asset.symbol) assetCache.set(`asset:${asset.symbol}`, asset);
        if (asset.id) assetCache.set(`asset:${asset.id}`, asset);

        return asset;
    }

    async function resolveAccount(nameOrId: string): Promise<AccountLike> {
        if (!nameOrId) throw new Error('account name or id required');

        const cacheKey = `account:${nameOrId}`;
        const cached = accountCache.get(cacheKey);
        if (cached) return cached;

        try {
            const accounts = await chainClient.db.get_full_accounts([nameOrId], false);
            if (!accounts || !accounts[0]) throw new Error(`Account not found: ${nameOrId}`);

            const result = accounts[0][1] && accounts[0][1].account
                ? accounts[0][1].account
                : null;

            if (!result) throw new Error(`Account not found: ${nameOrId}`);

            accountCache.set(cacheKey, result);
            if (result.name) accountCache.set(`account:${result.name}`, result);
            if (result.id) accountCache.set(`account:${result.id}`, result);

            return result;
        } catch (err) {
            throw err;
        }
    }

    /**
     * Resolve an account reference to the requested field, caching through
     * `accountIdCache`. `direction` selects the returned field ('id' or
     * 'name'); a reference already shaped as the target is returned untouched.
     */
    async function resolveAccountField(ref: string, direction: 'id' | 'name'): Promise<string> {
        if (!ref) throw new Error(`account ${direction === 'id' ? 'name' : 'id'} required`);
        const isChainId = /^1\.2\./.test(String(ref));
        if (direction === 'id' ? isChainId : !isChainId) return ref;

        const cacheKey = `${direction}:${ref}`;
        const cached = accountIdCache.get(cacheKey);
        if (cached) return cached;

        const account = await resolveAccount(ref);
        const result = direction === 'id' ? account?.id : account?.name;
        if (result) {
            accountIdCache.set(cacheKey, result);
            return result;
        }
        throw new Error(`Could not resolve account ${direction === 'id' ? 'ID' : 'name'} for: ${ref}`);
    }

    async function resolveAccountId(name: string): Promise<string> {
        return resolveAccountField(name, 'id');
    }

    async function resolveAccountName(id: string): Promise<string> {
        return resolveAccountField(id, 'name');
    }

    function invalidateAsset(assetId: string): void {
        const cached = assetCache.get(`asset:${assetId}`);
        if (cached?.symbol) assetCache.delete(`asset:${cached.symbol}`);
        if (cached?.id) assetCache.delete(`asset:${cached.id}`);
        assetCache.delete(`asset:${assetId}`);
    }

    function invalidateAccount(accountId: string): void {
        const cached = accountCache.get(`account:${accountId}`);
        if (cached?.name) accountCache.delete(`account:${cached.name}`);
        if (cached?.id) accountCache.delete(`account:${cached.id}`);
        accountCache.delete(`account:${accountId}`);

        const isChainId = /^1\.2\./.test(String(accountId));
        const resolvedId = cached?.id || (isChainId ? accountId : null);
        const resolvedName = cached?.name || (isChainId ? null : accountId);
        if (resolvedId) accountIdCache.delete(`name:${resolvedId}`);
        if (resolvedName) accountIdCache.delete(`id:${resolvedName}`);
    }

    return {
        resolveAsset,
        resolveAccount,
        resolveAccountId,
        resolveAccountName,
        invalidateAsset,
        invalidateAccount,
    };
}

export { createResolvers }

