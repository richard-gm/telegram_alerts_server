import { useState, useEffect, useCallback } from 'react';
import { api, Trade, Chain } from '../api';

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function explorerTxUrl(chain: string, hash: string) {
  return chain === 'eth'
    ? `https://etherscan.io/tx/${hash}`
    : `https://solscan.io/tx/${hash}`;
}

function explorerAddrUrl(chain: string, addr: string) {
  return chain === 'eth'
    ? `https://etherscan.io/address/${addr}`
    : `https://solscan.io/account/${addr}`;
}

function fmtTime(ts: number | null) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtUsd(v: number | null) {
  if (v === null || v === 0) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

export default function TradeFeed() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [chainFilter, setChainFilter] = useState<Chain | ''>('');
  const [limit, setLimit] = useState(100);

  const load = useCallback(() => {
    setLoading(true);
    api.getTrades({ limit, chain: chainFilter || undefined })
      .then(setTrades)
      .finally(() => setLoading(false));
  }, [limit, chainFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="filter-bar">
        <select value={chainFilter} onChange={e => setChainFilter(e.target.value as Chain | '')}>
          <option value="">All chains</option>
          <option value="eth">ETH only</option>
          <option value="sol">SOL only</option>
        </select>
        <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
          <option value={50}>Last 50</option>
          <option value={100}>Last 100</option>
          <option value={250}>Last 250</option>
        </select>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? <span className="spinner" /> : 'Refresh'}
        </button>
        <span className="muted" style={{ fontSize: 13, marginLeft: 'auto' }}>
          {trades.length} trades
        </span>
      </div>

      {loading ? (
        <div className="empty-state"><span className="spinner" /></div>
      ) : !trades.length ? (
        <div className="empty-state">No trades yet. Trades appear here once wallets are approved and webhooks fire.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Chain</th>
                <th>Wallet</th>
                <th>Action</th>
                <th>Token</th>
                <th>Amount</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(t => (
                <tr key={t.tx_hash}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(t.timestamp)}</td>
                  <td><span className={`chain-badge chain-${t.chain}`}>{t.chain}</span></td>
                  <td>
                    <a className="address-link" href={explorerAddrUrl(t.chain, t.wallet)} target="_blank" rel="noreferrer">
                      {shortAddr(t.wallet)}
                    </a>
                  </td>
                  <td>
                    <span className={`action-badge action-${t.action ?? 'buy'}`}>
                      {t.action?.toUpperCase() ?? '—'}
                    </span>
                    {t.is_new_position === 1 && <span className="new-pos" style={{ marginLeft: 4 }}>NEW</span>}
                  </td>
                  <td className="mono">{t.token_symbol ? `$${t.token_symbol.toUpperCase()}` : '—'}</td>
                  <td>{fmtUsd(t.amount_usd)}</td>
                  <td>
                    <a className="address-link" href={explorerTxUrl(t.chain, t.tx_hash)} target="_blank" rel="noreferrer">
                      {shortAddr(t.tx_hash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
