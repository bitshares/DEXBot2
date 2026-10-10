
import { createClawInfrastructure } from './claw_infra.js';
import { describeClawBridge } from './claw_manifest.js';
import { describeMemuBridge, runMemuCommand } from './memu_bridge.js';
import { clone } from './utils.js';
import { splitPairTarget } from '../../modules/utils/asset_symbols.js';
import { adjustMpaCollateral, borrowMpa, cancelLimitOrder, createLimitOrder, executeBatch, getMpaPosition, getOpenOrders, repayMpaDebt, buildUpdateLimitOrderOperation, updateLimitOrder, settleMpa } from './chain_actions.js';
import { buildCloseShortPlan, buildOpenShortPlan, buildTakeProfitPlan, closeShortOnBts, openShortOnBts, placeTakeProfitBuyOrderOnBts } from './short_mpa_strategy.js';
import { launcherRun, launcherDrystart, launcherReset, launcherDisable, launcherPm2Start, launcherPm2Stop, launcherPm2Delete, launcherPm2Restart } from './claw_launcher.js';


import type { ClawBridgeOptions } from './types.js';
import { validateMemuCommandArgs } from './memu_bridge.js';

function stripPrivateKey(options: ClawBridgeOptions = {}): ClawBridgeOptions {
  const sanitized = { ...options };
  delete sanitized.privateKey;
  return sanitized;
}

/**
 * Split a "BASE/QUOTE" pair string into { baseSymbol, quoteSymbol }.
 * Throws if the value is not a two-segment BASE/QUOTE string — extra segments
 * are rejected instead of being silently dropped.
 * Both assetA and assetB are canonicalized to UPPERCASE (BitShares' on-chain
 * spelling) by the shared splitter, so a lowercase pair and its uppercase
 * spelling are one pair; only the error contract is claw's own.
 */
function splitPair(pairValue: string) {
  const segments = splitPairTarget(pairValue);
  if (segments.length !== 2) {
    throw new Error('pair must be provided as BASE/QUOTE');
  }

  return {
    baseSymbol: segments[0],
    quoteSymbol: segments[1]
  };
}

/**
 * Resolve explicit asset symbols or fall back to the parsed pair option.
 * Returns null when neither is available so callers can raise their own
 * command-specific error.
 */
function resolvePairSymbols(safeOptions: ClawBridgeOptions) {
  if (!safeOptions.pair) {
    return null;
  }
  return splitPair(safeOptions.pair);
}

/**
 * Extract a profile context reference string from command options.
 * Returns the first matching field: botRef, identifier, botId, or pair.
 */
function getProfileContextRef(options: ClawBridgeOptions = {}): string | null {
  return options.botRef || options.identifier || options.botId || options.pair || null;
}

const MEMU_COMMAND_MAP: Record<string, string> = {
  'memu-memorize': 'memorize',
  'memu-retrieve': 'retrieve',
  'memu-create-item': 'create-item',
  'memu-update-item': 'update-item',
  'memu-delete-item': 'delete-item',
  'memu-memorize-conversation': 'memorize-conversation',
  'memu-memorize-trading-context': 'memorize-trading-context',
  'memu-retrieve-trading-context': 'retrieve-trading-context'
};

/**
 * Credit runtime commands address bots by botRef or identifier only (never
 * botId/pair, unlike profile-context).
 */
function getCreditRuntimeBotRef(options: ClawBridgeOptions = {}): string | null {
  return options.botRef || options.identifier || null;
}

/**
 * Extract and validate the patch object from command options.
 * Throws if patch is missing or not a plain object.
 */
function getBotSettingsPatch(options: ClawBridgeOptions = {}): Record<string, any> {
  if (!options.patch || typeof options.patch !== 'object' || Array.isArray(options.patch)) {
    throw new Error('bot-settings-preview and bot-settings-apply require a patch object');
  }

  return options.patch;
}

/**
 * Create a Claw bridge instance — infrastructure object with bitshares, credential,
 * profiles, market, order, honest, and credit-runtime subsystems wired together.
 */
function createClawBridge(options: ClawBridgeOptions = {}): any {
  const sanitizedOptions = stripPrivateKey(options);
  const runtimeName = sanitizedOptions.runtimeName
    || sanitizedOptions.runtime?.name
    || 'claw-bridge';

  return createClawInfrastructure({
    ...sanitizedOptions,
    runtime: {
      ...(sanitizedOptions.runtime || {}),
      name: runtimeName
    }
  });
}

/**
 * Describe the runtime manifest — mirrors describeClawBridge.
 * @returns {Object} Compatibility manifest with commands, surfaces, and trust model.
 */
function describeRuntimeManifest(options: ClawBridgeOptions = {}): any {
  return describeClawBridge(options);
}

/**
 * Describe the command manifest for the requested runtime.
 * Delegates to memu_bridge for memU runtime, otherwise uses claw_bridge manifest.
 */
function describeCommandManifest(options: ClawBridgeOptions = {}): any {
  const runtimeName = options.runtimeName || options.runtime?.name || null;
  if (runtimeName && String(runtimeName).trim().toLowerCase() === 'memu') {
    return describeMemuBridge(options);
  }
  return describeClawBridge(options);
}

/**
 * Dispatch a claw bridge command to the appropriate handler.
 * Strips privateKey from options for logging safety before routing.
 *
 * @param {string} command – Command name (e.g. 'manifest', 'profile-context', 'bot-settings')
 * @param {Object} [options] – Command options including credentials, payload, and runtime context
 * @returns {Promise<any>} Command result
 */
async function runClawCommand(command: string, options: ClawBridgeOptions = {}): Promise<any> {
  const safeOptions = stripPrivateKey(options);
  if (command === 'manifest') {
    return describeCommandManifest(safeOptions);
  }

  const bridge = createClawBridge(safeOptions);
  const accountName = safeOptions.accountName || bridge.runtime.accountName || null;

  switch (command) {
    case 'runtime':
      return clone(bridge.runtime);

    case 'profile-context':
      return bridge.profiles.getClawProfileContext(
        getProfileContextRef(safeOptions),
        safeOptions
      );

    case 'market-snapshot': {
      const pair = resolvePairSymbols(safeOptions);
      const baseSymbol = safeOptions.baseSymbol || pair?.baseSymbol;
      const quoteSymbol = safeOptions.quoteSymbol || pair?.quoteSymbol;

      if (!baseSymbol || !quoteSymbol) {
        throw new Error('market-snapshot requires baseSymbol/quoteSymbol or pair');
      }

      return bridge.market.readMarketSnapshot(baseSymbol, quoteSymbol, Number(safeOptions.limit) || 10);
    }

    case 'account-snapshot':
      return bridge.market.readAccountSnapshot(safeOptions.accountName || safeOptions.accountRef || accountName);

    case 'open-orders':
      return getOpenOrders(safeOptions.accountName || safeOptions.accountRef || accountName);

    case 'bot-settings':
      return bridge.profiles.getBotSettings(
        getProfileContextRef(safeOptions),
        Boolean(safeOptions.forceReload)
      );

    case 'bot-settings-preview':
      return bridge.profiles.previewBotSettingsUpdate(
        getProfileContextRef(safeOptions),
        getBotSettingsPatch(safeOptions),
        safeOptions
      );

    case 'bot-settings-apply':
      return bridge.profiles.applyBotSettingsPatch(
        getProfileContextRef(safeOptions),
        getBotSettingsPatch(safeOptions),
        safeOptions
      );

    case 'honest-context':
      return bridge.honest.buildContext({
        batchSize: Number(safeOptions.batchSize) || undefined,
        discoverPairs: Array.isArray(safeOptions.discoverPairs) ? safeOptions.discoverPairs : undefined,
        maxPages: Number(safeOptions.maxPages) || undefined,
        prefix: safeOptions.prefix,
        startSymbol: safeOptions.startSymbol
      });

    case 'honest-pair': {
      const pair = resolvePairSymbols(safeOptions);
      const assetA = safeOptions.assetA || pair?.baseSymbol;
      const assetB = safeOptions.assetB || pair?.quoteSymbol;

      if (!assetA || !assetB) {
        throw new Error('honest-pair requires assetA/assetB or pair');
      }

      return bridge.honest.resolvePairContext(assetA, assetB, safeOptions);
    }

    case 'honest-price': {
      const pair = resolvePairSymbols(safeOptions);
      const assetA = safeOptions.assetA || pair?.baseSymbol;
      const assetB = safeOptions.assetB || pair?.quoteSymbol;

      if (!assetA || !assetB) {
        throw new Error('honest-price requires assetA/assetB or pair');
      }

      return bridge.honest.resolvePairPrice(assetA, assetB, safeOptions);
    }

    case 'create-limit-order':
      return createLimitOrder({
        ...safeOptions,
        accountName
      });

    case 'cancel-limit-order':
      return cancelLimitOrder({
        ...safeOptions,
        accountName
      });

    case 'build-update-limit-order-op':
      return buildUpdateLimitOrderOperation({
        ...safeOptions,
        accountName
      });

    case 'update-limit-order':
      return updateLimitOrder({
        ...safeOptions,
        accountName
      });

    case 'execute-batch':
      return executeBatch({
        ...safeOptions,
        accountName
      });

    case 'borrow-mpa':
      return borrowMpa({
        ...safeOptions,
        accountName
      });

    case 'repay-mpa':
      return repayMpaDebt({
        ...safeOptions,
        accountName
      });

    case 'adjust-mpa-collateral':
      return adjustMpaCollateral({
        ...safeOptions,
        accountName
      });

    case 'settle-mpa':
      return settleMpa({
        ...safeOptions,
        accountName
      });

    case 'open-short-bts':
      return openShortOnBts({
        ...safeOptions,
        accountName
      });

    case 'take-profit-bts':
      return placeTakeProfitBuyOrderOnBts({
        ...safeOptions,
        accountName
      });

    case 'close-short-bts':
      return closeShortOnBts({
        ...safeOptions,
        accountName
      });

    case 'build-open-short-plan':
      return buildOpenShortPlan({
        ...safeOptions,
        accountName
      });

    case 'build-take-profit-plan':
      return buildTakeProfitPlan({
        ...safeOptions,
        accountName
      });

    case 'build-close-short-plan':
      return buildCloseShortPlan({
        ...safeOptions,
        accountName
      });

    case 'mpa-position':
      return getMpaPosition(safeOptions.accountName || safeOptions.accountRef || accountName, safeOptions.mpaAsset);

    case 'credit-runtime-status':
      return bridge.creditRuntime.getStatus(getCreditRuntimeBotRef(safeOptions));

    case 'credit-runtime-refresh':
      return bridge.creditRuntime.refresh(getCreditRuntimeBotRef(safeOptions));

    case 'credit-runtime-maintenance':
      return bridge.creditRuntime.runMaintenance(
        getCreditRuntimeBotRef(safeOptions),
        safeOptions.context || 'periodic',
        safeOptions,
        options.privateKey
      );

    case 'credit-runtime-watchdog':
      return bridge.creditRuntime.runWatchdog(
        getCreditRuntimeBotRef(safeOptions),
        options.privateKey
      );

    case 'credit-runtime-reborrows':
      return bridge.creditRuntime.processReborrows(
        getCreditRuntimeBotRef(safeOptions),
        options.privateKey
      );

    case 'launcher-run':
      return launcherRun(safeOptions.botName || null, safeOptions);

    case 'launcher-drystart':
      return launcherDrystart(safeOptions.botName || null, safeOptions);

    case 'launcher-reset':
      return launcherReset(safeOptions.botName || null, safeOptions);

    case 'launcher-disable':
      return launcherDisable(safeOptions.botName || null, safeOptions);

    case 'launcher-pm2-start':
      return launcherPm2Start(safeOptions.botName || null, safeOptions);

    case 'launcher-pm2-stop':
      return launcherPm2Stop(safeOptions.botName || 'all', safeOptions);

    case 'launcher-pm2-delete':
      return launcherPm2Delete(safeOptions.botName || 'all', safeOptions);

    case 'launcher-pm2-restart':
      return launcherPm2Restart(safeOptions.botName || 'all', safeOptions);

    case 'memu-manifest':
      return describeMemuBridge(safeOptions);

    case 'memu-memorize':
    case 'memu-retrieve':
    case 'memu-list-categories':
    case 'memu-list-items':
    case 'memu-create-item':
    case 'memu-update-item':
    case 'memu-delete-item':
    case 'memu-clear':
    case 'memu-status':
    case 'memu-memorize-conversation':
    case 'memu-memorize-trading-context':
    case 'memu-retrieve-trading-context': {
      const memuCommand = MEMU_COMMAND_MAP[command] || command.replace(/^memu-/, '');
      // Shared validation with runMemuCommand/memu_mcp_server so every surface
      // rejects missing args with the same message.
      validateMemuCommandArgs(memuCommand, safeOptions);
      return runMemuCommand(memuCommand, safeOptions);
    }

    default:
      throw new Error(`Unsupported Claw command: ${command}`);
  }
}

export { createClawBridge, describeClawBridge, describeRuntimeManifest, runClawCommand, splitPair }

