/**
 * KIBANA ELASTICSEARCH CLIENT
 *
 * Shared HTTP client for querying the BitShares Kibana instance.
 * Centralizes the request/response handling used by the Kibana candle
 * sources (inputs/kibana_source.ts, core/kibana_candles.ts).
 *
 * All Kibana-consuming modules should use this client instead of
 * maintaining their own HTTP implementation.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*  (time field: block_data.block_time)
 */


import { createRequire } from 'node:module';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
'use strict';

const _require = createRequire(import.meta.url);
let _https: any;
const https = new Proxy({} as any, {
    get(_, prop) {
        if (!_https && _require) _https = _require('https');
        return _https ? _https[prop] : undefined;
    }
});

const KIBANA_URL = 'https://kibana.bitshares.dev';
const INDEX      = 'bitshares-*';

const DEFAULT_CONFIG = Object.freeze({
  kibanaUrl:  KIBANA_URL,
  apiKey:     null,     // 'base64(id:key)' if auth required
  timeout:    MARKET_ADAPTER.KIBANA_REQUEST_TIMEOUT_MS,
});

const PROXY_PATH = (index: any) =>
  `/api/console/proxy?path=${encodeURIComponent(index + '/_search')}&method=POST`;

/**
 * Execute an Elasticsearch query against the Kibana proxy.
 *
 * @param {Object} cfg       – { kibanaUrl, apiKey, timeout, signal }
 * @param {Object} esQuery   – Elasticsearch query body
 * @param {Function} resolve – Promise resolve callback
 * @param {Function} reject  – Promise reject callback
 * @param {number} [redirectCount=0] – Redirect counter
 */
function doKibanaRequest(cfg: any, esQuery: any, resolve: any, reject: any, redirectCount = 0) {
  const body = JSON.stringify(esQuery);
  const url  = new URL(cfg.kibanaUrl);
  const signal = cfg.signal;

  if (signal?.aborted) {
    const err = signal.reason instanceof Error ? signal.reason : new Error('Kibana request aborted');
    err.name = 'AbortError';
    reject(err);
    return;
  }

  const headers = {
    'Content-Type':   'application/json',
    'kbn-xsrf':       'true',
    'Content-Length': new TextEncoder().encode(body).length,
  };
  if (cfg.apiKey) (headers as any)['Authorization'] = `ApiKey ${cfg.apiKey}`;

  const req = https.request({
    hostname: url.hostname,
    port:     url.port || 443,
    path:     PROXY_PATH(INDEX),
    method:   'POST',
    headers,
    timeout:  cfg.timeout,
  }, (res: any) => {
    // Follow a single redirect (common with auth or load-balancer rewrites)
    if (redirectCount === 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const redirectUrl = new URL(res.headers.location, cfg.kibanaUrl);
      return doKibanaRequest({ ...cfg, kibanaUrl: redirectUrl.href }, esQuery, resolve, reject, redirectCount + 1);
    }

    let raw = '';
    let settled = false;
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    res.on('data', (c: any) => { raw += c; });
    // A response stream that dies mid-transfer (server/proxy connection reset
    // on large payloads) never emits 'end' — without these handlers the
    // surrounding promise stays pending forever and callers hang.
    res.on('aborted', () => {
      fail(new Error('Kibana response aborted (connection reset mid-transfer — reduce kibanaPageSize / restrict _source fields)'));
    });
    res.on('error', (e: any) => {
      fail(new Error(`Kibana response stream error: ${getErrorMessage(e)}`));
    });
    res.on('end', () => {
      if (settled) return;
      if (res.statusCode === 401 || res.statusCode === 403) {
        fail(new Error(
          `Kibana auth required (HTTP ${res.statusCode}). ` +
          `Set config.apiKey — generate in Kibana → Stack Management → API Keys.`
        ));
        return;
      }
      if (res.statusCode >= 400) {
        fail(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        return;
      }
      try { settled = true; resolve(JSON.parse(raw)); }
      catch (e: any) { settled = true; reject(new Error(`JSON parse failed: ${getErrorMessage(e)}\n${raw.slice(0, 200)}`)); }
    });
  });

  const onAbort = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : new Error('Kibana request aborted');
    reason.name = 'AbortError';
    req.destroy(reason);
  };

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', onAbort));
  }

  req.on('error', reject);
  req.on('timeout', () => { req.destroy(); reject(new Error('Kibana request timed out')); });
  req.write(body);
  req.end();
}

function kibanaSearch(config: any, esQuery: any) {
  return new Promise((resolve, reject) => {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    doKibanaRequest(cfg, esQuery, resolve, reject);
  });
}

export { DEFAULT_CONFIG, INDEX, KIBANA_URL, kibanaSearch }

