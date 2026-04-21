import axios from 'axios';
import { getConfig } from '../config/config';
import { insertDebugLog } from '../db/queries';
import logger from '../logger';

export interface WalletScore {
  address: string;
  chain: 'sol';
  win_rate: number;
  total_pnl: number;
  trade_count: number;
  last_active: number;
  best_multiplier: number;
}

// Solana stablecoin mint addresses
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
  'UXPhBoR3qG4UCiGNJfV7MqhHyFqKN68g45GoYvAeL2M',  // UXD
]);

// Wrapped SOL — most Solana traders use SOL as base currency
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

let _cachedSolPrice = 0;
let _solPriceFetchedAt = 0;

async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (_cachedSolPrice > 0 && now - _solPriceFetchedAt < 5 * 60 * 1000) return _cachedSolPrice;
  try {
    const resp = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: 'solana', vs_currencies: 'usd' },
      timeout: 5000,
    });
    _cachedSolPrice = (resp.data?.solana?.usd as number) ?? 150;
    _solPriceFetchedAt = now;
    return _cachedSolPrice;
  } catch {
    return _cachedSolPrice > 0 ? _cachedSolPrice : 150; // fallback
  }
}

interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  type: string;
  tokenTransfers: HeliusTokenTransfer[];
}

let _lastHeliusCall = 0;
async function heliusRateLimit(): Promise<void> {
  const wait = 300 - (Date.now() - _lastHeliusCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastHeliusCall = Date.now();
}

async function fetchSwaps(address: string, afterTimestamp: number): Promise<HeliusTx[]> {
  const cfg = getConfig();
  if (!cfg.helius.api_key) return [];

  const results: HeliusTx[] = [];
  let before: string | undefined;

  while (true) {
    await heliusRateLimit();
    try {
      const params: Record<string, string | number> = {
        'api-key': cfg.helius.api_key,
        type: 'SWAP',
        limit: 100,
      };
      if (before) params.before = before;

      const resp = await axios.get(
        `https://api.helius.xyz/v0/addresses/${address}/transactions`,
        { params, timeout: 15000 },
      );

      const txs: HeliusTx[] = Array.isArray(resp.data) ? resp.data : [];
      if (txs.length === 0) break;

      let hitBoundary = false;
      for (const tx of txs) {
        if (tx.timestamp < afterTimestamp) { hitBoundary = true; break; }
        results.push(tx);
      }

      if (hitBoundary || txs.length < 100) break;
      before = txs[txs.length - 1].signature;
    } catch (err) {
      logger.debug(`Helius swap fetch error for ${address}`, { err });
      break;
    }
  }

  return results;
}

function isBaseCurrency(mint: string): boolean {
  return STABLE_MINTS.has(mint) || mint === WSOL_MINT;
}

function computePnL(address: string, txs: HeliusTx[], solPriceUsd: number): {
  win_rate: number;
  total_pnl: number;
  best_multiplier: number;
  trade_count: number;
} {
  const positions = new Map<string, { costBasis: number; amount: number }>();
  let wins = 0;
  let losses = 0;
  let total_pnl = 0;
  let best_multiplier = 0;

  for (const tx of txs) {
    const transfers = tx.tokenTransfers ?? [];

    // Solana addresses are case-sensitive base58 — compare directly
    const sent = transfers.filter(t => t.fromUserAccount === address);
    const received = transfers.filter(t => t.toUserAccount === address);
    if (sent.length === 0 || received.length === 0) continue;

    // Find the base currency being spent (stablecoin or WSOL)
    const spentBase = sent.find(t => isBaseCurrency(t.mint));
    // Find the base currency being received (stablecoin or WSOL)
    const receivedBase = received.find(t => isBaseCurrency(t.mint));

    const toUsd = (mint: string, amount: number): number =>
      mint === WSOL_MINT ? amount * solPriceUsd : amount;

    if (spentBase) {
      const token = received.find(t => !isBaseCurrency(t.mint));
      if (!token) continue;
      const costUsd = toUsd(spentBase.mint, spentBase.tokenAmount);
      if (costUsd <= 0) continue;
      const existing = positions.get(token.mint) ?? { costBasis: 0, amount: 0 };
      positions.set(token.mint, {
        costBasis: existing.costBasis + costUsd,
        amount: existing.amount + token.tokenAmount,
      });
    } else if (receivedBase) {
      const token = sent.find(t => !isBaseCurrency(t.mint));
      if (!token) continue;
      const pos = positions.get(token.mint);
      if (pos && pos.costBasis > 0) {
        const proceedsUsd = toUsd(receivedBase.mint, receivedBase.tokenAmount);
        const pnl = proceedsUsd - pos.costBasis;
        const multiplier = proceedsUsd / pos.costBasis;
        total_pnl += pnl;
        if (multiplier > best_multiplier) best_multiplier = multiplier;
        if (pnl > 0) wins++; else losses++;
        positions.delete(token.mint);
      }
    }
  }

  const trade_count = wins + losses;
  return {
    win_rate: trade_count > 0 ? wins / trade_count : 0,
    total_pnl,
    best_multiplier,
    trade_count,
  };
}

export async function scoreSolWallet(address: string): Promise<WalletScore | null> {
  const cfg = getConfig();
  const lookbackTs = Math.floor(Date.now() / 1000) - cfg.scoring.lookback_days * 86400;

  // Try Helius first
  if (cfg.helius.api_key) {
    try {
      const txs = await fetchSwaps(address, lookbackTs);
      insertDebugLog('sol_helius_swaps', address, { count: txs.length, lookback_days: cfg.scoring.lookback_days });
      if (txs.length > 0) {
        const solPrice = await getSolPriceUsd();
        const { win_rate, total_pnl, best_multiplier, trade_count } = computePnL(address, txs, solPrice);
        insertDebugLog('sol_score_helius', address, { win_rate, total_pnl, trade_count, best_multiplier, sol_price: solPrice });
        return {
          address,
          chain: 'sol',
          win_rate,
          total_pnl,
          trade_count,
          last_active: txs[txs.length - 1]?.timestamp ?? 0,
          best_multiplier,
        };
      }
      logger.debug(`Helius returned no swaps for ${address} — trying Solscan fallback`);
    } catch (err) {
      logger.warn(`Helius scoring failed for ${address} — trying Solscan fallback`, { err });
    }
  }

  // Fallback: Solscan pro API
  if (cfg.solscan.api_key) {
    try {
      const activities = await fetchSolscanActivities(address, lookbackTs);
      if (activities.length === 0) return null;
      const { win_rate, total_pnl, best_multiplier } = computeSolscanPnL(activities);
      return {
        address,
        chain: 'sol',
        win_rate,
        total_pnl,
        trade_count: activities.length,
        last_active: activities[activities.length - 1]?.blockTime ?? 0,
        best_multiplier,
      };
    } catch (err) {
      logger.error(`SOL Solscan fallback error for ${address}`, { err });
    }
  }

  if (!cfg.helius.api_key && !cfg.solscan.api_key) {
    logger.debug('Neither Helius nor Solscan api_key set — skipping SOL wallet scoring');
  }
  return null;
}

// --- Solscan fallback ---

interface SolscanActivity {
  txHash: string;
  blockTime: number;
  amountInfo?: {
    token1Symbol?: string; token1Amount?: number;
    token2Symbol?: string; token2Amount?: number;
    token1?: string; token2?: string;
  };
}

const SOLSCAN_STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'USDH', 'UXD']);

let _lastSolscanCall = 0;
async function solscanRateLimit(): Promise<void> {
  const wait = 300 - (Date.now() - _lastSolscanCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastSolscanCall = Date.now();
}

async function fetchSolscanActivities(address: string, afterTime: number): Promise<SolscanActivity[]> {
  const cfg = getConfig();
  const headers: Record<string, string> = { accept: 'application/json', token: cfg.solscan.api_key };
  const results: SolscanActivity[] = [];
  let page = 1;

  while (true) {
    await solscanRateLimit();
    try {
      const resp = await axios.get('https://pro-api.solscan.io/v2.0/account/defi/activities', {
        headers,
        params: { address, activity_type: 'ACTIVITY_SPL_SWAP', page, page_size: 100, sort_by: 'block_time', sort_order: 'asc' },
        timeout: 15000,
      });
      const data: SolscanActivity[] = resp.data?.data ?? [];
      if (data.length === 0) break;
      const filtered = data.filter(a => a.blockTime >= afterTime);
      results.push(...filtered);
      if (filtered.length < data.length || data.length < 100) break;
      page++;
    } catch (err) {
      logger.debug(`Solscan activities error page ${page}`, { err });
      break;
    }
  }
  return results;
}

function computeSolscanPnL(activities: SolscanActivity[]): { win_rate: number; total_pnl: number; best_multiplier: number } {
  const positions = new Map<string, { costBasis: number; amount: number }>();
  let wins = 0; let losses = 0; let total_pnl = 0; let best_multiplier = 0;

  for (const activity of activities) {
    const info = activity.amountInfo;
    if (!info) continue;
    const sym1 = (info.token1Symbol ?? '').toUpperCase();
    const sym2 = (info.token2Symbol ?? '').toUpperCase();
    const amt1 = info.token1Amount ?? 0;
    const amt2 = info.token2Amount ?? 0;

    if (SOLSCAN_STABLE_SYMBOLS.has(sym1) && info.token2) {
      const ex = positions.get(info.token2) ?? { costBasis: 0, amount: 0 };
      positions.set(info.token2, { costBasis: ex.costBasis + amt1, amount: ex.amount + amt2 });
    } else if (SOLSCAN_STABLE_SYMBOLS.has(sym2) && info.token1) {
      const pos = positions.get(info.token1);
      if (pos && pos.costBasis > 0) {
        const pnl = amt2 - pos.costBasis;
        const mult = amt2 / pos.costBasis;
        total_pnl += pnl;
        if (mult > best_multiplier) best_multiplier = mult;
        if (pnl > 0) wins++; else losses++;
        positions.delete(info.token1);
      }
    }
  }

  const total = wins + losses;
  return { win_rate: total > 0 ? wins / total : 0, total_pnl, best_multiplier };
}
