export type Chain = 'eth' | 'sol';

export interface Wallet {
  address: string;
  chain: Chain;
  win_rate: number | null;
  total_pnl: number | null;
  trade_count: number | null;
  last_active: number | null;
  qualified: number; // -1=skipped, 0=pending, 1=active, 2=paused
  discovered_at: number | null;
  source_token: string | null;
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
  timestamp: number | null;
  alerted: number;
}

export interface WalletScore {
  address: string;
  chain: Chain;
  win_rate: number;
  total_pnl: number;
  trade_count: number;
  best_multiplier: number;
  last_active: number | null;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getWallets: () => request<Wallet[]>('/wallets'),
  getPending: () => request<Wallet[]>('/wallets/pending'),
  analyzeWallet: (address: string) =>
    request<WalletScore>('/wallets/analyze', {
      method: 'POST',
      body: JSON.stringify({ address }),
    }),
  walletAction: (address: string, action: 'approve' | 'skip' | 'pause' | 'unpause') =>
    request<{ ok: boolean }>(`/wallets/${encodeURIComponent(address)}`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    }),
  deleteWallet: (address: string) =>
    request<{ ok: boolean }>(`/wallets/${encodeURIComponent(address)}`, { method: 'DELETE' }),
  getTrades: (params?: { limit?: number; chain?: Chain }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.chain) qs.set('chain', params.chain);
    const q = qs.toString();
    return request<Trade[]>(`/trades${q ? `?${q}` : ''}`);
  },
};
