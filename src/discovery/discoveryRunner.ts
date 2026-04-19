import { getTopGainers } from './coinGecko';
import { getTopTradersForToken, TopTrader } from './dexScreener';
import logger from '../logger';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runDiscovery(): Promise<TopTrader[]> {
  logger.info('Discovery: starting CoinGecko → DEX Screener pipeline');

  const tokens = await getTopGainers();
  logger.info(`Discovery: processing ${tokens.length} tokens`);

  const seen = new Set<string>();
  const allTraders: TopTrader[] = [];

  for (const token of tokens) {
    logger.debug(`Discovery: fetching top traders for ${token.symbol} (${token.contract_address})`);

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

    await sleep(500); // be polite to DEX Screener rate limits
  }

  logger.info(`Discovery: found ${allTraders.length} unique trader wallets`);
  return allTraders;
}
