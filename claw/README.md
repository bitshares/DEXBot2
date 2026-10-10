# Claw BitShares Bridge

> **⚠️ EXPERIMENTAL — Use at your own risk.**  
> The Claw subsystem handles live blockchain operations (create/cancel orders, borrow/repay MPAs, adjust collateral). It has not undergone the same level of production hardening, race-condition testing, and edge-case validation as the core DEXBot2 runtime. Review all actions before execution, especially in the `short_mpa_strategy`, `decision_loop`, and `position_health` modules.

Integration layer for BitShares blockchain operations from DEXBot2 and supported Claw runtimes (OpenClaw, Hermes, OpenFang, NanoBot, PicoClaw, NanoClaw, ZeroClaw, NullClaw, memU). Follows the same split as DEXBot2: shared client for reads, separate signing client for writes, and small query/broadcast layers.

## Contents

- [Install](#install)
- [Responsibility Boundary](#responsibility-boundary)
- [Run The Example](#run-the-example)
- [Standard Short Workflow](#standard-short-workflow)
- [Position Manager](#position-manager)
- [HONEST Asset Report](#honest-asset-report)
- [Signing And Broadcast](#signing-and-broadcast)
- [PM2](#pm2)
- [Skill Packs](#skill-packs)
- [Multi-Runtime Support](#multi-runtime-support)
- [HONEST Ecosystem Helper](#honest-ecosystem-helper)
- [Position Health](#position-health)
- [Bot Settings](#bot-settings)
- [High-Level Actions](#high-level-actions)

## Which section do I need?

| If you want to… | Read this | Key command |
|-----------------|-----------|-------------|
| Try a connection test | [Run The Example](#run-the-example) | `npm run example:connection` |
| Open / take-profit / close a short MPA position | [Standard Short Workflow](#standard-short-workflow) | `npm run example:short-mpa-bts` |
| Track persistent short positions | [Position Manager](#position-manager) | `npm run example:position-manager` |
| Choose a runtime (OpenClaw, Hermes, NanoBot, etc.) | [Multi-Runtime Support](#multi-runtime-support) | — |
| Generate skill files for a runtime | [Multi-Runtime Support](#multi-runtime-support) | `npm run <runtime>:skill` |
| Preview or apply bot setting changes | [Bot Settings](#bot-settings) | `npm run claw:bridge -- bot-settings-preview` |
| Inspect an on-chain MPA position | [Position Health](#position-health) | `npm run claw:bridge -- mpa-position` |
| List HONEST asset pricing | [HONEST Asset Report](#honest-asset-report) | `npm run report:honest-assets` |

## Install

```bash
npm install
```

## Files

<details><summary>Module and file map (click to expand)</summary>

- Core BitShares runtime: `modules/bitshares_client.ts`, `modules/chain_queries.ts`, `modules/chain_broadcast.ts`, `modules/chain_actions.ts`
- Strategy and state helpers: `modules/short_mpa_strategy.ts`, `modules/position_manager.ts`, `modules/position_manager_watch.ts`
- Position health: `modules/position_health.ts`, `modules/position_discovery.ts`, `modules/decision_loop.ts`
- Price sources: `modules/feed_price_source.ts`, `modules/kibana_price_source.ts`
- DEXBot2 and Claw integration: `modules/dexbot_bridge.ts`, `modules/dexbot_profiles.ts`, `modules/dexbot_credential_client.ts`, `modules/claw_bridge.ts`, `modules/claw_catalog.ts`, `modules/claw_manifest.ts`, `modules/claw_skill_md.ts`, `modules/claw_runtime_matrix.ts`, `modules/credit_runtime_adapter.ts`, `scripts/claw_bridge.ts`, `scripts/claw_mcp_server.ts`
- memU support: `modules/memu_bridge.ts`, `scripts/memu_runner.py`, `scripts/memu_mcp_server.ts`
- Skill packs: `skills/bitshares-guide/SKILL.md`, `skills/margin-trading/SKILL.md`, `skills/trend-detection/SKILL.md`, `skills/launcher-ops/SKILL.md`, `skills/memu-memory/SKILL.md`, shared boundary references under `skills/shared/references/`
- HONEST support: `modules/honest_ecosystem.ts`, `modules/liquidity_pools.ts`
- Launcher and paths: `modules/claw_launcher.ts`, `modules/launcher_mode_detector.ts`, `modules/launcher_paths.ts`
- Shared runtime infrastructure: `modules/claw_infra.ts`, `modules/types.ts`, `modules/utils.ts`, `modules/skill_utils.ts`, `modules/mcp_utils.ts`
- MPA utilities: `modules/mpa_utils.ts`
- Reference docs: `docs/AI_BOT_LIBRARY_API.md`, `docs/DEXBOT2_TUNING_CHEAT_SHEET.md`, `docs/POSITION_HEALTH.md`, `docs/RUNTIME_COMPARISON.md`
- Example entrypoints: `examples/connection_test.ts`, `examples/short_mpa_bts_strategy.ts`, `examples/position_manager_cli.ts`, `examples/memu_integration_example.ts`, `examples/claw_profiles_example.ts`, `examples/claw_consumer_example.ts`, `examples/claw_infra_example.ts`, `examples/honest_ecosystem_example.ts`

</details>

## Responsibility Boundary

`claw/` is a bridge subtree and integration layer around DEXBot2, not a replacement for the main DEXBot2 runtime.

What it does:

- expose a local JSON/CLI bridge and native runtime packaging for OpenClaw, Hermes, OpenFang, NanoBot, PicoClaw, NanoClaw, ZeroClaw, NullClaw, and memU
- provide BitShares read helpers, broadcast helpers, and account/action wrappers
- expose DEXBot2 profile context, order utilities, and liquidity/pool helpers through a smaller surface
- provide HONEST context helpers, short-MPA helper flows, and position-manager utilities
- generate runtime-native skill definitions and bridge metadata from a shared command catalog
- keep launcher orchestration as its own skill boundary rather than folding PM2 or Docker startup into trading/reference skills

What it does not do:

- replace the main DEXBot2 bot engine or orchestration loop
- own credentials or hand raw private keys to non-DEXBot2 callers (private keys are only forwarded to the credit runtime subsystem for signing, not exposed to ZeroClaw, NanoClaw, or NullClaw callers directly)
- become the canonical source of truth for core DEXBot2 math or runtime behavior
- make strategy decisions for the main bot runtime beyond the explicit helper flows included here
- guarantee that exposed write actions are safe just because they are wrapped by the bridge

## Run The Example

```bash
npm run example:connection
```

## Standard Short Workflow

The default strategy path is now `MPA/BTS` only:

- borrow the MPA against `BTS` collateral
- place a maker sell order on `MPA/BTS`
- place a maker rebuy order on `MPA/BTS`
- repay the MPA debt and optionally release `BTS` collateral

Dry-run the plan:

```bash
npm run example:short-mpa-bts -- --mode open --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000
```

Broadcast the open leg:

```bash
npm run example:short-mpa-bts -- --mode open --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000 --execute
```

Place the take-profit rebuy order:

```bash
npm run example:short-mpa-bts -- --mode tp --mpa HONEST.USD --cover 10 --buy-price 900 --execute
```

Repay debt and release collateral:

```bash
npm run example:short-mpa-bts -- --mode close --mpa HONEST.USD --repay 10 --release-collateral 25000 --execute
```

## Position Manager

Persistent short-position tracking is available through `modules/position_manager.ts` and the `example:position-manager` CLI.

```bash
npm run example:position-manager -- --mode create --account your-account --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000
```

## HONEST Asset Report

Scan BitShares assets, isolate `HONEST.*`, and report HONEST pricing:

```bash
npm run report:honest-assets
```

JSON output:

```bash
node ../dist/claw/scripts/honest_assets_report.js --json
```

## Signing And Broadcast

Set the account name by CLI or environment:

```bash
export BITSHARES_ACCOUNT="your-account"
```

Signing uses the DEXBot2 credential daemon. See the API doc for the trust boundary.

## PM2

PM2 can run the watcher process built from `modules/position_manager_watch.ts` alongside DEXBot2:

```bash
npm run service:position-watch -- --account your-account
npm run pm2:start
```

## Skill Packs

The `skills/` tree is intentionally split by responsibility:

- `bitshares-guide` is presentation-only and should stay free of operational instructions.
- `margin-trading` is concept-reference only and should stay free of launcher or deployment content.
- `launcher-ops` owns PM2 startup, `unlock`, `--claw-only`, Docker-friendly startup, and launcher validation.

Shared boundary notes live in `skills/shared/references/skill-boundaries.md`.

## Multi-Runtime Support

`claw/` supports nine native runtime families. Choose based on your integration style:

| Runtime | Native integration | Best fit | Main tradeoff |
| --- | --- | --- | --- |
| OpenClaw | Native plugin plus optional `SKILL.md` | Broadest assistant surface and plugin depth | Richest runtime surface, but also the highest operational complexity |
| Hermes | MCP server plus optional `SKILL.md` | General-purpose assistant with memory, messaging, and cron | Broader agent platform, but unnecessary overhead if you only need DEXBot actions |
| OpenFang | CLI bridge plus workspace `SKILL.md` | CLI-first local workspace integration | Best when the runtime should consume a thin generated bridge rather than a vendored adapter stack |
| NanoBot | MCP plus `SKILL.md` | Simple MCP integration with Python ergonomics | Easier to inspect, but slower and heavier than Go or Rust |
| PicoClaw | MCP plus `SKILL.md` | Small Go binary and low-cost hardware | Great for tiny boards, but still evolving quickly |
| NanoClaw | `SKILL.md` skill file plus local JSON bridge | Claude Code skill-driven local runtime | Keep the DEXBot2 bridge skill named `bitshares-claw` so it does not collide with NanoClaw's built-in `claw` skill |
| ZeroClaw | `SKILL.toml` skill manifest | Lowest footprint and fastest startup | Best cold starts, but the most specialized Rust-oriented workflow |
| NullClaw | `SKILL.toml` skill manifest plus MCP server config | Zig-native workspace assistant with manifest loading | Strong fit for local workspace loading, but more dependent on NullClaw-specific config conventions |
| memU | Subprocess bridge plus MCP server | Proactive memory and intent capture for AI agents | Python-based memory framework with LLM-powered extraction and vector search |

<details><summary>Quick selection rule of thumb (click to expand)</summary>

- Choose **OpenClaw** for the broadest assistant platform.
- Choose **Hermes** if you want a general-purpose assistant with memory, messaging, cron, and browser tooling that can also trade through Claw.
- Choose **OpenFang** for a CLI-first local workspace integration with a thin generated skill file.
- Choose **NanoBot** for a compact Python codebase with MCP tooling.
- Choose **PicoClaw** for a small Go runtime with launcher support.
- Choose **NanoClaw** for a Claude Code skill-driven local assistant with a narrow local bridge.
- Choose **ZeroClaw** for the smallest and most deterministic runtime.
- Choose **NullClaw** for a Zig-native runtime with workspace-centric skill loading.
- Choose **memU** for 24/7 proactive memory that captures user intent and reduces LLM token costs.

</details>

For a deeper comparison, see [docs/RUNTIME_COMPARISON.md](docs/RUNTIME_COMPARISON.md). Run the commands below from the `claw/` directory.

### Shared Bridge

Use the runtime-neutral bridge command for JSON-friendly local integration:

```bash
npm run claw:bridge -- manifest
npm run claw:bridge -- profile-context --payload '{"botRef":"default"}'
npm run claw:bridge -- market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
```

### Bot Settings

Use the bridge to read, preview, and apply DEXBot2 bot settings through the locked profile adapter:

```bash
npm run claw:bridge -- bot-settings --payload '{"botRef":"default"}'
npm run claw:bridge -- bot-settings-preview --payload '{"botRef":"default","patch":{"incrementPercent":0.4,"weightDistribution":{"sell":0.7,"buy":0.4}}}'
npm run claw:bridge -- bot-settings-apply --payload '{"botRef":"default","patch":{"incrementPercent":0.4,"weightDistribution":{"sell":0.7,"buy":0.4}}}'
```

Settings writes are serialized through the profile lock and the recalc trigger is written atomically, so concurrent bot-setting updates do not clobber each other.

### OpenClaw

Install the native plugin bundle from this repository:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run build
openclaw plugins install -l "$CLAW_ROOT"
openclaw plugins enable bitshares-claw
```

Generate an optional OpenClaw `SKILL.md`:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run openclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
```

Available bridge and native tool surfaces include:

- runtime and manifest inspection
- profile, market, and account snapshots
- open-order queries
- HONEST context and pricing
- limit order create, cancel, update, and batch execution
- MPA borrow, repay, collateral adjustment, and settlement
- BTS-backed short open, take-profit, close, and plan builders
- MPA position lookup
- credit runtime status, refresh, maintenance, watchdog, and reborrow management
- launcher run, drystart, reset, disable, and PM2 lifecycle commands

### OpenFang

Generate the OpenFang skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run openfang:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.openfang/skills/bitshares-claw/SKILL.md
```

OpenFang uses the same shared bridge surface through a local CLI wrapper.

<details><summary>Compatibility command surface (click to expand)</summary>

```bash
npm run openfang:bridge -- manifest
npm run openfang:bridge -- profile-context --payload '{"botRef":"default"}'
npm run openfang:bridge -- market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
npm run openfang:bridge -- create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
```

</details>

### Hermes

Generate the Hermes skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run hermes:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.hermes/skills/bitshares-claw/SKILL.md
```

Add the shared Claw MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  claw:
    command: "node"
    args: ["/absolute/path/to/DEXBot2/dist/claw/scripts/claw_mcp_server.js", "--profile-root", "/absolute/path/to/DEXBot2"]
```

Hermes should use the shared MCP server for live tools and keep the generated `SKILL.md` focused on workflow guidance. The Claw MCP server registers raw tool ids such as `claw_manifest`; if Hermes shows a namespaced label in its UI, use the label shown there.

### NanoBot and PicoClaw

Run the MCP server over stdio:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
node ../dist/claw/scripts/claw_mcp_server.js --profile-root "$DEXBOT_ROOT"
```

The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.

Generate a runtime-native `SKILL.md`:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run nanobot:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
npm run picoclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
```

On a fresh PicoClaw install, make sure `agents.defaults.workspace` is configured in `config.json` or run `picoclaw onboard` before expecting workspace skills to appear.

### NanoClaw

Generate the NanoClaw skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run nanoclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output /path/to/nanoclaw/.claude/skills/bitshares-claw/SKILL.md
```

NanoClaw already ships its own `claw` skill, so keep this bridge skill named `bitshares-claw`.

<details><summary>Compatibility command surface (click to expand)</summary>

```bash
npm run nanoclaw:bridge -- manifest
npm run nanoclaw:bridge -- profile-context --payload '{"botRef":"default"}'
npm run nanoclaw:bridge -- market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
npm run nanoclaw:bridge -- create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
```

</details>

### ZeroClaw

Generate the ZeroClaw skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run zeroclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.zeroclaw/workspace/skills/ai-bots/SKILL.toml
```

<details><summary>Compatibility command surface (click to expand)</summary>

```bash
npm run zeroclaw:bridge -- manifest
npm run zeroclaw:bridge -- profile-context --payload '{"botRef":"default"}'
npm run zeroclaw:bridge -- market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
npm run zeroclaw:bridge -- create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
npm run zeroclaw:bridge -- update-limit-order --payload '{"accountName":"your-account","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'
npm run zeroclaw:bridge -- execute-batch --payload '{"accountName":"your-account","operations":[]}'
npm run zeroclaw:bridge -- borrow-mpa --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD","debtDelta":10,"collateralDelta":25000}'
```

</details>

### NullClaw

Generate the NullClaw skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run nullclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.nullclaw/workspace/skills/bitshares-claw/SKILL.toml
```

<details><summary>Compatibility command surface (click to expand)</summary>

```bash
npm run nullclaw:bridge -- manifest
npm run nullclaw:bridge -- profile-context --payload '{"botRef":"default"}'
npm run nullclaw:bridge -- market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
npm run nullclaw:bridge -- create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
npm run nullclaw:bridge -- update-limit-order --payload '{"accountName":"your-account","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'
npm run nullclaw:bridge -- execute-batch --payload '{"accountName":"your-account","operations":[]}'
npm run nullclaw:bridge -- borrow-mpa --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD","debtDelta":10,"collateralDelta":25000}'
```

</details>

### memU

memU provides 24/7 proactive memory for AI agents. It captures user intent, reduces LLM token costs, and enables context-aware trading assistance.

**Prerequisites:**

```bash
pip install memu-py
export OPENAI_API_KEY=your_api_key
```

Start the memU MCP server:

```bash
npm run memu:mcp
# or
node ../dist/claw/scripts/memu_mcp_server.js --memu-dir /path/to/claw/data/memu
```

`--memu-dir` is optional; it defaults to the resolved memU data directory
(`claw/data/memu` for a source checkout, otherwise under the active profiles
dir) and can be overridden with `DEXBOT_CLAW_DATA_DIR`.

Check memU status:

```bash
npm run memu:status
```

memU MCP server configuration for Hermes:

```yaml
mcp_servers:
  memu:
    command: "node"
    args: ["/absolute/path/to/DEXBot2/dist/claw/scripts/memu_mcp_server.js", "--memu-dir", "/absolute/path/to/claw/data/memu"]
```

<details><summary>Compatibility command surface (click to expand)</summary>

```bash
# Via claw bridge
npm run claw:bridge -- memu-manifest
npm run claw:bridge -- memu-memorize --payload '{"resourceUrl":"/path/to/conv.txt","modality":"conversation"}'
npm run claw:bridge -- memu-retrieve --payload '{"queries":[{"role":"user","content":{"text":"What are my trading preferences?"}}]}'
npm run claw:bridge -- memu-status

# Via npm scripts
npm run memu:status
npm run memu:mcp
```

</details>

Available memU capabilities:

- memorize conversations, documents, images, video, and audio
- retrieve memories via RAG (fast) or LLM (deep reasoning)
- list and manage memory categories and items
- trading context memorization and retrieval
- proactive intent capture and preference learning

See [skills/memu-memory/SKILL.md](skills/memu-memory/SKILL.md) for detailed usage patterns.

## HONEST Ecosystem Helper

Inspect the HONEST asset context and a requested LP pair:

```bash
npm run example:honest-ecosystem -- HONEST.MONEY/BTS
```

## Position Health

The position health subsystem discovers on-chain debt positions, classifies collateral ratios into a 3-zone model, checks trend alignment, and recommends actions. See [docs/POSITION_HEALTH.md](docs/POSITION_HEALTH.md) for the full reference.

Inspect one on-chain MPA position:

```bash
npm run claw:bridge -- mpa-position --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD"}'
```

The decision loop (`modules/decision_loop.ts`) is exposed as a module API. Its `evaluate()` call ties discovery, trend analysis, and health assessment into a single result with prioritized actions.

## Bot Settings

Read, preview, and apply DEXBot2 bot settings through the locked profile adapter. Settings writes are serialized through the profile lock, ensuring concurrent updates do not clobber each other. The recalc trigger is written atomically after each apply.

Inspect the default policy:

```bash
npm run claw:bridge -- bot-settings --payload '{"botRef":"default"}'
```

Preview an update without applying:

```bash
npm run claw:bridge -- bot-settings-preview --payload '{"botRef":"default","patch":{"weightDistribution":{"sell":0.7,"buy":0.4}}}'
```

Apply the update and write the recalc trigger:

```bash
npm run claw:bridge -- bot-settings-apply --payload '{"botRef":"default","patch":{"weightDistribution":{"sell":0.7,"buy":0.4}}}'
```

## High-Level Actions

The starter now includes these bot-facing actions in `modules/chain_actions.ts`:

- create limit orders
- cancel limit orders
- update limit orders
- execute batches of operations
- subscribe to account fill events
- borrow MPAs
- repay MPA debt
- adjust MPA collateral
- settle MPAs
