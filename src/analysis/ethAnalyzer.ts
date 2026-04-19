import axios from 'axios';
import { getConfig } from '../config/config';
import logger from '../logger';

export interface WalletScore {
  address: string;
  chain: 'eth';
  win_rate: number;
  total_pnl: number;
  trade_count: number;
  last_active: number;
  best_multiplier: number;
}

interface EtherscanTokenTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  contractAddress: string;
  tokenSymbol: string;
  tokenDecimal: string;
  value: string;
  tokenName: string;
}

interface Swap {
  hash: string;
  timestamp: number;
  tokenIn: string;
  tokenInSymbol: string;
  tokenOut: string;
  tokenOutSymbol: string;
  amountIn: number;
  amountOut: number;
}

// Known DEX router addresses (Uniswap v2/v3, SushiSwap, 1inch, etc.)
const DEX_ROUTERS = new Set([
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap v2
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap v3
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap v3 router2
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap
  '0x1111111254fb6c44bac0bed2854e76f90643097d', // 1inch v4
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch v5
]);

const ETHERSCAN_BASE = 'https://api.etherscan.io/api';
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP']);

// Simple token-bucket for Etherscan's 5 req/s free tier
let _lastEtherscanCall = 0;
async function etherscanRateLimit(): Promise<void> {
  const now = Date.now();
  const wait = 220 - (now - _lastEtherscanCall); // ~4.5 req/s to be safe
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastEtherscanCall = Date.now();
}

async function fetchTokenTxs(address: string, startTimestamp: number): Promise<EtherscanTokenTx[]> {
  const cfg = getConfig();
  await etherscanRateLimit();

  const resp = await axios.get(ETHERSCAN_BASE, {
    params: {
      module: 'account',
      action: 'tokentx',
      address,
      startblock: 0,
      endblock: 99999999,
      sort: 'asc',
      apikey: cfg.etherscan.api_key || 'YourApiKeyToken',
    },
    timeout: 15000,
  });

  if (resp.data.status !== '1') return [];

  const txs: EtherscanTokenTx[] = resp.data.result ?? [];
  return txs.filter(tx => parseInt(tx.timeStamp) >= startTimestamp);
}

function reconstructSwaps(address: string, txs: EtherscanTokenTx[]): Swap[] {
  const addr = address.toLowerCase();
  const byHash = new Map<string, EtherscanTokenTx[]>();

  for (const tx of txs) {
    const list = byHash.get(tx.hash) ?? [];
    list.push(tx);
    byHash.set(tx.hash, list);
  }

  const swaps: Swap[] = [];

  for (const [hash, transfers] of byHash.entries()) {
    // Tokens going OUT of the wallet = tokenIn (we sold/spent)
    const outTransfers = transfers.filter(t => t.from.toLowerCase() === addr);
    // Tokens coming INTO the wallet = tokenOut (we received)
    const inTransfers = transfers.filter(t => t.to.toLowerCase() === addr);

    if (outTransfers.length === 0 || inTransfers.length === 0) continue;

    // Use first out and first in for simplicity
    const out = outTransfers[0];
    const into = inTransfers[0];

    const decimalsOut = parseInt(out.tokenDecimal) || 18;
    const decimalsIn = parseInt(into.tokenDecimal) || 18;

    swaps.push({
      hash,
      timestamp: parseInt(out.timeStamp),
      tokenIn: out.contractAddress.toLowerCase(),
      tokenInSymbol: out.tokenSymbol,
      tokenOut: into.contractAddress.toLowerCase(),
      tokenOutSymbol: into.tokenSymbol,
      amountIn: Number(out.value) / Math.pow(10, decimalsOut),
      amountOut: Number(into.value) / Math.pow(10, decimalsIn),
    });
  }

  return swaps.sort((a, b) => a.timestamp - b.timestamp);
}

function computePnL(swaps: Swap[]): {
  win_rate: number;
  total_pnl: number;
  best_multiplier: number;
} {
  // Track open positions per token: { tokenAddress -> cost basis in stablecoin terms }
  const positions = new Map<string, { costBasis: number; amount: number }>();
  let wins = 0;
  let losses = 0;
  let total_pnl = 0;
  let best_multiplier = 0;

  for (const swap of swaps) {
    const buyingWithStable = STABLECOINS.has(swap.tokenInSymbol?.toUpperCase());
    const sellingForStable = STABLECOINS.has(swap.tokenOutSymbol?.toUpperCase());

    if (buyingWithStable) {
      // Opening a position: spending stablecoins to buy a token
      const existing = positions.get(swap.tokenOut) ?? { costBasis: 0, amount: 0 };
      positions.set(swap.tokenOut, {
        costBasis: existing.costBasis + swap.amountIn,
        amount: existing.amount + swap.amountOut,
      });
    } else if (sellingForStable) {
      // Closing a position: selling a token for stablecoins
      const pos = positions.get(swap.tokenIn);
      if (pos && pos.costBasis > 0) {
        const proceeds = swap.amountOut;
        const pnl = proceeds - pos.costBasis;
        const multiplier = proceeds / pos.costBasis;

        total_pnl += pnl;
        if (multiplier > best_multiplier) best_multiplier = multiplier;

        if (pnl > 0) wins++;
        else losses++;

        positions.delete(swap.tokenIn);
      }
    }
  }

  const total_trades = wins + losses;
  const win_rate = total_trades > 0 ? wins / total_trades : 0;

  return { win_rate, total_pnl, best_multiplier };
}

export async function scoreEthWallet(address: string): Promise<WalletScore | null> {
  const cfg = getConfig();
  const lookbackTs = Math.floor(Date.now() / 1000) - cfg.scoring.lookback_days * 86400;

  try {
    const txs = await fetchTokenTxs(address, lookbackTs);
    if (txs.length === 0) return null;

    const swaps = reconstructSwaps(address, txs);
    if (swaps.length === 0) return null;

    const { win_rate, total_pnl, best_multiplier } = computePnL(swaps);
    const lastActive = swaps[swaps.length - 1]?.timestamp ?? 0;

    return {
      address: address.toLowerCase(),
      chain: 'eth',
      win_rate,
      total_pnl,
      trade_count: swaps.length,
      last_active: lastActive,
      best_multiplier,
    };
  } catch (err) {
    logger.error(`ETH analyzer error for ${address}`, { err });
    return null;
  }
}
