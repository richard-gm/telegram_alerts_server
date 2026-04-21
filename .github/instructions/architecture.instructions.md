---
applyTo: "**"
---

# Architecture — Smart Wallet Tracker

## Overview

A crypto "smart money" tracker that automates: discover top-performing wallets → qualify them via P&L scoring → snapshot their holdings → monitor for new swaps → alert via Telegram. Supports Ethereum (ETH), Base (BASE), and Solana (SOL).

---

## Module Map

| Path | Purpose |
|------|---------|
| `src/config/config.ts` | Load + Zod-validate `config.yaml` |
| `src/db/schema.ts` | SQLite init via `better-sqlite3` (WAL mode) |
| `src/db/queries.ts` | All typed SQL helpers — never write raw SQL elsewhere |
| `src/discovery/coinGecko.ts` | Fetch top 7d/30d gainers per chain from CoinGecko markets API |
| `src/discovery/dexScreener.ts` | Fetch top-trading wallet addresses per token via on-chain tx history |
| `src/discovery/discoveryRunner.ts` | Orchestrates CoinGecko → dexScreener pipeline; deduplicates wallets |
| `src/analysis/ethAnalyzer.ts` | Etherscan v2 ERC-20 tx fetch → swap reconstruction → P&L (ETH + Base) |
| `src/analysis/solAnalyzer.ts` | Helius (primary) + Solscan (fallback) swap fetch → P&L (SOL) |
| `src/analysis/scorer.ts` | Apply config thresholds → qualify/disqualify wallet |
| `src/portfolio/ethPortfolio.ts` | Baseline ERC-20 holdings snapshot via Etherscan v2 (ETH + Base) |
| `src/portfolio/solPortfolio.ts` | Baseline SPL token holdings snapshot via Helius |
| `src/monitor/ethMonitor.ts` | Poll Etherscan v2 for new swaps on watched ETH/Base wallets |
| `src/monitor/newPositionDetector.ts` | Diff swap token against portfolio snapshot to detect new positions |
| `src/webhooks/heliusClient.ts` | Manage Helius webhook (create / sync addresses / lazy init) |
| `src/webhooks/heliusHandler.ts` | Process incoming Helius SWAP events for watched SOL wallets |
| `src/webhooks/server.ts` | Express HTTP server — serves Helius webhook endpoint + REST API + frontend |
| `src/api/routes.ts` | REST API: list wallets/trades, analyze wallet, approve/pause/remove |
| `src/alerts/telegram.ts` | Telegram bot: send trade alerts, approval requests, handle inline keyboard callbacks |
| `src/index.ts` | Entry point: init → discovery cron → monitors |

---

## Full Data Flow

### 1. Discovery Pipeline (cron: every N hours + weekly)

```
CoinGecko /coins/markets
  (ethereum-ecosystem, solana-ecosystem, base-ecosystem)
  → top N gainers per chain filtered by min DEX volume
  → [CoinGeckoToken] { contract_address, chain, symbol }

    ↓ for each token (skipped if processed within cacheTtl)

dexScreener.ts — getTopTradersForToken()
  ETH/Base: Etherscan v2 tokentx (chainid 1 / 8453)
            count wallet appearances in recent 300 txs
            exclude known DEX router addresses
  SOL:      Helius /addresses/{mint}/transactions?type=SWAP
            collect feePayer addresses
  → [TopTrader] { wallet, chain, source_token, ... }

    ↓ deduplicated across tokens

scorer.ts — scoreTrader()
  ETH/Base: ethAnalyzer.scoreEthWallet()
              Etherscan v2 tokentx for wallet (lookback_days)
              reconstruct swaps by grouping transfers per tx hash
              P&L: stablecoin in → token out = BUY cost basis
                   token in → stablecoin out = SELL proceeds → win/loss
  SOL:      solAnalyzer.scoreSolWallet()
              Helius /addresses/{addr}/transactions?type=SWAP (primary)
              Solscan /account/defi/activities (fallback)
              P&L: stable/WSOL in = BUY, stable/WSOL out = SELL
  → upsertWallet() with raw score regardless of qualification
  → check thresholds: min_win_rate, min_pnl_usd, min_trade_count, min_pnl_multiplier
  → PASS: sendWalletApprovalRequest() to Telegram with Approve/Skip buttons
  → FAIL: disqualifyWallet() (qualified = -1)
```

### 2. Wallet Approval (Telegram inline keyboard or REST API)

```
User taps ✅ Approve in Telegram
  → initBotCallbackHandler callback fires
  → qualifyWallet(address)         [qualified = 1 in DB]

  ETH / Base wallet:
    → snapshotEthPortfolio(address, chain)
        Etherscan v2 tokenlist (chainid 1 or 8453)
        → upsertSnapshot() for each token held
        → always includes native ETH sentinel address

  SOL wallet:
    → snapshotSolPortfolio(address)
        Helius /addresses/{addr}/balances
        → upsertSnapshot() for each SPL token held
    → addSolAddress(address)
        Helius webhook: lazy-create on first SOL wallet,
        then PUT to add address to existing webhook

  → sendWalletApprovedConfirmation() to Telegram
```

Same flow is available via `PATCH /api/wallets/:address { action: "approve" }`.

### 3. Monitoring — ETH & Base (polling)

```
startEthMonitor(intervalSeconds, chain)   [called for 'eth' AND 'base' at startup]

Every N seconds:
  getQualifiedWallets(chain)              [qualified = 1]
  for each wallet:
    if last_checked_block is null/0:
      fetchCurrentBlock() → store as anchor, skip history
    else:
      fetchTokenTxs(address, 0, lastBlock+1, chain)
        Etherscan v2 tokentx (chainid = 1 or 8453, same API key)
      groupSwaps() → pair out-transfers with in-transfers per tx hash
      for each swap:
        insertTrade()       [INSERT OR IGNORE on tx_hash]
        if trade.timestamp < MONITOR_START_TS - 300: markAlerted(), skip
        if action=BUY: isNewPosition() → check portfolio_snapshots
        sendTradeAlert() to Telegram
        if newPosition: recordNewPosition() → upsertSnapshot()
        markAlerted()
      updateLastCheckedBlock()
```

### 4. Monitoring — SOL (webhooks, push)

```
Helius → POST /webhook/helius   [verified via Authorization header]

heliusHandler:
  filter: type=SWAP, transactionError=null, ≥2 tokenTransfers
  for each transfer participant:
    if wallet.qualified !== 1: skip
    identify OUT (fromUserAccount) and IN (toUserAccount) transfers
    detect action: buy (spending stable/WSOL) or sell
    insertTrade()
    if newPosition: recordNewPosition()
    sendTradeAlert() to Telegram
    markAlerted()
```

### 5. Trade Alert (Telegram)

Two alert variants based on `isNewPosition`:

- **🚨 NEW POSITION** — token not in wallet's snapshot at approval time (early signal)
- **🔔 Regular swap** — known token, monitoring an existing position

Explorer links per chain:
- ETH → `etherscan.io`
- Base → `basescan.org`
- SOL → `solscan.io`

---

## Database Schema

Three core tables + two supporting tables (`better-sqlite3`, WAL mode):

```
wallets               — discovered/approved wallets
  address             PK TEXT
  chain               TEXT ('eth' | 'sol' | 'base')
  win_rate, total_pnl, trade_count, last_active
  qualified           INTEGER  0=pending, 1=active, -1=disqualified, 2=paused
  last_checked_block  TEXT     (EVM only — block cursor for polling)
  source_token        TEXT     token that led to this wallet's discovery

portfolio_snapshots   — token holdings at approval time (new-position baseline)
  UNIQUE(wallet, chain, token_address)

trades                — every detected swap
  tx_hash             PK TEXT  (INSERT OR IGNORE = deduplication)
  alerted             INTEGER  prevents double-sending

processed_tokens      — discovery cache
  PRIMARY KEY (token_address, chain, time_window)
  prevents re-querying the same token within cacheTtl

debug_logs            — structured event log for tracing
```

---

## Chain Support

| Chain | Chain ID | Discovery | Analysis | Portfolio | Monitor |
|-------|----------|-----------|----------|-----------|---------|
| ETH | 1 | Etherscan v2 tokentx | Etherscan v2 | Etherscan v2 tokenlist | Poll (Etherscan v2) |
| Base | 8453 | Etherscan v2 tokentx | Etherscan v2 | Etherscan v2 tokenlist | Poll (Etherscan v2) |
| SOL | — | Helius SWAP txs | Helius + Solscan fallback | Helius balances | Push (Helius webhook) |

ETH and Base share a single Etherscan API key (Etherscan API V2 supports 60+ chains with one key). Chain routing is done via `chainid` param (`EVM_CHAIN_ID` map in `ethAnalyzer.ts`).

---

## Key Design Decisions

- **New position detection**: at qualification time all current wallet holdings are snapshotted. Any future swap into a token absent from that snapshot triggers a 🚨 high-priority alert — this is the core "early signal" feature.
- **Deduplication**: `tx_hash` is the primary key in `trades` with `INSERT OR IGNORE`. `alerted` flag prevents double-sending if the process restarts.
- **Historical trade suppression**: `MONITOR_START_TS[chain]` is set at startup. Trades older than 5 minutes before startup are marked alerted without sending, preventing Telegram floods on first run.
- **EVM polling vs SOL webhooks**: ETH/Base use a pull model (poll every N seconds) because Etherscan provides reliable block-indexed history. SOL uses Helius push webhooks because Solana tx throughput makes polling impractical.
- **Rate limiting**: Etherscan free tier = 5 req/s → token-bucket at 220 ms min gap in `ethAnalyzer.ts` (shared rate limiter). Helius/Solscan use 300 ms gap.
- **SOL scoring dual-path**: Helius is tried first (richer data). Falls back to Solscan Pro if Helius returns nothing or fails.
- **Helius webhook lazy init**: webhook is not created until the first SOL wallet is approved — avoids creating a webhook that points nowhere.
- **Config persistence**: `patchConfig()` writes back to `config.yaml` so Helius webhook IDs survive restarts without manual edits.

---

## Known Gaps / TODOs

1. **DEX Screener not actually used**: Despite the module name, `dexScreener.ts` discovers wallets by scraping on-chain token transfer events (Etherscan/Helius), NOT DEX Screener's `/dex/tokens/{address}/top-traders` endpoint. That endpoint would give pre-ranked traders with real P&L — eliminating the need for the tx-counting heuristic.

2. **Base chain: API routes don't handle Base**: `POST /api/wallets/analyze` detects chain via `address.startsWith('0x')` and routes to `'eth'` only — Base addresses also start with `0x` so they'll be scored as ETH (chainid 1, wrong). Needs a `chain` field in the request body.

3. **Base chain: approval flow in API routes**: `PATCH /api/wallets/:address { action: "approve" }` calls `snapshotEthPortfolio(address)` without passing the chain, defaulting to ETH. Base wallets approved via the REST API will snapshot against the wrong chain ID.

4. **SOL portfolio snapshot**: `solPortfolio.ts` uses Helius `/addresses/{addr}/balances` — if Helius key is missing, no snapshot is taken and new-position detection will fire false positives on every trade.

5. **P&L in USD for EVM**: `ethAnalyzer.ts` only counts P&L when one side is a stablecoin (USDT/USDC/DAI etc.). Trades settled in ETH or WETH are ignored — this undercounts activity for wallets that trade token→ETH→token.

6. **No SOL monitor polling fallback**: If the Helius webhook misses a transaction (network gap, webhook outage), there is no catch-up mechanism for SOL wallets. ETH/Base are safe because polling uses block cursors.