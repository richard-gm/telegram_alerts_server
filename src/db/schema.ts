import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export function initDb(dbPath?: string): Database.Database {
  const filePath = dbPath ?? path.join(process.cwd(), 'data', 'tracker.db');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  _db = new Database(filePath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  applySchema(_db);
  return _db;
}

function applySchema(db: Database.Database): Database.Database {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      address        TEXT PRIMARY KEY,
      chain          TEXT NOT NULL,
      win_rate       REAL,
      total_pnl      REAL,
      trade_count    INTEGER,
      last_active    INTEGER,
      qualified      INTEGER DEFAULT 0,
      last_checked_block TEXT,
      discovered_at  INTEGER,
      source_token   TEXT
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet         TEXT NOT NULL,
      chain          TEXT NOT NULL,
      token_address  TEXT NOT NULL,
      token_symbol   TEXT,
      balance        TEXT,
      snapshotted_at INTEGER,
      UNIQUE(wallet, chain, token_address)
    );

    CREATE TABLE IF NOT EXISTS trades (
      tx_hash         TEXT PRIMARY KEY,
      wallet          TEXT NOT NULL,
      chain           TEXT NOT NULL,
      token_in        TEXT,
      token_out       TEXT,
      token_symbol    TEXT,
      amount_usd      REAL,
      action          TEXT,
      is_new_position INTEGER DEFAULT 0,
      block_number    TEXT,
      timestamp       INTEGER,
      alerted         INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_qualified ON wallets(qualified);
    CREATE INDEX IF NOT EXISTS idx_wallets_chain ON wallets(chain);
    CREATE INDEX IF NOT EXISTS idx_portfolio_wallet ON portfolio_snapshots(wallet, chain);
    CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet);
    CREATE INDEX IF NOT EXISTS idx_trades_alerted ON trades(alerted);
  `);
  return db;
}
