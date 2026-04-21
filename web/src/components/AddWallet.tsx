import { useState } from 'react';
import { api, WalletScore } from '../api';

function fmtPnl(v: number) {
  const sign = v >= 0 ? '+' : '';
  if (Math.abs(v) >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${sign}$${(v / 1_000).toFixed(0)}k`;
  return `${sign}$${v.toFixed(0)}`;
}

export default function AddWallet() {
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WalletScore | null>(null);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);

  const chain = address.startsWith('0x') ? 'eth' : address.length > 30 ? 'sol' : null;

  async function analyze() {
    if (!address.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    setApproved(false);
    try {
      const score = await api.analyzeWallet(address.trim());
      setResult(score);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function approve() {
    if (!result) return;
    setApproving(true);
    try {
      await api.walletAction(result.address, 'approve');
      setApproved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="card">
        <div className="form-group">
          <label className="form-label">Wallet address</label>
          <input
            className="form-input"
            type="text"
            placeholder="0x... or Solana address"
            value={address}
            onChange={e => { setAddress(e.target.value); setResult(null); setError(''); setApproved(false); }}
            onKeyDown={e => e.key === 'Enter' && !loading && analyze()}
          />
          {chain && (
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              Detected chain: <span className={`chain-badge chain-${chain}`}>{chain.toUpperCase()}</span>
            </div>
          )}
        </div>
        <button
          className="btn btn-primary"
          onClick={analyze}
          disabled={loading || !address.trim()}
        >
          {loading ? <><span className="spinner" style={{ marginRight: 8 }} />Analyzing...</> : 'Analyze Wallet'}
        </button>
        {error && <div className="error-msg">{error}</div>}
      </div>

      {result && (
        <div className="score-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span className={`chain-badge chain-${result.chain}`}>{result.chain.toUpperCase()}</span>
            <span className="mono" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {result.address}
            </span>
          </div>
          <div className="score-grid">
            <div className="score-item">
              <div className="score-label">Win Rate</div>
              <div className="score-value">{(result.win_rate * 100).toFixed(0)}%</div>
            </div>
            <div className="score-item">
              <div className="score-label">Total P&L</div>
              <div className={`score-value ${result.total_pnl >= 0 ? 'green' : 'red'}`}>
                {fmtPnl(result.total_pnl)}
              </div>
            </div>
            <div className="score-item">
              <div className="score-label">Trades</div>
              <div className="score-value">{result.trade_count}</div>
            </div>
            <div className="score-item">
              <div className="score-label">Best Trade</div>
              <div className="score-value">{result.best_multiplier.toFixed(1)}x</div>
            </div>
          </div>

          {approved ? (
            <div className="success-msg" style={{ marginTop: 16, fontSize: 14 }}>
              ✓ Wallet added to watchlist and registered with webhook provider
            </div>
          ) : (
            <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
              <button className="btn btn-green" onClick={approve} disabled={approving}>
                {approving ? <><span className="spinner" style={{ marginRight: 6 }} />Approving...</> : '✓ Add to Watchlist'}
              </button>
              <button className="btn btn-red" onClick={() => setResult(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
