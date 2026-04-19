import axios from 'axios';
import { getConfig } from '../config/config';
import { upsertSnapshot } from '../db/queries';
import logger from '../logger';

interface SolscanToken {
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: { uiAmount: number; amount: string };
}

let _lastCall = 0;
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = 300 - (now - _lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCall = Date.now();
}

export async function snapshotSolPortfolio(address: string): Promise<void> {
  const cfg = getConfig();
  await rateLimit();

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cfg.solscan.api_key) headers['token'] = cfg.solscan.api_key;

    const base = cfg.solscan.api_key
      ? 'https://pro-api.solscan.io/v2.0'
      : 'https://api.solscan.io';

    const resp = await axios.get(`${base}/account/tokens`, {
      headers,
      params: { address, type: 'token' },
      timeout: 15000,
    });

    const tokens: SolscanToken[] = resp.data?.data ?? resp.data?.result ?? [];
    const now = Math.floor(Date.now() / 1000);

    for (const token of tokens) {
      if (!token.tokenAddress) continue;
      upsertSnapshot({
        wallet: address,
        chain: 'sol',
        token_address: token.tokenAddress,
        token_symbol: token.tokenSymbol ?? null,
        balance: token.tokenAmount?.amount ?? '1',
        snapshotted_at: now,
      });
    }

    // Native SOL
    upsertSnapshot({
      wallet: address,
      chain: 'sol',
      token_address: 'So11111111111111111111111111111111111111112',
      token_symbol: 'SOL',
      balance: '1',
      snapshotted_at: now,
    });

    logger.debug(`SOL portfolio snapshot: ${tokens.length} tokens for ${address}`);
  } catch (err) {
    logger.error(`SOL portfolio snapshot error for ${address}`, { err });
  }
}
