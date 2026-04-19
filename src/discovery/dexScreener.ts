import axios from 'axios';
import { getConfig } from '../config/config';
import logger from '../logger';

export interface TopTrader {
  wallet: string;
  chain: 'eth' | 'sol';
  bought_usd: number;
  sold_usd: number;
  pnl_usd: number;
  pnl_multiplier: number;
  source_token: string;
  source_token_symbol: string;
}

const DEXSCREENER_CHAIN_MAP: Record<string, 'eth' | 'sol'> = {
  ethereum: 'eth',
  base: 'eth',
  arbitrum: 'eth',
  optimism: 'eth',
  bsc: 'eth',
  polygon: 'eth',
  solana: 'sol',
};

export async function getTopTradersForToken(
  contractAddress: string,
  preferredChain: 'eth' | 'sol',
  sourceTokenSymbol: string,
): Promise<TopTrader[]> {
  const cfg = getConfig();

  try {
    // Search for the token pair
    const searchResp = await axios.get(
      `https://api.dexscreener.com/latest/dex/search?q=${contractAddress}`,
      { timeout: 10000 },
    );

    const pairs: Array<{
      chainId: string;
      pairAddress: string;
      volume?: { h24?: number };
      baseToken?: { address: string; symbol: string };
    }> = searchResp.data?.pairs ?? [];

    if (pairs.length === 0) {
      logger.debug(`DEX Screener: no pairs found for ${contractAddress}`);
      return [];
    }

    // Filter to preferred chain and pick highest volume pair
    const chainPairs = pairs.filter(p => {
      const mapped = DEXSCREENER_CHAIN_MAP[p.chainId?.toLowerCase() ?? ''];
      return mapped === preferredChain;
    });

    const targetPairs = chainPairs.length > 0 ? chainPairs : pairs;
    const topPair = targetPairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];

    // Fetch top traders for the pair
    const tradersResp = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/${topPair.chainId}/${topPair.pairAddress}`,
      { timeout: 10000 },
    );

    const pairData = tradersResp.data?.pairs?.[0];
    if (!pairData) return [];

    const traders: Array<{
      wallet?: string;
      address?: string;
      bought?: number;
      sold?: number;
      pnl?: number;
    }> = pairData.topTraders ?? [];

    const pairChain = DEXSCREENER_CHAIN_MAP[topPair.chainId?.toLowerCase() ?? ''] ?? preferredChain;

    return traders
      .slice(0, cfg.discovery.traders_per_token)
      .map(t => {
        const bought = t.bought ?? 0;
        const sold = t.sold ?? 0;
        const pnl = t.pnl ?? sold - bought;
        const multiplier = bought > 0 ? sold / bought : 0;
        return {
          wallet: (t.wallet ?? t.address ?? '').toLowerCase(),
          chain: pairChain,
          bought_usd: bought,
          sold_usd: sold,
          pnl_usd: pnl,
          pnl_multiplier: multiplier,
          source_token: contractAddress,
          source_token_symbol: sourceTokenSymbol,
        };
      })
      .filter(t => t.wallet.length > 0);
  } catch (err) {
    logger.error(`DEX Screener error for ${contractAddress}`, { err });
    return [];
  }
}
