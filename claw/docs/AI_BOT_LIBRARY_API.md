# Claw Infrastructure API Boundary

> **File-name note:** this file is `AI_BOT_LIBRARY_API.md` for historical discovery; the document title above is the canonical name. Both refer to the same API surface.

This document defines the boundary between:

- `DEXBot2`: runtime infrastructure, BitShares connectivity, credentials, and execution substrate
- `Claw`: bridge layer, shared infrastructure, and workflow owner

The goal is simple:

- `Claw` provides shared infrastructure helpers and a bridge surface
- `Claw` can talk to DEXBot2 and the blockchain directly
- The infrastructure layer stays reusable and decision-free

The current scaffold lives in [../modules/claw_infra.ts](../modules/claw_infra.ts), [../modules/dexbot_profiles.ts](../modules/dexbot_profiles.ts), [../modules/claw_bridge.ts](../modules/claw_bridge.ts), and is exported from [../index.ts](../index.ts).

## Table of Contents

- [Design Rules](#design-rules)
- [Recommended Shape](#recommended-shape)
- [Runtime Compatibility](#runtime-compatibility)
  - [ZeroClaw Compatibility](#zeroclaw-compatibility)
  - [NullClaw Compatibility](#nullclaw-compatibility)
  - [NanoClaw Compatibility](#nanoclaw-compatibility)
  - [OpenFang Compatibility](#openfang-compatibility)
  - [Hermes Compatibility](#hermes-compatibility)
  - [OpenClaw Compatibility](#openclaw-compatibility)
  - [NanoBot Compatibility](#nanobot-compatibility)
  - [PicoClaw Compatibility](#picoclaw-compatibility)
  - [memU Compatibility](#memu-compatibility)
- [Core Types](#core-types)
- [Public API](#public-api)
- [Root Export Disambiguation](#root-export-disambiguation)
- [Suggested Runtime Flow](#suggested-runtime-flow)
- [Practical Policy](#practical-policy)
- [Minimal JSON Contract](#minimal-json-contract)
- [Good Default Split](#good-default-split)

## Design Rules

The Claw infrastructure layer should:

- provide shared runtime helpers
- provide connection and credential adapters
- provide configuration, logging, and state helpers
- provide market-data and BitShares utility wrappers
- provide low-level order/grid math helpers only
- expose write-capable clients only behind explicit caller intent
- manage bot-level settings only; keep DEXBot general settings default-first and explicit-only
- treat `profiles/general.settings.json` as read-only context, not a Claw write surface
- avoid process management
- avoid exposing raw private keys or bypassing the credential daemon boundary
- avoid owning persistent execution state
- avoid making strategy decisions

The Claw workflow layer should:

- manage lifecycle and persistence
- place, cancel, and rebalance orders
- talk to DEXBot2 when it needs shared runtime support
- decide whether to apply or ignore recommendations
- keep launcher orchestration, PM2 startup, and Docker entrypoint behavior in the `launcher-ops` skill boundary instead of the infrastructure API boundary

## Recommended Shape

The cleanest shape is a small library with a narrow, typed surface:

- input: plain objects / JSON
- output: plain objects / JSON
- no side effects unless explicitly requested

Think of Claw's infrastructure layer as the shared foundation that the workflow layer builds on.

## Runtime Compatibility

The Claw bridge supports the runtimes below. Each runtime shares the DEXBot2 credential boundary and the same read/plan/execute tool surface; they differ in transport and skill-file format. The full runtime matrix lives in [../modules/claw_runtime_matrix.ts](../modules/claw_runtime_matrix.ts).

> **Skill script note:** the `*:skill` npm scripts (e.g. `zeroclaw:skill`, `hermes:skill`) are defined in `claw/package.json`, not the repo-root `package.json`. Run them from the `claw/` directory, for example:
>
> ```bash
> cd claw && npm run hermes:skill -- --profile-root /path/to/DEXBot2 --output ~/.hermes/skills/bitshares-claw/SKILL.md
> ```

### ZeroClaw Compatibility

ZeroClaw should use Claw as a compatibility layer, not as a second signing or credential system.

- ZeroClaw can invoke the JSON/CLI bridge via `npm run zeroclaw:bridge`.
- The manifest lives in [../modules/claw_manifest.ts](../modules/claw_manifest.ts) and is safe to query without starting the BitShares runtime.
- Claw keeps private-key access inside its existing DEXBot2 credential path.
- ZeroClaw gets read access to market, profile, HONEST, and order context, plus explicit action entrypoints when it needs to request a trade operation.

The bridge surface currently includes:

- runtime and manifest inspection
- profile, market, and account snapshots
- open-order queries
- HONEST context and pricing
- limit order create, cancel, update, and batch execution
- MPA borrow, repay, collateral adjustment, and settlement
- BTS-backed short open, take-profit, close, and plan builders
- MPA position lookup

Launcher behavior such as `npm run claw:unlock` and `npm run pm2:claw-only` is documented and maintained separately under `skills/launcher-ops/`.

Recommended trust boundary:

1. ZeroClaw sends an intent or request.
2. Claw resolves the request and, when needed, asks DEXBot2 for the signing key.
3. DEXBot2 returns the key only to Claw over the local daemon socket.
4. Claw broadcasts the operation.
5. ZeroClaw never receives or stores the key.

To generate the skill file from Claw, run:

```bash
cd claw && npm run zeroclaw:skill -- --profile-root /path/to/DEXBot2 --output ~/.zeroclaw/workspace/skills/ai-bots/SKILL.toml
```

### NullClaw Compatibility

NullClaw uses the same bridge surface, with a native skill path centered on `SKILL.toml` in the workspace.

- NullClaw can invoke the JSON/CLI bridge via `npm run nullclaw:bridge`.
- The manifest lives in [../modules/claw_manifest.ts](../modules/claw_manifest.ts) and is safe to query without starting the BitShares runtime.
- Claw keeps private-key access inside its existing DEXBot2 credential path.
- NullClaw gets the same read access to market, profile, HONEST, and order context, plus explicit action entrypoints when it needs to request a trade operation.

To generate the skill file from Claw, run:

```bash
cd claw && npm run nullclaw:skill -- --profile-root /path/to/DEXBot2 --output ~/.nullclaw/workspace/skills/bitshares-claw/SKILL.toml
```

### NanoClaw Compatibility

NanoClaw uses the same bridge surface, with a native `SKILL.md` path in the workspace skill tree.

- NanoClaw can invoke the JSON/CLI bridge via `npm run nanoclaw:bridge`.
- The bridge lives in [../modules/claw_bridge.ts](../modules/claw_bridge.ts) and uses the shared Claw command surface.
- Keep the generated skill named `bitshares-claw` so it does not collide with NanoClaw's bundled `claw` skill.

To generate the skill file from Claw, run:

```bash
cd claw && npm run nanoclaw:skill -- --profile-root /path/to/DEXBot2 --output /path/to/nanoclaw/.claude/skills/bitshares-claw/SKILL.md
```

### OpenFang Compatibility

OpenFang uses the same bridge surface through a CLI-first wrapper and a workspace skill file.

- OpenFang can invoke the JSON/CLI bridge via `npm run openfang:bridge`.
- The bridge lives in [../modules/claw_bridge.ts](../modules/claw_bridge.ts) and uses the shared Claw command surface.
- Keep the generated skill named `bitshares-claw` so it stays separate from runtime-specific OpenFang skills and remains a thin wrapper around the shared CLI bridge.

To generate the skill file from Claw, run:

```bash
cd claw && npm run openfang:skill -- --profile-root /path/to/DEXBot2 --output ~/.openfang/skills/bitshares-claw/SKILL.md
```

### Hermes Compatibility

Hermes should consume Claw through the shared MCP server, with an optional local `SKILL.md` for workflow guidance.

- Hermes can invoke the MCP server in [../scripts/claw_mcp_server.ts](../scripts/claw_mcp_server.ts).
- The manifest is served by [../modules/claw_manifest.ts](../modules/claw_manifest.ts) and advertises Hermes as an MCP-first runtime over the shared Claw command surface.
- Keep the generated skill named `bitshares-claw` and focused on workflow guidance rather than copying bridge logic into Hermes.
- Claw keeps private-key access inside its existing DEXBot2 credential path.

To generate the Hermes skill file from Claw, run:

```bash
cd claw && npm run hermes:skill -- --profile-root /path/to/DEXBot2 --output ~/.hermes/skills/bitshares-claw/SKILL.md
```

Add the MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  claw:
    command: "node"
    args: ["/absolute/path/to/claw/scripts/claw_mcp_server.js", "--profile-root", "/path/to/DEXBot2"]
```

> The generated skill file emits the `node` + `.js` form so it works against the compiled build (`npm run build`) without `tsx` installed.

### OpenClaw Compatibility

OpenClaw is the native plugin runtime and the primary integration target.

- OpenClaw consumes the Claw bridge through native plugin registration; the `SKILL.md` form remains the workflow layer.
- The manifest lives in [../modules/claw_manifest.ts](../modules/claw_manifest.ts) and is safe to query without starting the BitShares runtime.
- Claw keeps private-key access inside its existing DEXBot2 credential path.
- OpenClaw gets the same read/plan/execute tool surface as the other runtimes.

To generate the OpenClaw skill file from Claw, run:

```bash
cd claw && npm run openclaw:skill -- --profile-root /path/to/DEXBot2 --output /path/to/openclaw/skills/bitshares-claw/SKILL.md
```

### NanoBot Compatibility

NanoBot uses the MCP stdio transport with newline-delimited JSON-RPC and a `SKILL.md` for workflow guidance.

- NanoBot connects to the shared MCP server in [../scripts/claw_mcp_server.ts](../scripts/claw_mcp_server.ts).
- The manifest is served by [../modules/claw_manifest.ts](../modules/claw_manifest.ts) and advertises NanoBot as an MCP-first runtime.
- Claw keeps private-key access inside its existing DEXBot2 credential path.
- NanoBot gets the same read/plan/execute tool surface as the other runtimes.

To generate the NanoBot skill file from Claw, run:

```bash
cd claw && npm run nanobot:skill -- --profile-root /path/to/DEXBot2 --output /path/to/nanobot/skills/bitshares-claw/SKILL.md
```

### PicoClaw Compatibility

PicoClaw mirrors NanoBot on native `SKILL.md` loading and MCP stdio integration.

- PicoClaw connects to the shared MCP server in [../scripts/claw_mcp_server.ts](../scripts/claw_mcp_server.ts).
- The manifest is served by [../modules/claw_manifest.ts](../modules/claw_manifest.ts) and advertises PicoClaw as an MCP-first runtime.
- Claw keeps private-key access inside its existing DEXBot2 credential path.
- PicoClaw gets the same read/plan/execute tool surface as the other runtimes.

To generate the PicoClaw skill file from Claw, run:

```bash
cd claw && npm run picoclaw:skill -- --profile-root /path/to/DEXBot2 --output /path/to/picoclaw/skills/bitshares-claw/SKILL.md
```

### memU Compatibility

memU provides 24/7 proactive memory for AI agents via a subprocess bridge and MCP stdio.

- The memU bridge lives in [../modules/memu_bridge.ts](../modules/memu_bridge.ts) and exposes a separate `memu-*` command surface (see "Command bridge" below for the full list).
- The memU MCP server is [../scripts/memu_mcp_server.ts](../scripts/memu_mcp_server.ts); run it with `npm run memu:mcp` from the `claw/` directory.
- memU memory operations are independent of the BitShares trading bridge: use `memu-*` tools for memory/preferences/context capture and the other Claw tools for on-chain operations.
- The hand-written skill file lives at `skills/memu-memory/SKILL.md` in the `claw/` tree.

To generate the memU skill file from Claw, run:

```bash
cd claw && npm run memu:skill -- --profile-root /path/to/DEXBot2 --output /path/to/memu/skills/bitshares-claw/SKILL.md
```

## Core Types

### `RuntimeContext`

The shared runtime wiring Claw assembles for its consumers.

```ts
type RuntimeContext = {
  accountName: string | null;
  createdAt: string;
  cwd: string;
  dataDir: string;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  name: string;
  profileRoot: string | null;
  readyFilePath: string;
  socketPath: string;
  stateDir: string;
  config: Record<string, unknown>;
};
```

### `BotState` (conceptual shape)

The bot-specific state Claw already owns and passes through the infrastructure layer. This is a conceptual shape — the authoritative type is `BotSettings` in [../modules/types.ts](../modules/types.ts); the runtime representation may differ slightly.

```ts
type BotState = {
  botId: string;
  name: string;
  activeOrders?: number;
  incrementPercent?: number;
  targetSpreadPercent?: number;
  weightDistribution?: { sell: number; buy: number };
  botFunds?: { sell: string | number; buy: string | number };
  minPrice?: string | number;
  maxPrice?: string | number;
  gridPrice?: string | number | null;
  poolRef?: string;
  lastResetAt?: number;
  lastGridCenterPrice?: number;
};
```

### `ConstraintSet` (conceptual shape)

The execution limits Claw wants its own logic to respect. This is a conceptual shape — not a defined TypeScript type in the codebase; see `ProfileOptions` and `ShortPositionOptions` in [../modules/types.ts](../modules/types.ts) for the closest concrete counterparts.

```ts
type ConstraintSet = {
  minIncrementPercent?: number;
  maxIncrementPercent?: number;
  minSpreadPercent?: number;
  maxSpreadPercent?: number;
  minOrdersPerSide?: number;
  maxOrdersPerSide?: number;
  reservePercent?: number;
  minOrderSize?: number;
  maxOrderSize?: number;
  avoidDust?: boolean;
};
```

## Public API

All functions below are implemented in the modules cited under "Core Types" or their headers and are reachable through the adapters/factories they document. Standalone names are exported from the cited modules; methods like `getBotSettings`, `previewBotSettingsUpdate`, `applyBotSettingsPatch`, and `getClawProfileContext` are closures returned by `createDexbotProfileAdapter` (not module-level exports). Signatures reflect the runtime types; see [../modules/types.ts](../modules/types.ts) for the authoritative TypeScript interfaces.

Internal-only modules that are intentionally **not** re-exported from [../index.ts](../index.ts): `modules/claw_launcher.ts`, `modules/launcher_mode_detector.ts`, `modules/launcher_paths.ts`, `modules/mcp_utils.ts`, `modules/mpa_utils.ts`, `modules/skill_utils.ts`, `modules/utils.ts`, and the type-only `modules/types.ts`. Import them directly when building inside `claw/`; they are not part of the public bridge surface.

### 1. `createRuntimeContext(options)`

Creates a shared runtime object for Claw ([../modules/claw_infra.ts](../modules/claw_infra.ts)).

```ts
type RuntimeContextOptions = {
  name: string;
  accountName?: string;
  socketPath?: string;
  readyFilePath?: string;
  dataDir?: string;
  stateDir?: string;
  profileRoot?: string;
  logger?: unknown;
  config?: Record<string, unknown>;
};
```

This is the central bootstrap helper for a consistent runtime shape.

### 2. `createBitsharesClient(options)`

Returns a read/write BitShares client wrapper ([../modules/claw_infra.ts](../modules/claw_infra.ts)).

The helper:

- connects to BitShares
- reuses the shared client pattern already in Claw
- asks the DEXBot2 credential daemon for keys when needed
- keeps key handling out of callers

### 3. `createCredentialClient(options)`

Returns a thin client for DEXBot2's Unix-socket credential daemon ([../modules/claw_infra.ts](../modules/claw_infra.ts)).

This is the bridge between Claw and the DEXBot2 credential infrastructure.

### 4. `createStateStore(options)`

Returns a simple filesystem-backed state store ([../modules/claw_infra.ts](../modules/claw_infra.ts)).

Typical use:

- bot metadata
- position snapshots
- cached market snapshots
- restart recovery

### 5. `createMarketAdapter(options)`

Returns a data access layer for market snapshots and chain-derived state ([../modules/claw_infra.ts](../modules/claw_infra.ts)).

This is infrastructure only:

- reads
- subscriptions
- normalization
- no decision making

### 6. `createOrderTools(options)`

Returns the DEXBot2 order subsystem exports directly ([../modules/claw_infra.ts](../modules/claw_infra.ts)):

- grid math
- order sizing
- spread calculation
- bounds validation
- fee estimation

This is the right place for reusable mechanics that Claw needs before it decides what to do.

### 7. `createDexbotProfileAdapter(profileRoot, options)`

Reads the DEXBot2 `profiles/` directory and normalizes ([../modules/dexbot_profiles.ts](../modules/dexbot_profiles.ts)):

- `profiles/bots.json`
- `profiles/general.settings.json`
- `profiles/market_profiles.json`
- per-bot files in `profiles/orders/`

This is the profile-folder bridge for Claw. `profiles/general.settings.json` is read-only context here, not a Claw write surface.

### 8. `getBotSettings(identifier, forceReload)`

Returns the current DEXBot2 bot config in a normalized, read-only view.

The result includes:

- raw bot data
- effective values with DEXBot2 defaults merged in
- current validation status
- file locations for the selected bot
- mutability metadata for the bridge

### 9. `previewBotSettingsUpdate(identifier, patch, options)`

Validates a bot-settings patch without writing it.

Call this before any settings write to check:

- merged next-state values
- validation errors
- whether the patch would require a recalc trigger

### 10. `applyBotSettingsPatch(identifier, patch, options)`

Applies a bot-settings patch through the DEXBot2 profile lock.

The helper:

- acquires the `bots.json` lock before reading and writing
- merges the patch against the current bot record
- validates the merged result before persisting
- optionally writes the recalc trigger atomically while still inside the lock
- reloads the bundle before returning the updated bot view

This is the preferred write path for bot tuning and for any bridge command that needs to change DEXBot2 bot settings safely.

### 11. `getClawProfileContext(identifier, options)`

Returns one normalized JSON object that combines:

- DEXBot2 profile files
- selected bot metadata
- selected bot order snapshots
- selected AMA profile match
- derived summary fields

This is the preferred one-call entrypoint for Claw.

### 12. `createHonestEcosystemAdapter(options)`

Returns a HONEST-focused infrastructure helper ([../modules/honest_ecosystem.ts](../modules/honest_ecosystem.ts)) that:

- loads `HONEST.*` assets
- exposes the hardcoded `HONEST.MONEY/BTS` bridge
- resolves HONEST pair contexts with DEXBot2 pool utilities
- resolves pair prices without introducing strategy decisions

Companion method:

- `resolveHonestPairPrice(assetA, assetB, options)` for the special-case bridge plus DEXBot2 fallback pool pricing

### 13. Command bridge

The bridge exposed by [../modules/claw_bridge.ts](../modules/claw_bridge.ts) supports:

- `manifest`
- `runtime`
- `profile-context`
- `market-snapshot`
- `account-snapshot`
- `open-orders`
- `honest-context`
- `honest-pair`
- `honest-price`
- `create-limit-order`
- `cancel-limit-order`
- `build-update-limit-order-op`
- `update-limit-order`
- `execute-batch`
- `borrow-mpa`
- `repay-mpa`
- `adjust-mpa-collateral`
- `settle-mpa`
- `open-short-bts`
- `take-profit-bts`
- `close-short-bts`
- `build-open-short-plan`
- `build-take-profit-plan`
- `build-close-short-plan`
- `mpa-position`
- `bot-settings`
- `bot-settings-preview`
- `bot-settings-apply`
- `credit-runtime-status`
- `credit-runtime-refresh`
- `credit-runtime-maintenance`
- `credit-runtime-watchdog`
- `credit-runtime-reborrows`
- `launcher-run`
- `launcher-drystart`
- `launcher-reset`
- `launcher-disable`
- `launcher-pm2-start`
- `launcher-pm2-stop`
- `launcher-pm2-delete`
- `launcher-pm2-restart`

#### memU command surface

The bridge also handles a separate memU memory surface (see [../modules/memu_bridge.ts](../modules/memu_bridge.ts)):

- `memu-manifest`
- `memu-memorize`
- `memu-retrieve`
- `memu-list-categories`
- `memu-list-items`
- `memu-create-item`
- `memu-update-item`
- `memu-delete-item`
- `memu-clear`
- `memu-status`
- `memu-memorize-conversation`
- `memu-memorize-trading-context`
- `memu-retrieve-trading-context`

## Root Export Disambiguation

The barrel export in `claw/index.ts` spreads every module into one flat namespace. Several modules define functions with the same name but different semantics. The barrel resolves these collisions with explicit trailing overrides:

| Export name | Source module | Purpose |
|---|---|---|---|
| `resolveAccountName` | `chain_queries` | Async lookup — returns the account name string for an ID, or passes through the original name |
| `resolveSigningAccountName` | `chain_broadcast` | Sync extraction — returns the signing account name string from a context object |
| `describeMemuBridge` | `memuBridge` | Returns the memU bridge descriptor |

All runtime manifests are served by the single `describeClawBridge({ runtimeName })` call in [../modules/claw_manifest.ts](../modules/claw_manifest.ts).

> **Alias note:** `resolveSigningAccountName` in the table above is an alias assigned in [../index.ts](../index.ts) — the underlying function in [../modules/chain_broadcast.ts](../modules/chain_broadcast.ts) is also named `resolveAccountName`. The barrel export renames it to `resolveSigningAccountName` to disambiguate it from the async `chain_queries` lookup, so callers see two distinct names on the flat namespace.

## Suggested Runtime Flow

1. Claw collects market data and its own state.
2. Claw creates shared runtime helpers via `createRuntimeContext`.
3. Claw loads the DEXBot2 profile bundle through the adapter.
4. Claw uses HONEST and profile context helpers when needed.
5. Claw makes all decisions.
6. Claw executes against DEXBot2 and the blockchain.

That keeps the separation clean:

- Claw infrastructure provides the foundation
- Claw workflow decides
- DEXBot2 supports runtime execution

## Practical Policy

The Claw infrastructure layer should be allowed to provide:

- connection wrappers
- credential daemon access
- file-backed state stores
- market-data adapters
- order and grid math helpers
- validation and normalization utilities
- explicit execution adapters that still keep key material behind DEXBot2

The Claw infrastructure layer should not be responsible for:

- strategy decisions
- signing policy
- key ownership
- PM2 lifecycle
- bot orchestration
- persisting execution decisions
- autonomous trade execution without explicit caller intent

## Minimal JSON Contract

If you want the simplest possible integration, use one request and one response for infrastructure wiring.

### Request

```json
{
  "runtime": {
    "name": "claw-runtime",
    "accountName": "your-account",
    "socketPath": "./profiles/run/dexbot-cred-daemon.sock"
  },
  "state": {
    "botId": "claw-01",
    "dataDir": "./data",
    "stateDir": "./data/state"
  }
}
```

### Response

Example response with the resolved absolute socket path:

```json
{
  "runtime": {
    "ready": true,
    "resolvedSocketPath": "/app/profiles/run/dexbot-cred-daemon.sock",
    "notes": ["Credential daemon is reachable."]
  },
  "stores": {
    "stateStore": "filesystem",
    "cacheStore": "filesystem"
  },
  "tools": {
    "orderMath": "available",
    "marketAdapter": "available",
    "bitsharesClient": "available"
  }
}
```

## Good Default Split

If you want a simple division of responsibility:

- `Claw` infrastructure provides the common foundation
- `Claw` workflow makes trading decisions
- `DEXBot2` handles the runtime substrate and credentials

That gives you a reusable infrastructure layer without coupling it to any single executor.
