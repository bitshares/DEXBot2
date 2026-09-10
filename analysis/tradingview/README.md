# TradingView HTML Exporter

This exporter generates a standalone HTML chart in the `analysis/charts/` folder using the local `uPlot`-based TradingView-style renderer.

## Recommended: `dexbot tv` (One Step)

`dexbot tv` fetches the candles itself (chunked Kibana scans: pools with order-book fallback for pairs) and then renders through this exporter — no manual fetch/export steps needed:

```bash
# Bot chart with AMA overlay (bot key from profiles/bots.json, default: 3 months)
dexbot tv <bot>

# Any pool by bare or full ID
dexbot tv 133
dexbot tv 1.19.133

# Any pair (pool-first, order-book fallback)
dexbot tv TOKENA/TOKENB

# MPA price-feed history instead of market candles (opt-in; MPA/MPA pairs
# cross both feeds into one quote, e.g. HONEST.USD/HONEST.EUR)
dexbot tv BTS/HONEST.USD --feed

# Options
dexbot tv <bot> --month 6              # months of 1h candles (default: 3)
dexbot tv <bot> --chart analysis/charts/custom.html
dexbot tv BTS/HONEST.USD --book # override: order-book fills instead of the pool
```

Output: `analysis/charts/tv_<bot|pool_<id>|<a>_<b>>_1h_<N>m.html`, with a clickable `file://` link printed on completion. Unknown targets fail fast with the list of known bot keys.

The sections below cover manual usage (explicit candle files, direct runner flags).

## What It Produces

- Log-scale price chart
- Candle timeframe buttons: `1h`, `4h`, `1d`, `1w`, `1M` (`1M` aggregates to fixed 30-day buckets)
- Pair-orientation switcher for `A/B` and `B/A`
- SMA overlay
- AMA preset buttons `1–4` (one-click AMA1–4, active preset highlighted; numeric inputs kept)
- Bot-grid range highlight, off by default (the bot's min/max around AMA with live asymmetric tilt; red above AMA, green below)
- Range-scale switch: fit the price axis to the range band
- VWMA overlay
- Order overlay for bot charts (active grid buys/sells as dashed levels, reserve line at AMA × gridLo, "buys end" floor, spread label; pair-aware, toggle in-chart)
- Market panel (top-right): `MKT` + best `BUY`/`SELL` levels with distance-to-market %
- Bottom volume panel with `Volume` toggle, per-bar hover tooltip, and visible-range `max` label
- Crosshair legend with current candle values

## Quick Start

A chart requires candle data. Either pass an explicit candle file or let the exporter resolve a bot's candles and AMA settings:

```bash
# From an explicit candle JSON file (json source is the default)
npm run analysis:tradingview -- \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json
```

Or with a bot key (see [Bot-Key Usage](#bot-key-usage-recommended) below):

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key>
```

This writes:

```text
analysis/charts/tradingview_chart.html
```

> The bare `npm run analysis:tradingview` (no args) errors out — the default `json`
> source requires `--file`, and the `market_adapter` source requires `--bot-key`.

## Bot-Key Usage (Recommended)

The easiest way to generate a chart for a specific bot. Pass the bot key from `profiles/bots.json` and the exporter automatically resolves the candle file and AMA settings:

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key>
```

This picks up the bot's asset pair, market profile AMA defaults, and candle data from `market_adapter/data/`. AMA is auto-enabled when the bot uses `gridPrice: "ama"` (or ama1-4).

With a custom chart path:

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key> \
  --chart analysis/charts/<pair>_tradingview.html
```

CLI direct equivalent:

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --source market_adapter \
  --bot-key <bot-key>
```

### How It Works

1. Reads `profiles/bots.json` to find the bot's `assetA`, `assetB`, and `ama` settings.
2. Resolves the candle file at `market_adapter/data/market_adapter_<bot-key>_1h.json`.
3. Looks up the matching market profile in `profiles/market_profiles.json` for AMA defaults.
4. AMA settings priority: bot-specific `ama` object > market profile > constants (AMA3, slowPeriod 83.6).

> The candle file must exist — run the market adapter LP exporter first if needed (see [Getting Blockchain Data](#getting-blockchain-data)).

## From an Explicit Candle File

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json \
  --chart analysis/charts/<pair>_tradingview.html
```

Using LP candle files directly:

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/lp/<pair-folder>/lp_pool_<id>_<interval>.json \
  --chart analysis/charts/tradingview_chart.html
```

## Input Format

The exporter accepts candle data in either of these shapes:

- Array rows: `[timestamp_ms, open, high, low, close, volume]`
- Object rows: `{ time|timestamp|ts, open, high, low, close, volume }`

If you pass a raw JSON file, the runner normalizes the candles before rendering.

## Getting Blockchain Data

Use the market adapter LP exporter to pull blockchain-backed candles before generating the HTML:

```bash
# Auto mode — resolves pool + precisions from bots.json / blockchain
node dist/market_adapter/inputs/fetch_lp_data.js --bot BTS-USDT --interval 1h --lookback 4392h

# Or with an explicit date range
node dist/market_adapter/inputs/fetch_lp_data.js --bot BTS-USDT --interval 1h --start 2026-02-23 --end 2026-08-23

# Manual mode — no blockchain needed
node dist/market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 26280h
```

For date range fetching, use `--start` and `--end` (e.g. `--start 2024-03-06 --end 2025-03-06`).

That writes a JSON file under `market_adapter/data/lp/` which you can then pass to the TradingView exporter:

```text
market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

| Flag | Description |
|------|-------------|
| `--bot <name>` | Bot name from `profiles/bots.json` (auto-resolves pool) |
| `--pool <id>` | Manual mode, no blockchain needed (requires `--precA/--precB`) |
| `--interval <1m\|5m\|15m\|30m\|1h\|2h\|4h\|6h\|12h\|1d\|1w>` | Candle bucket size (bare numbers = seconds, e.g. `1800` = 30m) |
| `--lookback <N>h` | Hours back from now |
| `--start / --end` | Explicit date range (e.g. `2026-02-23`) |
| `--out <path>` | Custom output path |

> **Note:** the fetcher may not exit on its own after printing `Saved:` (the live BitShares WebSocket + node monitor keep the process alive). It is safe to Ctrl+C once the file is saved.

## CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--source <json\|market_adapter>` | Data source type | `json` |
| `--file <path>` | Candle JSON input file (required for `json` source) | — |
| `--bot-key <key>` | Bot key for `market_adapter` source | — |
| `--chart <path>` | Output HTML file | `analysis/charts/tradingview_chart.html` |
| `--title <text>` | Chart title | auto-generated from meta |
| `--price-scale <log\|linear>` | Price-axis scale | `log` |
| `--sma-period <n>` | SMA period | `500` |
| `--ama-er-period <n>` | AMA ER period | `781` |
| `--ama-fast-period <n>` | AMA fast period | `5.2` |
| `--ama-slow-period <n>` | AMA slow period | `83.6` |
| `--vwap-bars <n>` | Rolling VWMA window | `500` |
| `--no-sma` | Disable SMA | — |
| `--no-ama` | Disable AMA | — |
| `--no-vwap` | Disable VWMA | — |
| `--range` | Enable range highlight (off by default; toggle in-chart) | off |
| `--no-range` | Disable range highlight | — |
| `--range-scale` | Range Scaling: size the band by AMA slope like the grid build + fit price axis to it | — |
| `--range-span <mult>` | x-range around AMA, 1.2–2 (default: bot grid setting) | bot grid |
| `--orders-file <path>` | Order-grid JSON override for the overlay (default: `profiles/orders/<botKey>.json`) | bot orders |
| `--no-orders` | Disable the order overlay (levels, reserve line, floor/spread labels) | — |
| `--update-marker-ts <sec>` | Draw an "updated from here" line at the given unix timestamp | — |
| `--update-marker-bars <n>` | Bar count shown in the update-marker tag (e.g. `(+12)`) | — |
| `--quiet` | Suppress progress logs | — |

## Notes

- The chart uses vendored `uPlot` from `analysis/uplot/` in the generated HTML (no CDN dependency).
- The displayed indicators are computed from the 1h base candles and then sampled onto the selected timeframe.
- The current volume-weighted overlay is a rolling `VWMA`, not a session-reset VWAP.
- SMA is disabled by default.
- VWMA is disabled by default.
- AMA is auto-enabled when the bot has `gridPrice: "ama"` (or ama1-4), otherwise disabled by default.
- The AMA controls start with the bot-specific AMA, then pair-specific entry from `profiles/market_profiles.json` when available, falling back to AMA3 values from `modules/constants.ts`.
- The AMA `Reset` button restores the HTML defaults, not the browser-stored overrides.
- The pair switcher inverts the candles client-side, so you can inspect both `A/B` and `B/A` views from one export. The order overlay inverts with it (same levels in display units, side colors preserved).
- The order overlay resolves from `profiles/orders/<botKey>.json` (same files `scripts/analyze-orders.ts` reads): active/partial grid orders only. Pool/pair charts without a bot key render without it, silently — with the default uPlot gridlines kept. `--no-orders` removes the whole overlay (levels, reserve line, floor/spread labels); the in-chart `Orders` checkbox does the same when orders are present. The reserve line uses the bot's relative `minPrice` (`"Nx"` → `1/N`) times the live AMA; with an absolute/numeric bound the line is skipped rather than drawn at an invented level.
- The update marker falls back to `prevUpdateLastCandleSec` / `prevUpdateNewBars` stamped in the candle-file `meta` when the flags are absent; those fields are written by external incremental-fetch tooling, not by anything in this repo.
- `Ctrl+0` (or `Cmd+0`) resets the time-axis zoom to the full dataset.
- Indicator, timeframe, scale, and overlay-visibility changes are persisted in browser `localStorage` for the generated HTML.
- The price axis defaults to log base `10`, with a toolbar switch for `Log` / `Linear`.
- If you regenerate the HTML and then open it later, no CDN access is needed — `uPlot` is loaded from the vendored local copy at `analysis/uplot/`.

## Typical Workflow

1. Pick or generate a candle JSON file.
2. Run `npm run analysis:tradingview` or call the runner directly.
3. Open `analysis/charts/tradingview_chart.html` in a browser.
4. Use the timeframe buttons and indicator controls at the top of the page.
