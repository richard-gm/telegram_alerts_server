// TODO: replace with DeBank Pro API for richer cross-chain portfolio data once profitable
import axios from 'axios';
import { getConfig } from '../config/config';
import { upsertSnapshot } from '../db/queries';
import { EvmChain, EVM_CHAIN_ID } from '../analysis/ethAnalyzer';
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

export async function snapshotEthPortfolio(address: string, chain: EvmChain = 'eth'): Promise<void> {
  const cfg = getConfig();
  await rateLimit();

  const apiKey = cfg.etherscan.api_key || 'YourApiKeyToken';

  try {
    const resp = await axios.get('https://api.etherscan.io/v2/api', {
      params: {
        chainid: EVM_CHAIN_ID[chain],
        module: 'account',
        action: 'tokenlist',
        address,
        apikey: apiKey,
      },
      timeout: 15000,
    });

    if (resp.data.status !== '1') {
      logger.debug(`${chain.toUpperCase()} portfolio: no tokens found for ${address}`);
      return;
    }

    const tokens: EtherscanTokenHolding[] = resp.data.result ?? [];
    const now = Math.floor(Date.now() / 1000);

    for (const token of tokens) {
      upsertSnapshot({
        wallet: address.toLowerCase(),
        chain,
        token_address: token.contractAddress.toLowerCase(),
        token_symbol: token.tokenSymbol,
        balance: '1',
        snapshotted_at: now,
      });
    }

    // Always include native ETH (used on both Ethereum and Base)
    upsertSnapshot({
      wallet: address.toLowerCase(),
      chain,
      token_address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      token_symbol: 'ETH',
      balance: '1',
      snapshotted_at: now,
    });

    logger.debug(`${chain.toUpperCase()} portfolio snapshot: ${tokens.length} tokens for ${address}`);
  } catch (err) {
    logger.error(`${chain.toUpperCase()} portfolio snapshot error for ${address}`, { err });
  }
}
