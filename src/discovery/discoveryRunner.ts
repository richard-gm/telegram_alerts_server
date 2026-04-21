import { getTopGainers, CoinGeckoToken, sleep } from './coinGecko';
import { getTopTradersForToken, TopTrader } from './dexScreener';
import { getProcessedToken, upsertProcessedToken } from '../db/queries';
import { getConfig } from '../config/config';
import logger from '../logger';

export async function runDiscovery(timeWindow: '7d' | '30d' = '30d'): Promise<TopTrader[]> {
  const cfg = getConfig();
  logger.info(`Discovery: starting CoinGecko (${timeWindow}) → DEX Screener pipeline`);

  const tokens = await getTopGainers(timeWindow);

  const ethTokens = tokens.filter(t => t.chain === 'eth');
  const solTokens = tokens.filter(t => t.chain === 'sol');
  const baseTokens = tokens.filter(t => t.chain === 'base');
  logger.info(`Discovery: ${tokens.length} tokens — ETH:${ethTokens.length} SOL:${solTokens.length} BASE:${baseTokens.length}`);

  const cacheTtl = cfg.discovery.interval_hours * 3600;
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const allTraders: TopTrader[] = [];
  let cacheHits = 0;

  for (const token of tokens) {
    // Skip tokens already processed within this discovery interval
    const cached = getProcessedToken(token.contract_address, token.chain, timeWindow);
    if (cached && now - cached.processed_at < cacheTtl) {
      const minsAgo = Math.floor((now - cached.processed_at) / 60);
      logger.debug(`Discovery: skipping ${token.symbol} (${token.chain}) — processed ${minsAgo}m ago, found ${cached.traders_found} traders`);
      cacheHits++;
      continue;
    }

    logger.debug(`Discovery: fetching top traders for ${token.symbol} (${token.chain.toUpperCase()})`);

    const traders = await getTopTradersForToken(
      token.contract_address,
      token.chain,
      token.symbol,
    );

    for (const trader of traders) {
      if (!seen.has(trader.wallet)) {
        seen.add(trader.wallet);
        allTraders.push(trader);
      }
    }

    upsertProcessedToken(token.contract_address, token.chain, timeWindow, traders.length);
    await sleep(500);
  }

  logger.info(`Discovery: found ${allTraders.length} unique trader wallets (${cacheHits > 0 ? `${cacheHits} tokens skipped from cache` : 'all tokens fresh'})`);
  return allTraders;
}
