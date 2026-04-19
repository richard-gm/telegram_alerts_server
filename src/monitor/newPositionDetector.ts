import { hasTokenInSnapshot, upsertSnapshot } from '../db/queries';
import type { Chain } from '../db/queries';

export function isNewPosition(wallet: string, chain: Chain, tokenAddress: string): boolean {
  return !hasTokenInSnapshot(wallet, chain, tokenAddress.toLowerCase());
}

export function recordNewPosition(wallet: string, chain: Chain, tokenAddress: string, symbol: string | null): void {
  upsertSnapshot({
    wallet,
    chain,
    token_address: tokenAddress.toLowerCase(),
    token_symbol: symbol,
    balance: '1',
    snapshotted_at: Math.floor(Date.now() / 1000),
  });
}
