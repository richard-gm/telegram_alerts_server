import { getDb } from './schema';

export type Chain = 'eth' | 'sol';

export interface Wallet {
  address: string;
  chain: Chain;
  win_rate: number | null;
  total_pnl: number | null;
  trade_count: number | null;
  last_active: number | null;
  qualified: number;
  last_checked_block: string | null;
  discovered_at: number | null;
  source_token: string | null;
}

export interface PortfolioSnapshot {
  id: number;
  wallet: string;
  chain: Chain;
  token_address: string;
  token_symbol: string | null;
  balance: string | null;
  snapshotted_at: number;
}

export interface Trade {
  tx_hash: string;
  wallet: string;
  chain: Chain;
  token_in: string | null;
  token_out: string | null;
  token_symbol: string | null;
  amount_usd: number | null;
  action: 'buy' | 'sell' | null;
  is_new_position: number;
  block_number: string | null;
  timestamp: number | null;
  alerted: number;
}

// --- Wallets ---

export function upsertWallet(w: Omit<Wallet, 'qualified' | 'last_checked_block'>): void {
  getDb().prepare(`
    INSERT INTO wallets (address, chain, win_rate, total_pnl, trade_count, last_active, discovered_at, source_token)
    VALUES (@address, @chain, @win_rate, @total_pnl, @trade_count, @last_active, @discovered_at, @source_token)
    ON CONFLICT(address) DO UPDATE SET
      win_rate    = excluded.win_rate,
      total_pnl   = excluded.total_pnl,
      trade_count = excluded.trade_count,
      last_active = excluded.last_active
  `).run(w);
}

export function qualifyWallet(address: string): void {
  getDb().prepare(`UPDATE wallets SET qualified = 1 WHERE address = ?`).run(address);
}

export function disqualifyWallet(address: string): void {
  getDb().prepare(`UPDATE wallets SET qualified = -1 WHERE address = ?`).run(address);
}

export function getQualifiedWallets(chain?: Chain): Wallet[] {
  if (chain) {
    return getDb().prepare(`SELECT * FROM wallets WHERE qualified = 1 AND chain = ?`).all(chain) as Wallet[];
  }
  return getDb().prepare(`SELECT * FROM wallets WHERE qualified = 1`).all() as Wallet[];
}

export function getWallet(address: string): Wallet | undefined {
  return getDb().prepare(`SELECT * FROM wallets WHERE address = ?`).get(address) as Wallet | undefined;
}

export function updateLastCheckedBlock(address: string, blockNumber: string): void {
  getDb().prepare(`UPDATE wallets SET last_checked_block = ? WHERE address = ?`).run(blockNumber, address);
}

// --- Portfolio Snapshots ---

export function upsertSnapshot(s: Omit<PortfolioSnapshot, 'id'>): void {
  getDb().prepare(`
    INSERT INTO portfolio_snapshots (wallet, chain, token_address, token_symbol, balance, snapshotted_at)
    VALUES (@wallet, @chain, @token_address, @token_symbol, @balance, @snapshotted_at)
    ON CONFLICT(wallet, chain, token_address) DO UPDATE SET
      balance        = excluded.balance,
      snapshotted_at = excluded.snapshotted_at
  `).run(s);
}

export function getSnapshot(wallet: string, chain: Chain): PortfolioSnapshot[] {
  return getDb().prepare(`SELECT * FROM portfolio_snapshots WHERE wallet = ? AND chain = ?`).all(wallet, chain) as PortfolioSnapshot[];
}

export function hasTokenInSnapshot(wallet: string, chain: Chain, tokenAddress: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM portfolio_snapshots WHERE wallet = ? AND chain = ? AND token_address = ?
  `).get(wallet, chain, tokenAddress.toLowerCase());
  return !!row;
}

// --- Trades ---

export function insertTrade(t: Omit<Trade, 'alerted'>): boolean {
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO trades
      (tx_hash, wallet, chain, token_in, token_out, token_symbol, amount_usd, action, is_new_position, block_number, timestamp)
    VALUES
      (@tx_hash, @wallet, @chain, @token_in, @token_out, @token_symbol, @amount_usd, @action, @is_new_position, @block_number, @timestamp)
  `).run(t);
  return result.changes > 0;
}

export function markAlerted(txHash: string): void {
  getDb().prepare(`UPDATE trades SET alerted = 1 WHERE tx_hash = ?`).run(txHash);
}

export function getPendingAlerts(): Trade[] {
  return getDb().prepare(`SELECT * FROM trades WHERE alerted = 0 ORDER BY timestamp ASC`).all() as Trade[];
}
