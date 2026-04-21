import { useState, useEffect, useCallback } from 'react';
import { api, Wallet } from '../api';

function shortAddr(addr: string) {
  return `${addr.slice(0, 7)}...${addr.slice(-5)}`;
}

function explorerUrl(chain: string, addr: string) {
  return chain === 'eth'
    ? `https://etherscan.io/address/${addr}`
    : `https://solscan.io/account/${addr}`;
}

function fmtPnl(v: number | null) {
  if (v === null) return '—';
  const sign = v >= 0 ? '+' : '';
  if (Math.abs(v) >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${sign}$${(v / 1_000).toFixed(0)}k`;
  return `${sign}$${v.toFixed(0)}`;
}

function fmtDate(ts: number | null) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString();
}

export default function Watchlist() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getWallets()
      .then(all => setWallets(all.filter(w => w.qualified === 1 || w.qualified === 2)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function doAction(address: string, action: 'pause' | 'unpause') {
    setActionPending(address);
    try { await api.walletAction(address, action); load(); } finally { setActionPending(null); }
  }

  async function doRemove(address: string) {
    if (!confirm(`Remove ${shortAddr(address)} from watchlist?`)) return;
    setActionPending(address);
    try { await api.deleteWallet(address); load(); } finally { setActionPending(null); }
  }

  if (loading) return <div className="empty-state"><span className="spinner" /></div>;

  const active = wallets.filter(w => w.qualified === 1);
  const paused = wallets.filter(w => w.qualified === 2);
  const sorted = [...active, ...paused];

  if (!sorted.length) {
    return <div className="empty-state">No wallets in watchlist yet. Approve wallets from the Pending queue.</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: 12, color: 'var(--text-muted)', fontSize: 13 }}>
        {active.length} active · {paused.length} paused
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Chain</th>
              <th>Win Rate</th>
              <th>P&amp;L</th>
              <th>Trades</th>
              <th>Source Token</th>
              <th>Discovered</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(w => {
              const busy = actionPending === w.address;
              return (
                <tr key={w.address}>
                  <td>
                    <div className="address-cell">
                      <a className="address-link" href={explorerUrl(w.chain, w.address)} target="_blank" rel="noreferrer">
                        {shortAddr(w.address)}
                      </a>
                    </div>
                  </td>
                  <td><span className={`chain-badge chain-${w.chain}`}>{w.chain}</span></td>
                  <td>{w.win_rate !== null ? `${(w.win_rate * 100).toFixed(0)}%` : '—'}</td>
                  <td className={w.total_pnl !== null && w.total_pnl >= 0 ? 'green' : 'red'}>
                    {fmtPnl(w.total_pnl)}
                  </td>
                  <td>{w.trade_count ?? '—'}</td>
                  <td className="mono muted">{w.source_token ? `$${w.source_token.toUpperCase()}` : '—'}</td>
                  <td className="muted">{fmtDate(w.discovered_at)}</td>
                  <td>
                    <span className={`status-badge status-${w.qualified === 2 ? 'paused' : 'active'}`}>
                      {w.qualified === 2 ? 'Paused' : 'Active'}
                    </span>
                  </td>
                  <td>
                    <div className="btn-group">
                      {w.qualified === 1 ? (
                        <button className="btn btn-yellow" disabled={busy} onClick={() => doAction(w.address, 'pause')}>
                          {busy ? <span className="spinner" /> : 'Pause'}
                        </button>
                      ) : (
                        <button className="btn btn-green" disabled={busy} onClick={() => doAction(w.address, 'unpause')}>
                          {busy ? <span className="spinner" /> : 'Resume'}
                        </button>
                      )}
                      <button className="btn btn-red" disabled={busy} onClick={() => doRemove(w.address)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
