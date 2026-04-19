# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Requires Node 20+ via nvm
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20

npm run dev        # Run with tsx (hot-reload friendly)
npm run typecheck  # TypeScript type check (no emit)
npm run build      # Compile to dist/
npm start          # Run compiled output
```

## Architecture

This is a **smart money wallet tracker** for crypto (ETH + Solana). It automates the manual workflow: CoinGecko → DEX Screener → wallet analysis → Telegram alerts.

### Data Flow

```
CoinGecko (top 30d gainers with DEX volume)
  → DEX Screener top traders per token pair
  → Etherscan/Solscan tx history → P&L scoring
  → SQLite watchlist (qualified wallets)
  → Poll for new swaps every N seconds
  → Detect new positions (token not in baseline snapshot)
  → Telegram alert
```

### Module Map

| Path | Purpose |
|------|---------|
| `src/config/config.ts` | Load + Zod-validate `config.yaml` |
| `src/db/schema.ts` | SQLite init via `better-sqlite3` (WAL mode) |
| `src/db/queries.ts` | Typed query helpers for wallets/snapshots/trades |
| `src/discovery/coinGecko.ts` | Top 30d gainers from CoinGecko API |
| `src/discovery/dexScreener.ts` | Top traders per token from DEX Screener |
| `src/discovery/discoveryRunner.ts` | Orchestrates full discovery pipeline |
| `src/analysis/ethAnalyzer.ts` | Etherscan ERC-20 tx fetch → swap reconstruction → P&L |
| `src/analysis/solAnalyzer.ts` | Solscan DeFi activity fetch → P&L |
| `src/analysis/scorer.ts` | Apply config thresholds → qualify wallet |
| `src/portfolio/ethPortfolio.ts` | Baseline ERC-20 holdings snapshot via Etherscan |
| `src/portfolio/solPortfolio.ts` | Baseline SPL token holdings snapshot via Solscan |
| `src/monitor/ethMonitor.ts` | Poll Etherscan for new swaps on watched ETH wallets |
| `src/monitor/solMonitor.ts` | Poll Solscan for new swaps on watched SOL wallets |
| `src/monitor/newPositionDetector.ts` | Diff swap token vs portfolio snapshot |
| `src/alerts/telegram.ts` | Two alert templates: new position (🚨) vs regular swap (🔔) |
| `src/index.ts` | Entry point: init DB → discovery cron → monitor interval |

### Key Design Decisions

- **New position detection**: at qualification time, all current wallet holdings are snapshotted. Any future swap into a token not in that snapshot triggers a high-priority alert — this is the core "early signal" feature.
- **Deduplication**: `trades` table uses `tx_hash` as primary key with `INSERT OR IGNORE`; `alerted` flag prevents double-sending.
- **Rate limiting**: Etherscan free tier = 5 req/s — a token-bucket (220ms min gap) is applied in `ethAnalyzer.ts` and `ethMonitor.ts`. Solscan uses 300ms gap.
- **Scoring**: configurable via `config.yaml` — `min_win_rate`, `min_pnl_usd`, `min_trade_count`, `min_pnl_multiplier`, `lookback_days`.
- **Portfolio note**: EVM portfolio uses Etherscan `tokenlist` endpoint. `// TODO: replace with DeBank Pro API` is marked in `ethPortfolio.ts` for when the project is profitable.

### Database (SQLite — `data/tracker.db`)

Three tables: `wallets`, `portfolio_snapshots`, `trades`. Schema in `src/db/schema.ts`. All queries are in `src/db/queries.ts` — never write raw SQL outside that file.

### Configuration (`config.yaml`)

All API keys, scoring thresholds, and scheduling intervals live here. Never hardcode keys.
