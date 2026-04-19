import axios from 'axios';
import { getConfig } from '../config/config';
import logger from '../logger';

export interface CoinGeckoToken {
  id: string;
  symbol: string;
  name: string;
  contract_address: string;
  chain: 'eth' | 'sol';
  price_change_30d: number;
  total_volume: number;
}

const CHAIN_MAP: Record<string, 'eth' | 'sol'> = {
  ethereum: 'eth',
  solana: 'sol',
};

const PLATFORM_TO_COINGECKO: Record<'eth' | 'sol', string> = {
  eth: 'ethereum',
  sol: 'solana',
};

export async function getTopGainers(): Promise<CoinGeckoToken[]> {
  const cfg = getConfig();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.coingecko.api_key) headers['x-cg-demo-api-key'] = cfg.coingecko.api_key;

  // Fetch top gainers for both ETH and SOL platforms
  const results: CoinGeckoToken[] = [];

  for (const [chain, platform] of Object.entries(PLATFORM_TO_COINGECKO) as [keyof typeof PLATFORM_TO_COINGECKO, string][]) {
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
        headers,
        params: {
          vs_currency: 'usd',
          category: platform === 'ethereum' ? 'ethereum-ecosystem' : 'solana-ecosystem',
          order: 'price_change_percentage_30d_desc',
          per_page: cfg.discovery.coingecko_top_n * 2, // fetch extra to account for filtering
          page: 1,
          sparkline: false,
          price_change_percentage: '30d',
        },
        timeout: 15000,
      });

      const coins = resp.data as Array<{
        id: string;
        symbol: string;
        name: string;
        total_volume: number;
        price_change_percentage_30d_in_currency: number;
      }>;

      for (const coin of coins) {
        const pct30d = coin.price_change_percentage_30d_in_currency ?? 0;
        if (pct30d <= 0) continue;
        if ((coin.total_volume ?? 0) < cfg.discovery.min_dex_volume_usd) continue;

        // Fetch contract address
        const contractAddress = await getContractAddress(coin.id, platform, headers);
        if (!contractAddress) continue;

        results.push({
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          contract_address: contractAddress,
          chain,
          price_change_30d: pct30d,
          total_volume: coin.total_volume,
        });

        if (results.filter(r => r.chain === chain).length >= cfg.discovery.coingecko_top_n) break;
        await sleep(300); // gentle rate limiting
      }
    } catch (err) {
      logger.error(`CoinGecko fetch failed for ${chain}`, { err });
    }
  }

  logger.info(`CoinGecko: found ${results.length} qualifying tokens`);
  return results;
}

async function getContractAddress(
  coinId: string,
  platform: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const resp = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}`, {
      headers,
      params: { localization: false, tickers: false, market_data: false, community_data: false, developer_data: false },
      timeout: 10000,
    });
    const platforms = resp.data?.platforms ?? {};
    return (platforms[platform] as string | undefined) ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
