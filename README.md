# DEXBot2

A sophisticated market making bot for the BitShares Decentralized Exchange (DEX), implementing optimized staggered order strategies for automated trading.

## 🚀 Features

- **Staggered Order Grid**: Creates geometric order grids around market price for efficient market making.
- **Dynamic Rebalancing**: Automatically adjusts orders after fills to maintain optimal spread.
- **Multi-Bot Support**: Run multiple bots simultaneously on different trading pairs with race-condition protection.
- **PM2 Process Management**: Automatic restart and monitoring for production use.
- **Master Password Security**: Encrypted key storage with RAM-only password handling.
- **Race Condition Prevention**: AsyncLock-based concurrency control for safe multi-bot operations and file persistence.

## 🔥 Quick Start

Get DEXBot2 running in 5 minutes:

```bash
# 1. Clone and install
git clone https://github.com/froooze/DEXBot2.git && cd DEXBot2 && npm install

# 2. Set up your master password, keys and add bots
node dexbot keys
node dexbot bots

# 3. Start with PM2 or directly
node pm2           # For production
node dexbot start  # For testing
```

For detailed setup, see [Installation](#-installation) or [Updating](#updating-dexbot2) sections below.

### ⚠️ Disclaimer — Use At Your Own Risk

- This software is in beta stage and provided "as‑is" without warranty.
- Secure your keys and secrets. Do not commit private keys or passwords to anyone.
- The authors and maintainers are not responsible for losses.

## 📥 Installation

### Prerequisites

You'll need **Git** and **Node.js** installed on your system.

#### Windows Users

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/) (accept defaults, restart after)
2. Install **Git** from [git-scm.com](https://git-scm.com/) (accept defaults, restart after)
3. Verify installation in Command Prompt:
   ```bash
   node --version && npm --version && git --version
   ```
   All three should display version numbers.

#### macOS Users

Use Homebrew to install Node.js and Git:
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and Git
brew install node git
```

#### Linux Users

Use your package manager:
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install nodejs npm git

# Fedora/RHEL
sudo dnf install nodejs npm git
```

### Clone and Setup DEXBot2

```bash
# Clone the repository and switch to folder
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2

# Install dependencies
npm install

# Set up your master password and keyring
node dexbot keys

# Create and configure your bots
node dexbot bots
```

### Updating DEXBot2

To update DEXBot2 to the latest version from the main branch:

```bash
# Run the update script from project root
bash scripts/update.sh
```

The update script automatically:
- Fetches and pulls the latest code from GitHub
- Installs any new dependencies
- Reloads PM2 processes if running
- Ensures your `profiles/` directory is protected and unchanged
- Logs all operations to `update.log`

## 🔧 Configuration

### 🤖 Bot Options

Below is a reference guide for each configuration option from `node dexbot bots` stored in `profiles/bots.json`.

#### 1. Trading Pair
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`assetA`** | string | Base asset |
| **`assetB`** | string | Quote asset |

#### 2. Identity & Status
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`name`** | string | Friendly name for logging and CLI selection. |
| **`active`** | boolean | Set to `false` to keep the config without running it. |
| **`dryRun`** | boolean | If `true`, simulates orders without broadcasting to the blockchain. |
| **`preferredAccount`** | string | The BitShares account name to use for trading. |

#### 3. Price Range
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`startPrice`** | num \| str | Default start price from liquidiy pool (`"pool"`), `"market"` (order book) or a number `A/B` is also possible. |
| **`minPrice`** | number \| string | Lower bound. Use a number (e.g., `0.5`) or multiplier (e.g., `"2x"` = `startPrice / 2`). |
| **`maxPrice`** | number \| string | Upper bound. Use a number (e.g., `1.5`) or multiplier (e.g., `"2x"` = `startPrice * 2`). |

#### 4. Grid Strategy
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`incrementPercent`** | number | Geometric step between layers (e.g., `0.5` for 0.5% increments). |
| **`targetSpreadPercent`** | number | Buffer zone around the center price where no orders are placed. |
| **`weightDistribution`**| object | Sizing logic: `{ "sell": 1.0, "buy": 1.0 }`. Range: `-1` to `2`. <br>• `-1`: **Super Valley** (heavy edge) <br>• `0.5`: **Neutral** <br>• `2`: **Super Mountain** (heavy center) |

#### 5. Funding & Scaling
| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`botFunds`** | object | Capital allocation: `{ "sell": "100%", "buy": 1000 }`. Supports numbers or percentage strings (e.g., `"50%"`). |
| **`activeOrders`** | object | Maximum concurrent orders per side: `{ "sell": 5, "buy": 5 }`. |

### ⚙️ General Options (Global)

DEXBot2 now supports global parameter management via the interactive editor (`dexbot bots`). These settings are stored in `profiles/general.settings.json` and persist across repository updates.

**Available Global Parameters:**
- **Grid Cache Regeneration %**: Threshold for resizing the grid when proceeds accumulate (Default: `3%`).
- **RMS Divergence Threshold %**: Maximum allowed deviation between in-memory and persisted grid state (Default: `14.3%`).
- **Partial Dust Threshold %**: Threshold for identifying small "dust" orders for geometric refilling (Default: `5%`).
- **Blockchain Fetch Interval**: Frequency of full account balance refreshes (Default: `240 min`).
- **Sync Delay**: Polling delay for blockchain synchronization (Default: `500ms`).
- **Log Level**: Global verbosity control (`debug`, `info`, `warn`, `error`).

## 🎯 PM2 Process Management (Recommended for Production)

For production use with automatic restart and process monitoring, use PM2:

### Starting Bots via PM2

Use `node pm2.js` to start bots with PM2 process management. This unified launcher handles everything automatically:
1. **BitShares Connection**: Waits for network connection
2. **PM2 Check**: Detects local and global PM2; prompts to install if missing
3. **Config Generation**: Creates `profiles/ecosystem.config.js` from `profiles/bots.json`
4. **Authentication**: Prompts for master password (kept in RAM only, never saved to disk)
5. **Startup**: Starts all active bots as PM2-managed processes with auto-restart

```bash
# Start all active bots with PM2
node pm2

# Or via CLI
node dexbot pm2

# Start a specific bot via PM2
node pm2 <bot-name>
```

### Managing PM2 Processes

After startup via `node pm2.js`, use these commands to manage and monitor every pm2 process:

```bash
# View status and resource usage
pm2 status

# View real-time logs
pm2 logs [<bot-name>]

# Restart processes
pm2 restart {all|<bot-name>}

# Stop processes
pm2 stop {all|<bot-name>}

# Delete processes
pm2 delete {all|<bot-name>}
```

### Managing Bot Processes via pm2.js

Use `node pm2.js` wrapper commands to select only dexbot processes:

```bash
# Stop only dexbot processes
node pm2 stop {all|<bot-name>}

# Delete only dexbot processes
node pm2 delete {all|<bot-name>}

# Show pm2.js usage information
node pm2.js help
```

### Grid Management & Bot Config

```bash
# Reset Grid by using  (Regenerate orders)
node dexbot reset {all|[<bot-name>]}

# Disable a bot in config (marks as inactive)
node dexbot disable {all|[<bot-name>]}
```

### Configuration & Logs

Bot configurations are defined in `profiles/bots.json`. The PM2 launcher automatically:
- Filters only bots with `active !== false`
- Generates ecosystem config with proper paths and logging
- Logs bot output to `profiles/logs/<bot-name>.log`
- Logs bot errors to `profiles/logs/<bot-name>-error.log`
- Applies restart policies (max 13 restarts, 1 day min uptime, 3 second restart delay)

### Security

- Master password is prompted interactively in your terminal
- Password passed via environment variable to bot processes (RAM only)
- Never written to disk or config files
- Cleared when process exits

## 🔍 Advanced Features

### ⚛️ Atomic Updates & Partial Order State Management
DEXBot2 handles filled orders and partial fills with atomic transactions across all operations:
- **Partial Fills**: Remaining portion tracked in `PARTIAL` state instead of cancellation
- **Atomic Moves**: Partial orders moved to new price levels in single transaction
- **Fill Detection**: Automatically detects filled orders via blockchain history or open orders snapshot
- **State Synchronization**: Grid state immediately reflects filled orders, proceeds credited to available funds
- **Batch Execution**: All updates submitted as **single atomic operation** (creates + updates + cancellations)
- **Consistency Guarantee**: Either all operations succeed or all fail - no partial blockchain states
- **No Manual Intervention**: Fully automatic fill processing, state updates, and rebalancing

This comprehensive fill handling ensures capital efficiency, eliminates orphaned orders and stuck funds, and guarantees consistency across all order state changes.

### 🔢 Price Tolerance & Integer Rounding
The bot calculates price tolerances to account for blockchain integer rounding discrepancies. This ensures reliable matching of on-chain orders with grid orders despite minor precision differences.

### ⏱️ Fill Deduplication
Fills are tracked with a 5-second deduplication window to prevent duplicate order processing. This ensures reliable fill detection even if the same fill event arrives multiple times.

### 💾 Persistent Grid & Price Caching
DEXBot intelligently caches grid calculations and order prices to avoid unnecessary recalculation:
- **Grid state persists** in `profiles/orders/<bot-key>.json` across bot restarts
- **Order prices preserved** from the last successful synchronization
- **No recalculation on startup** if grid matches on-chain state
- **Automatic resync only when** on-chain state differs (fills, cancellations)

This optimization significantly reduces startup time and blockchain queries, especially for bots running 20+ orders.

### ✈️ Offline Filled Order Detection
The bot automatically detects orders that were filled while offline:
- **Compares persisted grid** with current on-chain open orders on startup
- **Identifies missing orders** (orders from grid that are no longer on-chain)
- **Marks them as FILLED** and credits proceeds to available funds
- **Immediate rebalancing** - replaces filled orders on next cycle
- **No manual intervention needed** - fully automatic synchronization

This ensures seamless resumption after being offline without missing fill proceeds.

### 📡 Periodic Blockchain Fetch
DEXBot can automatically refresh your blockchain account balances at regular intervals to keep order values up-to-date:
- **Default interval**: 240 minutes (4 hours)
- **Configurable**: Set `BLOCKCHAIN_FETCH_INTERVAL_MIN` via `dexbot bots` menu (option 2: "Timing (Core)") or in `profiles/general.settings.json`
- **Automatic**: Runs in background without interrupting trading
- **Disable**: Set interval to `0` or an invalid value to disable periodic fetches

This ensures your bot's internal account balance tracking stays synchronized with the blockchain, especially useful for accounts that receive external transfers or participate in other trading activities.

**Configuration Options** (via `dexbot bots` → Timing (Core)):
- `SYNC_DELAY_MS`: Delay between blockchain operations (default: 500ms)
- `ACCOUNT_TOTALS_TIMEOUT_MS`: Timeout for account balance fetch (default: 10000ms)
- `BLOCKCHAIN_FETCH_INTERVAL_MIN`: Periodic blockchain fetch interval (default: 240 min = 4 hours)
- `LOCK_TIMEOUT_MS`: Order lock auto-expiry timeout (default: 10000ms)

Or configure directly in `profiles/general.settings.json`:
```json
{
  "TIMING": {
    "BLOCKCHAIN_FETCH_INTERVAL_MIN": 240,
    "LOCK_TIMEOUT_MS": 10000
  }
}
```

### ⚡ Automatic Grid Recalculation via Threshold Detection
DEXBot automatically regenerates grid order sizes when market conditions or cached proceeds exceed configurable thresholds. This ensures orders remain optimally sized without manual intervention:

**Two Independent Triggering Mechanisms:**

1. **Cache & Available Funds Threshold** (3% by default)
   - Monitors cached funds (proceeds from fills) + newly available funds (deposits)
   - Triggers when `(cacheFunds + availableFunds) ≥ 3%` of allocated grid capital on either side
   - Example: Grid 1000 BTS + new deposit 200 BTS available → ratio 20% → triggers update
   - Enables **automatic fund cycling**: new deposits are immediately resized into grid
   - Updates buy and sell sides independently based on their respective ratios

2. **Grid Divergence Threshold** (14.3% RMS by default)
   - Compares currently calculated grid with persisted grid state
   - **What is the RMS Threshold?** RMS (Root Mean Square) measures grid divergence as the quadratic mean of relative order size errors—this penalizes uneven distributions. For the same 3.2% average error, uneven distributions require higher RMS thresholds.
     ```
     Mean Squared Diff = Σ((calculated - persisted) / persisted)² / count
     RMS = √(Mean Squared Diff)  [Root Mean Square - quadratic mean of relative errors]
     Triggers update when: RMS > (RMS_PERCENTAGE / 100)
     ```

   **RMS Threshold Reference Table:**
   RMS increases as grid distribution worsens (more uneven/concentrated errors). Uneven distributions need higher thresholds to allow the same average error.
   | Avg Error | 100% Distribution | 50% Distribution | 25% Distribution | 5% Distribution |
   |-----------|-------------------|------------------|------------------|------------------|
   | 1.0% | 1.0% | 1.4% | 2.0% | 4.5% |
   | 2.2% | 2.2% | 3.1% | 4.4% | 9.8% |
   | 3.2% | 3.2% | 4.5% | 6.4% | 14.3% |
   | 4.5% | 4.5% | 6.4% | 9.0% | 20.1% |
   | 7.1% | 7.1% | 10.0% | 14.2% | 31.7% |
   | 10% | 10% | 14.1% | 20% | 44.7% |

   **Default: 14.3% RMS** - Allows ~3.2% average error when concentrated in just 5% of orders (most realistic scenario).

**When Grid Recalculation Occurs:**
- After order fills and proceeds are collected
- On startup if cached state diverges from current market conditions
- Automatically without user action when either threshold is breached
- Buy and sell sides can update independently

**Benefits:**
- Keeps order sizing optimal as market volatility or proceeds accumulate
- Avoids manual recalculation requests for most scenarios
- Reduces grid staleness while minimizing unnecessary regenerations
- Maintains capital efficiency by redistributing proceeds back into orders

**Customization:**
You can adjust thresholds via `dexbot bots` menu (option 1: "Grid Limits") or in `profiles/general.settings.json`:
```json
{
  "GRID_LIMITS": {
    "GRID_REGENERATION_PERCENTAGE": 3,
    "PARTIAL_DUST_THRESHOLD_PERCENTAGE": 5,
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 14.3
    }
  }
}
```
Or edit `modules/constants.js` directly for code-level changes.

### 📌 Trigger-File Grid Regeneration
Create a trigger file `profiles/recalculate.<bot-key>.trigger` to request immediate grid regeneration on the next polling cycle. This allows external scripts to request recalculation without restarting the bot.

Example:
```bash
touch profiles/recalculate.my-bot.trigger
```

### 🧮 Standalone Grid Calculator
Use the standalone calculator to dry-run grid calculations without blockchain interaction:

```bash
# Calculate grid 5 times with 1-second delays
CALC_CYCLES=5 CALC_DELAY_MS=1000 BOT_NAME=my-bot node -e "require('./modules/order/runner').runOrderManagerCalculation()"
```

Environment variables:
- `BOT_NAME` or `LIVE_BOT_NAME` - Select bot from `profiles/bots.json`
- `CALC_CYCLES` - Number of calculation passes (default: 1)
- `CALC_DELAY_MS` - Delay between cycles in milliseconds (default: 0)

## 📚 Technical Details

For users interested in understanding the math and mechanics behind DEXBot's order generation and grid algorithms:

### 🛠️ How It Works

1. **Grid Creation**: Generates buy/sell orders in geometric progression.
2. **Order Sizing**: Applies weight distribution for optimal capital allocation.
3. **Activation**: Converts virtual orders to active state.
4. **Rebalancing**: Creates new orders from filled positions.
5. **Spread Control**: Adds extra orders if the spread becomes too wide.

### 📐 Order Calculation

The order sizing follows a geometric progression formula:

```
size = (1 - c)^(x * n)
```

Where:
- `c` = increment percentage (price step between orders)
- `x` = order position/layer index (0 is closest to market price)
- `n` = weight distribution exponent (controls how order sizes scale across grid)

Weight distribution examples (set via `weightDistribution` config):
- `-1` = Super Valley (aggressive concentration at grid edges)
- `0` = Valley (order sizes increase linearly toward edges)
- `0.5` = Neutral (balanced, moderate distribution)
- `1` = Mountain (order sizes increase linearly toward center)
- `2` = Super Mountain (aggressive concentration at grid center)

### Output Example

```
===== ORDER GRID (SAMPLE) =====
Market: IOB.XRP/BTS @ 1831.0833206976029
Price            Type            State           Size
-----------------------------------------------
3660.2208        sell            virtual         0.11175292
3645.6382        sell            virtual         0.11220173
3631.1137        sell            virtual         0.11265234

1864.2743        sell            virtual         0.22000406
1856.8469        sell            virtual         0.22088761
1849.4491        sell            virtual         0.22177471
1842.0808        spread          virtual         0.00000000
1834.7418        spread          virtual         0.00000000
1827.4175        spread          virtual         0.00000000
1812.8274        buy             virtual         422.06696353
1805.5761        buy             virtual         420.37869568
1798.3538        buy             virtual         418.69718090

924.5392         buy             virtual         215.25349670
920.8410         buy             virtual         214.39248272
917.1576         buy             virtual         213.53491279
===============================================
```

## 📦 Modules

Below is a short summary of the modules in this repository and what they provide. You can paste these lines elsewhere if you need a quick reference.

### 📍 Entry Points

- `dexbot.js`: Main CLI entry point. Handles single-bot mode (start, stop, reset, drystart) and management commands (keys, bots, --cli-examples). Includes full DEXBot2 class with grid management, fill processing, and account operations.
- `pm2.js`: Unified PM2 launcher. Orchestrates BitShares connection, PM2 check/install, ecosystem config generation from `profiles/bots.json`, master password authentication, and bot startup with automatic restart policies.
- `bot.js`: PM2-friendly per-bot entry point. Loads bot config by name from `profiles/bots.json`, authenticates via master password (from environment or interactive prompt), initializes DEXBot instance, and runs the trading loop.

### 🧩 Core Modules

- `modules/account_bots.js`: Interactive editor for bot configurations (`profiles/bots.json`). Prompts accept numbers, percentages and multiplier strings (e.g. `5x`).
- `modules/chain_keys.js`: Encrypted master-password storage for private keys (`profiles/keys.json`), plus key authentication and management utilities.
- `modules/chain_orders.js`: Account-level order operations: select account, create/update/cancel orders, listen for fills with deduplication, read open orders. Uses 'history' mode for fill processing which matches orders from blockchain events. Protected with AsyncLock for subscription management and account state.
- `modules/bitshares_client.js`: Shared BitShares client wrapper and connection utilities (`BitShares`, `createAccountClient`, `waitForConnected`).
- `modules/btsdex_event_patch.js`: Runtime patch for `btsdex` library to improve history and account event handling.
- `modules/account_orders.js`: Local persistence for per-bot order-grid snapshots, metadata, and cacheFunds (`profiles/orders/<bot-key>.json`). Manages bot-specific files with AsyncLock-protected atomic updates, reload-before-write TOCTOU prevention, and optional forceReload for fresh disk reads.
- `modules/dexbot_class.js`: Core `DEXBot2` class — handles bot initialization, account setup, order placement, fill processing, grid rebalancing, and divergence detection. Fill processing protected by AsyncLock to safely handle concurrent fills. Shared implementation used by both `bot.js` (single-bot) and `dexbot.js` (multi-bot orchestration).

### 📊 Order Subsystem (`modules/order/`)

Core order generation, management, and grid algorithms:

- `modules/constants.js`: Centralized configuration hub with order constants (types: `SELL`, `BUY`, `SPREAD`; states: `VIRTUAL`, `ACTIVE`, `PARTIAL`), timing constants, grid limits, precision defaults, fee parameters, API limits, fill processing config, maintenance settings, and `DEFAULT_CONFIG`. Loads user overrides from `profiles/general.settings.json`.
- `modules/order/index.js`: Public entry point: exports `OrderManager` and `runOrderManagerCalculation()` (dry-run helper).
- `modules/order/logger.js`: Colored console logger and `logOrderGrid()` helper for formatted output.
- `modules/order/async_lock.js`: Queue-based AsyncLock utility for race condition prevention. Provides FIFO mutual exclusion for protecting critical sections across the codebase. Used by all modules that require atomic operations.
- `modules/order/manager.js`: `OrderManager` class — Core coordinator and state machine. Maintains virtual order grid state (Map + indices), manages fund tracking, and delegates specialized operations to three engines. Persistence methods are async with AsyncLock protection. Lock system prevents concurrent modifications during async operations.
- `modules/order/accounting.js`: `Accountant` engine — Fund tracking, available balance calculation, fee deduction, and committed fund management. Handles deductions/refunds as orders transition between states.
- `modules/order/strategy.js`: `StrategyEngine` — Grid rebalancing, order activation, partial order consolidation, rotation, and spread order management. Coordinates order state transitions and size adjustments.
- `modules/order/sync_engine.js`: `SyncEngine` — Blockchain synchronization and reconciliation. Detects filled orders, processes history events, fetches account balances, and keeps grid state in sync with chain.
- `modules/order/grid.js`: Grid generation algorithms, order sizing, weight distribution, and minimum size validation. Persistence operations are async with proper await handling.
- `modules/order/runner.js`: Standalone calculator runner for multi-pass grid calculations and dry-runs without blockchain interaction. Useful for testing grid logic and debugging price/size calculations. Runs via environment variables `BOT_NAME`, `CALC_CYCLES`, `CALC_DELAY_MS`.
- `modules/order/utils.js`: Utility functions (percent parsing, multiplier parsing, blockchain float/int conversion, market price helpers). Includes grid utility functions (filter, sum, precision handling, fee calculation), price correction utilities, and fill deduplication.
- `modules/order/startup_reconcile.js`: Startup grid reconciliation and synchronization. Compares persisted grid state with on-chain open orders to detect offline fills, process pending state changes, and decide recovery strategy (reload vs. continue). Ensures grid state matches blockchain reality on startup before trading resumes.

## 🔐 Environment Variables

Control bot behavior via environment variables (useful for advanced setups):

- `MASTER_PASSWORD` - Master password for key decryption (set by `pm2.js`, used by `bot.js` and `dexbot.js`)
- `BOT_NAME` or `LIVE_BOT_NAME` - Select a specific bot from `profiles/bots.json` by name (for single-bot runs)
- `PREFERRED_ACCOUNT` - Override the preferred account for the selected bot
- `RUN_LOOP_MS` - Polling interval in milliseconds (default: 5000). Controls how often the bot checks for fills and market conditions
- `CALC_CYCLES` - Number of calculation passes for standalone grid calculator (default: 1)
- `CALC_DELAY_MS` - Delay between calculator cycles in milliseconds (default: 0)

Example - Run a specific bot with custom polling interval:
```bash
BOT_NAME=my-bot RUN_LOOP_MS=3000 node dexbot.js
```

## 🤝 Contributing

1. Fork the repository and create a feature branch
2. Make your changes and test with `npm test`
3. For Jest tests: `./scripts/dev-install.sh` then `npm run test:unit`
4. Submit a pull request

**Development Setup:** `npm install` then optionally `./scripts/dev-install.sh` for Jest testing framework

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)

