---
name: margin-trading
description: Margin trading concepts and position management for BitShares MPAs.
---

# Margin Trading

Reference skill for margin position management on BitShares DEX.

Covers the trading concepts available through the claw bridge, the mechanics of MPA debt positions, the HONEST.Asset ecosystem properties that shape how positions behave, and the position management principles that govern capital deployment.

The practical control model is split into:

- structural settings that are usually kept fixed (`incrementPercent`, `targetSpreadPercent`, `coreOrders`)
- adaptive settings layered on top of AMA (`weightDistribution`, min/max range ratio, debt/collateral actions)

## Reference Files

- `references/honest-asset-list.md` — All 46 HONEST MPAs with on-chain IDs, precision, and categories
- `references/honest-assets.md` — HONEST ecosystem properties: fees, MCR, feed price mechanics
- `references/trading-concepts.md` — Short/long position lifecycles, collateral operations, claw bridge commands
- `references/position-management.md` — CR zones, capital efficiency, unified planner model, loss/profit principles
- Shared trend and signal tuning lives in `../trend-detection/SKILL.md`
