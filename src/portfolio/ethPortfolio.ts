// TODO: replace with DeBank Pro API for richer cross-chain portfolio data once profitable
import axios from 'axios';
import { getConfig } from '../config/config';
import { upsertSnapshot } from '../db/queries';
import logger from '../logger';

interface EtherscanTokenHolding {
  contractAddress: string;
  tokenSymbol: string;
  tokenDecimal: string;
  tokenName: string;
}

let _lastCall = 0;
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = 220 - (now - _lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCall = Date.now();
}

export async function snapshotEthPortfolio(address: string): Promise<void> {
  const cfg = getConfig();
  await rateLimit();

  try {
    // Fetch ERC-20 token list for the address
    const resp = await axios.get('https://api.etherscan.io/api', {
      params: {
        module: 'account',
        action: 'tokenlist',   // returns list of tokens with non-zero balance
        address,
        apikey: cfg.etherscan.api_key || 'YourApiKeyToken',
      },
      timeout: 15000,
    });

    if (resp.data.status !== '1') {
      logger.debug(`ETH portfolio: no tokens found for ${address}`);
      return;
    }

    const tokens: EtherscanTokenHolding[] = resp.data.result ?? [];
    const now = Math.floor(Date.now() / 1000);

    for (const token of tokens) {
      upsertSnapshot({
        wallet: address.toLowerCase(),
        chain: 'eth',
        token_address: token.contractAddress.toLowerCase(),
        token_symbol: token.tokenSymbol,
        balance: '1', // presence is what matters — DeBank Pro would give exact balance
        snapshotted_at: now,
      });
    }

    // Always include native ETH
    upsertSnapshot({
      wallet: address.toLowerCase(),
      chain: 'eth',
      token_address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      token_symbol: 'ETH',
      balance: '1',
      snapshotted_at: now,
    });

    logger.debug(`ETH portfolio snapshot: ${tokens.length} tokens for ${address}`);
  } catch (err) {
    logger.error(`ETH portfolio snapshot error for ${address}`, { err });
  }
}
