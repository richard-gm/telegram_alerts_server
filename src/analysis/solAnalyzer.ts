import axios from 'axios';
import { getConfig } from '../config/config';
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

interface SolscanTokenAccount {
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: { uiAmount: number };
}

interface SolscanDefiActivity {
  txHash: string;
  blockTime: number;
  activityType: string;
  amountInfo?: {
    token1?: string;
    token1Symbol?: string;
    token1Amount?: number;
    token1Decimals?: number;
    token2?: string;
    token2Symbol?: string;
    token2Amount?: number;
    token2Decimals?: number;
  };
}

const SOLSCAN_BASE = 'https://pro-api.solscan.io/v2.0';
const SOLSCAN_PUBLIC_BASE = 'https://api.solscan.io';

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'USDH', 'UXD']);

let _lastSolscanCall = 0;
async function solscanRateLimit(): Promise<void> {
  const now = Date.now();
  const wait = 300 - (now - _lastSolscanCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastSolscanCall = Date.now();
}

async function fetchDefiActivities(address: string, afterTime: number): Promise<SolscanDefiActivity[]> {
  const cfg = getConfig();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.solscan.api_key) headers['token'] = cfg.solscan.api_key;

  const activities: SolscanDefiActivity[] = [];
  let page = 1;

  while (true) {
    await solscanRateLimit();
    try {
      // Use public API if no key, pro API if key provided
      const base = cfg.solscan.api_key ? SOLSCAN_BASE : SOLSCAN_PUBLIC_BASE;
      const resp = await axios.get(`${base}/account/defi/activities`, {
        headers,
        params: {
          address,
          activity_type: 'ACTIVITY_SPL_SWAP',
          page,
          page_size: 100,
          sort_by: 'block_time',
          sort_order: 'asc',
        },
        timeout: 15000,
      });

      const data: SolscanDefiActivity[] = resp.data?.data ?? resp.data?.result ?? [];
      if (data.length === 0) break;

      const filtered = data.filter(a => a.blockTime >= afterTime);
      activities.push(...filtered);

      if (filtered.length < data.length) break; // hit the time boundary
      if (data.length < 100) break;
      page++;
    } catch (err) {
      logger.debug(`Solscan defi activities error page ${page}`, { err });
      break;
    }
  }

  return activities;
}

function computePnL(activities: SolscanDefiActivity[]): {
  win_rate: number;
  total_pnl: number;
  best_multiplier: number;
} {
  const positions = new Map<string, { costBasis: number; amount: number }>();
  let wins = 0;
  let losses = 0;
  let total_pnl = 0;
  let best_multiplier = 0;

  for (const activity of activities) {
    const info = activity.amountInfo;
    if (!info) continue;

    const sym1 = (info.token1Symbol ?? '').toUpperCase();
    const sym2 = (info.token2Symbol ?? '').toUpperCase();
    const amt1 = info.token1Amount ?? 0;
    const amt2 = info.token2Amount ?? 0;

    const spendingStable = STABLE_SYMBOLS.has(sym1);
    const receivingStable = STABLE_SYMBOLS.has(sym2);

    if (spendingStable && info.token2) {
      // Buying token2 with stablecoins
      const existing = positions.get(info.token2) ?? { costBasis: 0, amount: 0 };
      positions.set(info.token2, {
        costBasis: existing.costBasis + amt1,
        amount: existing.amount + amt2,
      });
    } else if (receivingStable && info.token1) {
      // Selling token1 for stablecoins
      const pos = positions.get(info.token1);
      if (pos && pos.costBasis > 0) {
        const proceeds = amt2;
        const pnl = proceeds - pos.costBasis;
        const multiplier = proceeds / pos.costBasis;

        total_pnl += pnl;
        if (multiplier > best_multiplier) best_multiplier = multiplier;
        if (pnl > 0) wins++;
        else losses++;

        positions.delete(info.token1);
      }
    }
  }

  const total_trades = wins + losses;
  return {
    win_rate: total_trades > 0 ? wins / total_trades : 0,
    total_pnl,
    best_multiplier,
  };
}

export async function scoreSolWallet(address: string): Promise<WalletScore | null> {
  const cfg = getConfig();
  const lookbackTs = Math.floor(Date.now() / 1000) - cfg.scoring.lookback_days * 86400;

  try {
    const activities = await fetchDefiActivities(address, lookbackTs);
    if (activities.length === 0) return null;

    const { win_rate, total_pnl, best_multiplier } = computePnL(activities);
    const lastActive = activities[activities.length - 1]?.blockTime ?? 0;

    return {
      address,
      chain: 'sol',
      win_rate,
      total_pnl,
      trade_count: activities.length,
      last_active: lastActive,
      best_multiplier,
    };
  } catch (err) {
    logger.error(`SOL analyzer error for ${address}`, { err });
    return null;
  }
}
