import axios from 'axios';
import { getConfig } from '../config/config';
import { etherscanRateLimit, EVM_CHAIN_ID } from '../analysis/ethAnalyzer';
import logger from '../logger';

// TODO: Use DEX Screener's actual /dex/tokens/{tokenAddress}/top-traders endpoint to get
// pre-ranked traders with real P&L data, instead of inferring active wallets from on-chain
// token transfer events. This would eliminate the need for the Etherscan/Helius discovery
// calls and give us richer trader quality signals before the Etherscan analysis step.

export interface TopTrader {
  wallet: string;
  chain: 'eth' | 'sol' | 'base';
  bought_usd: number;
  sold_usd: number;
  pnl_usd: number;
  pnl_multiplier: number;
  source_token: string;
  source_token_symbol: string;
}

// Known DEX router / contract addresses to exclude from trader lists
const ETH_EXCLUDE = new Set([
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap v2 router
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap v3 router
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap v3 router2
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap universal router
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap router
  '0x1111111254fb6c44bac0bed2854e76f90643097d', // 1inch v4
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch v5
  '0x0000000000000000000000000000000000000000', // zero address
]);

const BASE_EXCLUDE = new Set([
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap v2 router (Base)
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap v3 router2 (Base)
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874c43', // Aerodrome router
  '0x827922686190fd9ea3f89e7e03f3789e0b9ea042', // BaseSwap router
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch v5
  '0x0000000000000000000000000000000000000000', // zero address
]);

const EVM_EXCLUDE: Record<'eth' | 'base', Set<string>> = { eth: ETH_EXCLUDE, base: BASE_EXCLUDE };

async function getEvmTopTraders(contractAddress: string, symbol: string, chain: 'eth' | 'base'): Promise<TopTrader[]> {
  const cfg = getConfig();
  await etherscanRateLimit();

  const resp = await axios.get('https://api.etherscan.io/v2/api', {
    params: {
      chainid: EVM_CHAIN_ID[chain],
      module: 'account',
      action: 'tokentx',
      contractaddress: contractAddress,
      sort: 'desc',
      page: 1,
      offset: 300,
      apikey: cfg.etherscan.api_key || 'YourApiKeyToken',
    },
    timeout: 15000,
  });

  if (resp.data.status !== '1') {
    logger.debug(`Etherscan tokentx for ${symbol} (${chain}): ${resp.data.message}`);
    return [];
  }

  const txs: Array<{ from: string; to: string }> = resp.data.result ?? [];
  const tokenAddr = contractAddress.toLowerCase();
  const exclude = EVM_EXCLUDE[chain];

  // Count appearances per wallet — more trades = more active trader
  const walletCount = new Map<string, number>();
  for (const tx of txs) {
    for (const addr of [tx.from.toLowerCase(), tx.to.toLowerCase()]) {
      if (exclude.has(addr) || addr === tokenAddr) continue;
      walletCount.set(addr, (walletCount.get(addr) ?? 0) + 1);
    }
  }

  return Array.from(walletCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, cfg.discovery.traders_per_token)
    .map(([wallet]) => ({
      wallet,
      chain,
      bought_usd: 0,
      sold_usd: 0,
      pnl_usd: 0,
      pnl_multiplier: 0,
      source_token: contractAddress,
      source_token_symbol: symbol,
    }));
}

async function getSolTopTraders(mintAddress: string, symbol: string): Promise<TopTrader[]> {
  const cfg = getConfig();
  if (!cfg.helius.api_key) {
    logger.debug('Helius api_key not set — skipping SOL trader discovery');
    return [];
  }

  try {
    // Helius: get recent transactions involving this mint
    const resp = await axios.get(`https://api.helius.xyz/v0/addresses/${mintAddress}/transactions`, {
      params: {
        'api-key': cfg.helius.api_key,
        type: 'SWAP',
        limit: 100,
      },
      timeout: 15000,
    });

    const txs: Array<{ feePayer?: string }> = Array.isArray(resp.data) ? resp.data : [];
    const wallets = new Set<string>();
    for (const tx of txs) {
      if (tx.feePayer) wallets.add(tx.feePayer);
    }

    return Array.from(wallets)
      .slice(0, cfg.discovery.traders_per_token)
      .map(wallet => ({
        wallet,
        chain: 'sol',
        bought_usd: 0,
        sold_usd: 0,
        pnl_usd: 0,
        pnl_multiplier: 0,
        source_token: mintAddress,
        source_token_symbol: symbol,
      }));
  } catch (err) {
    logger.debug(`Helius trader discovery failed for ${symbol}`, { err });
    return [];
  }
}

export async function getTopTradersForToken(
  contractAddress: string,
  chain: 'eth' | 'sol' | 'base',
  sourceTokenSymbol: string,
): Promise<TopTrader[]> {
  try {
    if (chain === 'eth' || chain === 'base') {
      return await getEvmTopTraders(contractAddress, sourceTokenSymbol, chain);
    } else {
      return await getSolTopTraders(contractAddress, sourceTokenSymbol);
    }
  } catch (err) {
    logger.error(`Top trader discovery error for ${sourceTokenSymbol}`, { err });
    return [];
  }
}
