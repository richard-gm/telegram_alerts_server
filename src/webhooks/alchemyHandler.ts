import { createHmac } from 'crypto';
import { Request, Response } from 'express';
import { getConfig } from '../config/config';
import { insertTrade, markAlerted, getWallet } from '../db/queries';
import { isNewPosition, recordNewPosition } from '../monitor/newPositionDetector';
import { sendTradeAlert } from '../alerts/telegram';
import logger from '../logger';

interface AlchemyActivity {
  fromAddress: string;
  toAddress: string;
  blockNum: string;
  hash: string;
  asset: string;
  category: string;
  rawContract: {
    address: string;
    decimals: number | null;
  };
  log: {
    blockNumber: string;
    transactionIndex: number;
    transactionHash: string;
    blockHash: string;
    address: string;
    topics: string[];
    data: string;
  };
}

interface AlchemyPayload {
  type: string;
  event: {
    network: string;
    activity: AlchemyActivity[];
  };
}

function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature === expected;
}

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'FRAX']);

export async function handleAlchemy(req: Request & { rawBody?: Buffer }, res: Response): Promise<void> {
  const cfg = getConfig();
  const sig = req.headers['x-alchemy-signature'] as string | undefined;

  if (cfg.alchemy.webhook_secret && !verifySignature(req.rawBody ?? Buffer.alloc(0), sig, cfg.alchemy.webhook_secret)) {
    logger.warn('Alchemy webhook signature mismatch — rejected');
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  res.status(200).json({ ok: true });

  const payload = req.body as AlchemyPayload;
  if (payload.type !== 'ADDRESS_ACTIVITY') return;

  const activity = payload.event?.activity ?? [];

  // Group ERC-20 transfers by tx hash and wallet
  const byHashAndWallet = new Map<string, AlchemyActivity[]>();
  for (const a of activity) {
    if (a.category !== 'erc20' && a.category !== 'token') continue;
    const key = `${a.hash}`;
    const list = byHashAndWallet.get(key) ?? [];
    list.push(a);
    byHashAndWallet.set(key, list);
  }

  for (const [hash, transfers] of byHashAndWallet.entries()) {
    // Collect all unique wallet addresses involved in this tx
    const addresses = new Set<string>();
    for (const t of transfers) {
      addresses.add(t.fromAddress.toLowerCase());
      addresses.add(t.toAddress.toLowerCase());
    }

    for (const walletAddr of addresses) {
      const wallet = getWallet(walletAddr);
      if (!wallet || wallet.qualified !== 1) continue;

      const outTransfers = transfers.filter(t => t.fromAddress.toLowerCase() === walletAddr);
      const inTransfers = transfers.filter(t => t.toAddress.toLowerCase() === walletAddr);
      if (outTransfers.length === 0 || inTransfers.length === 0) continue;

      const out = outTransfers[0];
      const into = inTransfers[0];
      const spendingStable = STABLES.has(out.asset.toUpperCase());
      const action: 'buy' | 'sell' = spendingStable ? 'buy' : 'sell';

      const tokenOut = into.rawContract.address?.toLowerCase() ?? into.asset;
      const tokenIn = out.rawContract.address?.toLowerCase() ?? out.asset;
      const targetToken = action === 'buy' ? tokenOut : tokenIn;
      const targetSymbol = action === 'buy' ? into.asset : out.asset;

      const blockNum = parseInt(out.blockNum, 16).toString();
      const newPos = isNewPosition(walletAddr, 'eth', tokenOut);

      const inserted = insertTrade({
        tx_hash: hash,
        wallet: walletAddr,
        chain: 'eth',
        token_in: tokenIn,
        token_out: tokenOut,
        token_symbol: targetSymbol,
        amount_usd: null,
        action,
        is_new_position: newPos ? 1 : 0,
        block_number: blockNum,
        timestamp: Math.floor(Date.now() / 1000),
      });

      if (!inserted) continue;

      if (newPos && action === 'buy') {
        recordNewPosition(walletAddr, 'eth', tokenOut, targetSymbol);
      }

      await sendTradeAlert({
        wallet: walletAddr,
        chain: 'eth',
        action,
        tokenSymbol: targetSymbol,
        txHash: hash,
        isNewPosition: newPos,
        winRate: wallet.win_rate,
        totalPnl: wallet.total_pnl,
        sourceToken: wallet.source_token,
      });
      markAlerted(hash);
    }
  }
}
