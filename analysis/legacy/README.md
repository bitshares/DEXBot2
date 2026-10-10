# Legacy — SMA / MACD / RSI Derivative Analyzer

**Reference only. Not wired to any runtime path.**

This is the archived classic-indicator signal layer. It was superseded by the live
Kalman / Hurst / Permutation-Entropy stack in `market_adapter/core/signals/`. Nothing
in `modules/` or `market_adapter/` imports it, and it is excluded from the published
npm package. It lives here so the indicator implementations and the entry-bias /
momentum-gate logic remain available for reference.

- `analyze_derivatives.ts` — CLI runner (SMA / MACD / RSI over candle data, HTML chart)
- `derivative_analyzer.ts` — the indicator + signal engine (SMA, fastSMA, MACD, RSI, entry bias, momentum gate)
- `derivative_chart_generator.ts` — interactive HTML chart generator
- `SIGNAL_DOCUMENTATION.md` — full signal/flag reference

## Running

Build first (the repo runs from `dist/`, not source):

```bash
npm run build
node dist/analysis/legacy/analyze_derivatives.js \
  --source json --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --sma 500 --fast-sma 100 \
  --macd-fast 48 --macd-slow 104 --macd-signal 36 \
  --rsi 96 --interp-confirm 3 --interp-hold 3 \
  --trend-filter
```

See `SIGNAL_DOCUMENTATION.md` for every flag and the derived signal layers.
