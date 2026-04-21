import axios from 'axios';
import { getConfig } from '../config/config';
import logger from '../logger';

export interface CoinGeckoToken {
  id: string;
  symbol: string;
  name: string;
  contract_address: string;
  chain: 'eth' | 'sol' | 'base';
  price_change_30d: number;
  total_volume: number;
}

const PLATFORM_TO_COINGECKO: Record<'eth' | 'sol' | 'base', string> = {
  eth: 'ethereum',
  sol: 'solana',
  base: 'base',
};

const CHAIN_CATEGORY: Record<'eth' | 'sol' | 'base', string> = {
  eth: 'ethereum-ecosystem',
  sol: 'solana-ecosystem',
  base: 'base-ecosystem',
};

let _platformMap: Map<string, Record<string, string>> | null = null;
let _platformMapFetchedAt = 0;
const PLATFORM_MAP_TTL = 12 * 60 * 60 * 1000; // 12 hours — coin list changes slowly

// Fetch all coins with their platform contract addresses in one call.
// This eliminates the per-coin /coins/{id} calls that blow through the rate limit.
async function fetchPlatformMap(
  headers: Record<string, string>,
): Promise<Map<string, Record<string, string>>> {
  const now = Date.now();
  if (_platformMap && now - _platformMapFetchedAt < PLATFORM_MAP_TTL) return _platformMap;

  logger.debug('CoinGecko: fetching full coin list with platform addresses...');
  const resp = await withRetry(
    () => axios.get('https://api.coingecko.com/api/v3/coins/list', {
      headers,
      params: { include_platform: true },
      timeout: 30000,
    }),
    'coins/list',
  );

  const map = new Map<string, Record<string, string>>();
  const coins = resp.data as Array<{ id: string; platforms?: Record<string, string> }>;
  for (const coin of coins) {
    if (coin.platforms && Object.keys(coin.platforms).length > 0) {
      map.set(coin.id, coin.platforms);
    }
  }
  _platformMap = map;
  _platformMapFetchedAt = now;
  logger.debug(`CoinGecko: platform map built (${map.size} coins with addresses)`);
  return map;
}

export async function getTopGainers(timeWindow: '7d' | '30d' = '30d'): Promise<CoinGeckoToken[]> {
  const cfg = getConfig();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.coingecko.api_key) headers['x-cg-demo-api-key'] = cfg.coingecko.api_key;

  const cgOrder = `price_change_percentage_${timeWindow}_desc`;
  const pctField = `price_change_percentage_${timeWindow}_in_currency`;

  // One call to get all contract addresses — no per-coin lookups needed
  const platformMap = await fetchPlatformMap(headers);
  await sleep(2000);

  const results: CoinGeckoToken[] = [];
  const chains = Object.entries(PLATFORM_TO_COINGECKO) as [keyof typeof CHAIN_CATEGORY, string][];

  for (let chainIdx = 0; chainIdx < chains.length; chainIdx++) {
    const [chain, platform] = chains[chainIdx];
    if (chainIdx > 0) await sleep(3000); // small gap between chains

    try {
      const resp = await withRetry(
        () => axios.get('https://api.coingecko.com/api/v3/coins/markets', {
          headers,
          params: {
            vs_currency: 'usd',
            category: CHAIN_CATEGORY[chain],
            order: cgOrder,
            per_page: cfg.discovery.coingecko_top_n * 2,
            page: 1,
            sparkline: false,
            price_change_percentage: timeWindow,
          },
          timeout: 15000,
        }),
        `markets/${chain}`,
      );

      const coins = resp.data as Array<Record<string, number | string>>;

      for (const coin of coins) {
        const pct = (coin[pctField] as number) ?? 0;
        if (pct <= 0) continue;
        if (((coin.total_volume as number) ?? 0) < cfg.discovery.min_dex_volume_usd) continue;

        const coinId = coin.id as string;
        const contractAddress = platformMap.get(coinId)?.[platform] ?? null;
        if (!contractAddress) continue;

        results.push({
          id: coinId,
          symbol: coin.symbol as string,
          name: coin.name as string,
          contract_address: contractAddress,
          chain,
          price_change_30d: pct,
          total_volume: coin.total_volume as number,
        });

        if (results.filter(r => r.chain === chain).length >= cfg.discovery.coingecko_top_n) break;
      }
    } catch (err) {
      logger.error(`CoinGecko fetch failed for ${chain}`, { err });
    }
  }

  logger.info(`CoinGecko: found ${results.length} qualifying tokens`);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 4): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt + 1) * 5000; // 10s, 20s, 40s, 80s
        logger.warn(`CoinGecko rate limited (${label}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}
