# Claude Development Context - DEXBot2

## Branch Strategy
**Pipeline: `test` → `dev` → `main`**

See `docs/WORKFLOW.md` for detailed workflow.

## Current Status
| Branch | Commit | Status |
|--------|--------|--------|
| test | 9145601 | Synced with origin/test |
| dev | 739e6d1 | Synced with origin/dev |

## Key Modules
- `dexbot.js` - Entry point
- `modules/dexbot_class.js` - Core bot class
- `modules/order/` - Order management (manager, strategy, grid, accounting, sync_engine, legacy-testing)
- `modules/chain_orders.js`, `account_orders.js`, `account_bots.js` - Chain interaction
- `modules/constants.js` - Configuration

## Quick Commands
```bash
# Create feature
git checkout test && git pull
git checkout -b feature/my-feature test

# Merge to test
git checkout test && git pull && git merge --no-ff feature/my-feature && git push

# Integrate to dev
git checkout dev && git pull && git merge --no-ff test && git push

# Release to main
git checkout main && git pull && git merge --no-ff dev && git push
```

## Key Files

### Entry Points
- `dexbot.js` - Main CLI entry point (executable)
- `bot.js` - Alternative bot starter
- `pm2.js` - PM2 process management

### Core Bot
- `modules/dexbot_class.js` - Core bot class and logic (1424 lines)
- `modules/constants.js` - Centralized configuration and tuning parameters

### Order Management (`modules/order/`)
- `manager.js` - Order lifecycle and state management (2852+ lines)
- `grid.js` - Grid calculation, placement, and management
- `strategy.js` - Trading strategy (anchor & refill, consolidation)
- `accounting.js` - Fee accounting and fund tracking
- `sync_engine.js` - Blockchain synchronization
- `startup_reconcile.js` - Startup order reconciliation
- `utils.js` - Utility functions (1254+ lines)
- `index.js` - Module exports
- `logger.js` - Order logging
- `runner.js` - Order execution runner
- `async_lock.js` - Concurrency control
- `legacy-testing.js` - Deprecated testing functions for backward compatibility

### Blockchain Interaction
- `modules/chain_orders.js` - Blockchain order operations (269+ lines)
- `modules/account_orders.js` - Account order queries (454+ lines)
- `modules/account_bots.js` - Account bot data management (314+ lines)

### Configuration & Examples
- `examples/bots.json` - Bot configuration examples
- `profiles/ecosystem.config.js` - PM2 ecosystem configuration
- `package.json` - Dependencies and npm scripts

### Testing
- `tests/unit/` - Unit tests (accounting, grid, manager, sync_engine)
- `tests/` - Integration and scenario tests

## Documentation
- `README.md` - Full documentation
- `docs/WORKFLOW.md` - Branch workflow
- `docs/TESTING_IMPROVEMENTS.md` - Testing guidelines
- `CHANGELOG.md` - Version history
