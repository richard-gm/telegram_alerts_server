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

export default function PendingQueue({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    api.getPending()
      .then(ws => { setWallets(ws); onCountChange?.(ws.length); })
      .finally(() => setLoading(false));
  }, [onCountChange]);

  useEffect(() => { load(); }, [load]);

  async function doAction(address: string, action: 'approve' | 'skip') {
    setActionPending(address);
    setErrors(e => ({ ...e, [address]: '' }));
    try {
      await api.walletAction(address, action);
      load();
    } catch (err) {
      setErrors(e => ({ ...e, [address]: String(err instanceof Error ? err.message : err) }));
    } finally {
      setActionPending(null);
    }
  }

  if (loading) return <div className="empty-state"><span className="spinner" /></div>;

  if (!wallets.length) {
    return <div className="empty-state">No wallets pending approval. They appear here after discovery runs.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {wallets.map(w => {
        const busy = actionPending === w.address;
        return (
          <div key={w.address} className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className={`chain-badge chain-${w.chain}`}>{w.chain.toUpperCase()}</span>
                <a className="address-link" href={explorerUrl(w.chain, w.address)} target="_blank" rel="noreferrer">
                  {shortAddr(w.address)}
                </a>
              </div>
              <div style={{ display: 'flex', gap: 20, fontSize: 13, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                <span>Win rate: <strong style={{ color: 'var(--text)' }}>
                  {w.win_rate !== null ? `${(w.win_rate * 100).toFixed(0)}%` : '—'}
                </strong></span>
                <span>P&amp;L: <strong style={{ color: w.total_pnl !== null && w.total_pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {fmtPnl(w.total_pnl)}
                </strong></span>
                <span>Trades: <strong style={{ color: 'var(--text)' }}>{w.trade_count ?? '—'}</strong></span>
                {w.source_token && (
                  <span>Via: <strong style={{ color: 'var(--text)' }}>${w.source_token.toUpperCase()}</strong></span>
                )}
              </div>
              {errors[w.address] && <div className="error-msg">{errors[w.address]}</div>}
            </div>
            <div className="btn-group">
              <button className="btn btn-green" disabled={busy} onClick={() => doAction(w.address, 'approve')}>
                {busy ? <span className="spinner" /> : '✓ Approve'}
              </button>
              <button className="btn btn-red" disabled={busy} onClick={() => doAction(w.address, 'skip')}>
                ✕ Skip
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
