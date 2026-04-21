import { Router, Request, Response } from 'express';
import {
  getAllWallets,
  getPendingWallets,
  getRecentTrades,
  getWallet,
  qualifyWallet,
  disqualifyWallet,
  pauseWallet,
  unpauseWallet,
  removeWallet,
  upsertWallet,
} from '../db/queries';
import { snapshotEthPortfolio } from '../portfolio/ethPortfolio';
import { snapshotSolPortfolio } from '../portfolio/solPortfolio';
import { addSolAddress } from '../webhooks/heliusClient';
import { scoreEthWallet } from '../analysis/ethAnalyzer';
import { scoreSolWallet } from '../analysis/solAnalyzer';
import logger from '../logger';

const router = Router();

router.get('/wallets', (_req: Request, res: Response) => {
  res.json(getAllWallets());
});

router.get('/wallets/pending', (_req: Request, res: Response) => {
  res.json(getPendingWallets());
});

router.post('/wallets/analyze', async (req: Request, res: Response) => {
  const { address, chain: chainOverride } = req.body as { address?: string; chain?: string };
  if (!address?.trim()) {
    res.status(400).json({ error: 'address required' });
    return;
  }
  const validChains = ['eth', 'base', 'sol'] as const;
  type ValidChain = typeof validChains[number];
  // Base addresses are also 0x-prefixed — callers must pass chain:'base' explicitly
  const defaultChain: ValidChain = address.startsWith('0x') ? 'eth' : 'sol';
  const chain: ValidChain = validChains.includes(chainOverride as ValidChain) ? chainOverride as ValidChain : defaultChain;
  try {
    const score = chain === 'eth' || chain === 'base'
      ? await scoreEthWallet(address, chain)
      : await scoreSolWallet(address);
    if (!score) {
      res.status(422).json({ error: 'insufficient trade data to score this wallet' });
      return;
    }
    upsertWallet({
      address: score.address,
      chain: score.chain,
      win_rate: score.win_rate,
      total_pnl: score.total_pnl,
      trade_count: score.trade_count,
      last_active: score.last_active,
      discovered_at: Math.floor(Date.now() / 1000),
      source_token: null,
    });
    res.json(score);
  } catch (err) {
    logger.error('API analyze wallet failed', { err, address });
    res.status(500).json({ error: 'analysis failed' });
  }
});

router.patch('/wallets/:address', async (req: Request<{ address: string }>, res: Response) => {
  const address = req.params.address;
  const { action } = req.body as { action?: string };
  if (!action) {
    res.status(400).json({ error: 'action required' });
    return;
  }
  try {
    if (action === 'approve') {
      const wallet = getWallet(address);
      if (!wallet) { res.status(404).json({ error: 'wallet not found' }); return; }
      qualifyWallet(address);
      if (wallet.chain === 'eth' || wallet.chain === 'base') {
        await snapshotEthPortfolio(address, wallet.chain);
        // EVM monitoring via Etherscan polling — no webhook registration needed
      } else {
        await snapshotSolPortfolio(address);
        await addSolAddress(address);
      }
    } else if (action === 'skip') {
      disqualifyWallet(address);
    } else if (action === 'pause') {
      pauseWallet(address);
    } else if (action === 'unpause') {
      unpauseWallet(address);
    } else {
      res.status(400).json({ error: `unknown action: ${action}` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('API wallet action failed', { err, address, action });
    res.status(500).json({ error: 'internal error' });
  }
});

router.delete('/wallets/:address', (req: Request<{ address: string }>, res: Response) => {
  removeWallet(req.params.address);
  res.json({ ok: true });
});

router.get('/trades', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const chain = req.query.chain as 'eth' | 'sol' | undefined;
  res.json(getRecentTrades(limit, chain));
});

export default router;
