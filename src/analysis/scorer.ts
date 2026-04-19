import { getConfig } from '../config/config';
import { upsertWallet, getWallet } from '../db/queries';
import { scoreEthWallet } from './ethAnalyzer';
import { scoreSolWallet } from './solAnalyzer';
import { TopTrader } from '../discovery/dexScreener';
import logger from '../logger';

export interface WalletScore {
  address: string;
  chain: 'eth' | 'sol';
  win_rate: number;
  total_pnl: number;
  trade_count: number;
  best_multiplier: number;
  last_active: number | null;
  source_token: string | null;
}

export async function scoreTrader(trader: TopTrader): Promise<WalletScore | null> {
  const existing = getWallet(trader.wallet);

  // Already qualified — skip re-analysis
  if (existing?.qualified === 1) return null;
  // Previously skipped — don't re-propose
  if (existing?.qualified === -1) return null;

  logger.debug(`Scoring ${trader.chain.toUpperCase()} wallet ${trader.wallet}`);

  const score = trader.chain === 'eth'
    ? await scoreEthWallet(trader.wallet)
    : await scoreSolWallet(trader.wallet);

  if (!score) {
    logger.debug(`No score data for ${trader.wallet}`);
    return null;
  }

  // Save raw score regardless of qualification
  upsertWallet({
    address: score.address,
    chain: score.chain,
    win_rate: score.win_rate,
    total_pnl: score.total_pnl,
    trade_count: score.trade_count,
    last_active: score.last_active,
    discovered_at: Math.floor(Date.now() / 1000),
    source_token: trader.source_token,
  });

  const cfg = getConfig();
  const qualifies =
    score.win_rate >= cfg.scoring.min_win_rate &&
    score.total_pnl >= cfg.scoring.min_pnl_usd &&
    score.trade_count >= cfg.scoring.min_trade_count &&
    score.best_multiplier >= cfg.scoring.min_pnl_multiplier;

  if (!qualifies) {
    logger.debug(
      `Wallet ${score.address} did not meet thresholds ` +
      `(win_rate=${(score.win_rate * 100).toFixed(0)}% pnl=$${score.total_pnl.toFixed(0)})`
    );
    return null;
  }

  logger.info(
    `Wallet ${score.address} (${score.chain.toUpperCase()}) passed scoring — ` +
    `win_rate=${(score.win_rate * 100).toFixed(0)}% pnl=$${score.total_pnl.toFixed(0)} ` +
    `trades=${score.trade_count} best_mult=${score.best_multiplier.toFixed(1)}x`
  );

  return {
    address: score.address,
    chain: score.chain,
    win_rate: score.win_rate,
    total_pnl: score.total_pnl,
    trade_count: score.trade_count,
    best_multiplier: score.best_multiplier,
    last_active: score.last_active,
    source_token: trader.source_token,
  };
}
