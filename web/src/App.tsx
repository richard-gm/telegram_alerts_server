import { useState, useCallback } from 'react';
import Watchlist from './components/Watchlist';
import PendingQueue from './components/PendingQueue';
import TradeFeed from './components/TradeFeed';
import AddWallet from './components/AddWallet';

type Tab = 'watchlist' | 'pending' | 'trades' | 'add';

export default function App() {
  const [tab, setTab] = useState<Tab>('watchlist');
  const [pendingCount, setPendingCount] = useState(0);

  const handlePendingCount = useCallback((n: number) => setPendingCount(n), []);

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand">Smart Wallet Tracker</div>
        <div className="tabs">
          <button className={`tab ${tab === 'watchlist' ? 'active' : ''}`} onClick={() => setTab('watchlist')}>
            Watchlist
          </button>
          <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
            Pending Approval
            {pendingCount > 0 && <span className="badge warn">{pendingCount}</span>}
          </button>
          <button className={`tab ${tab === 'trades' ? 'active' : ''}`} onClick={() => setTab('trades')}>
            Trade Feed
          </button>
          <button className={`tab ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
            + Add Wallet
          </button>
        </div>
      </nav>

      <main className="page">
        <h1 className="page-title">
          {tab === 'watchlist' && 'Watchlist'}
          {tab === 'pending' && 'Pending Approval'}
          {tab === 'trades' && 'Trade Feed'}
          {tab === 'add' && 'Add Wallet'}
        </h1>

        {tab === 'watchlist' && <Watchlist />}
        {tab === 'pending' && <PendingQueue onCountChange={handlePendingCount} />}
        {tab === 'trades' && <TradeFeed />}
        {tab === 'add' && <AddWallet />}
      </main>
    </>
  );
}
