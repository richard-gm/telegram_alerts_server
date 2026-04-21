import { getDb } from './schema';

export type Chain = 'eth' | 'sol' | 'base';

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

// --- Dashboard helpers ---

export function getAllWallets(): Wallet[] {
  return getDb().prepare(`SELECT * FROM wallets ORDER BY discovered_at DESC`).all() as Wallet[];
}

export function getPendingWallets(): Wallet[] {
  return getDb().prepare(`SELECT * FROM wallets WHERE qualified = 0 ORDER BY discovered_at DESC`).all() as Wallet[];
}

export function getRecentTrades(limit = 100, chain?: Chain): Trade[] {
  if (chain) {
    return getDb().prepare(`SELECT * FROM trades WHERE chain = ? ORDER BY timestamp DESC LIMIT ?`).all(chain, limit) as Trade[];
  }
  return getDb().prepare(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`).all(limit) as Trade[];
}

export function pauseWallet(address: string): void {
  getDb().prepare(`UPDATE wallets SET qualified = 2 WHERE address = ?`).run(address);
}

export function unpauseWallet(address: string): void {
  getDb().prepare(`UPDATE wallets SET qualified = 1 WHERE address = ?`).run(address);
}

export function removeWallet(address: string): void {
  getDb().prepare(`DELETE FROM wallets WHERE address = ?`).run(address);
}

// --- Processed Token Cache ---

export function getProcessedToken(
  tokenAddress: string, chain: Chain, timeWindow: string,
): { processed_at: number; traders_found: number } | undefined {
  return getDb().prepare(
    `SELECT processed_at, traders_found FROM processed_tokens WHERE token_address = ? AND chain = ? AND time_window = ?`
  ).get(tokenAddress, chain, timeWindow) as { processed_at: number; traders_found: number } | undefined;
}

export function upsertProcessedToken(
  tokenAddress: string, chain: Chain, timeWindow: string, tradersFound: number,
): void {
  getDb().prepare(`
    INSERT INTO processed_tokens (token_address, chain, time_window, processed_at, traders_found)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token_address, chain, time_window) DO UPDATE SET
      processed_at  = excluded.processed_at,
      traders_found = excluded.traders_found
  `).run(tokenAddress, chain, timeWindow, Math.floor(Date.now() / 1000), tradersFound);
}

// --- Debug Logs ---

export function insertDebugLog(type: string, wallet: string | null, data: unknown): void {
  getDb().prepare(
    `INSERT INTO debug_logs (created_at, type, wallet, data) VALUES (?, ?, ?, ?)`
  ).run(Math.floor(Date.now() / 1000), type, wallet ?? null, JSON.stringify(data));
}

export interface PurgeResult {
  trades: number;
  snapshots: number;
  debugLogs: number;
  wallets: number;
}

export function purgeOldData(retentionDays = 30): PurgeResult {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const db = getDb();
  return db.transaction((): PurgeResult => ({
    trades:    db.prepare(`DELETE FROM trades WHERE timestamp < ?`).run(cutoff).changes,
    snapshots: db.prepare(`DELETE FROM portfolio_snapshots WHERE snapshotted_at < ?`).run(cutoff).changes,
    debugLogs: db.prepare(`DELETE FROM debug_logs WHERE created_at < ?`).run(cutoff).changes,
    wallets:   db.prepare(`DELETE FROM wallets WHERE qualified = -1 AND discovered_at < ?`).run(cutoff).changes,
  }))();
}
