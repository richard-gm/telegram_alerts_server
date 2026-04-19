import { Request, Response } from 'express';
import { getConfig } from '../config/config';
import { insertTrade, markAlerted, getWallet } from '../db/queries';
import { isNewPosition, recordNewPosition } from '../monitor/newPositionDetector';
import { sendTradeAlert } from '../alerts/telegram';
import logger from '../logger';

interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
  tokenStandard?: string;
}

interface HeliusTransaction {
  signature: string;
  slot: number;
  timestamp: number;
  type: string;
  source: string;
  tokenTransfers: HeliusTokenTransfer[];
  transactionError: unknown | null;
}

const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', // UXD
]);

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'USDH', 'UXD']);

export async function handleHelius(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();

  // Verify auth header if secret is configured
  if (cfg.helius.webhook_secret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== cfg.helius.webhook_secret) {
      logger.warn('Helius webhook auth mismatch — rejected');
      res.status(401).json({ error: 'invalid auth' });
      return;
    }
  }

  res.status(200).json({ ok: true });

  const transactions: HeliusTransaction[] = Array.isArray(req.body) ? req.body : [req.body];

  for (const tx of transactions) {
    if (tx.transactionError) continue;
    if (tx.type !== 'SWAP') continue;

    const transfers = tx.tokenTransfers ?? [];
    if (transfers.length < 2) continue;

    // Identify the wallet involved — look for a qualified wallet in the transfers
    const involvedAddresses = new Set([
      ...transfers.map(t => t.fromUserAccount),
      ...transfers.map(t => t.toUserAccount),
    ]);

    for (const walletAddr of involvedAddresses) {
      const wallet = getWallet(walletAddr);
      if (!wallet || wallet.qualified !== 1) continue;

      const outTransfers = transfers.filter(t => t.fromUserAccount === walletAddr);
      const inTransfers = transfers.filter(t => t.toUserAccount === walletAddr);
      if (outTransfers.length === 0 || inTransfers.length === 0) continue;

      const out = outTransfers[0];
      const into = inTransfers[0];

      const spendingStable = STABLES.has(out.mint) || STABLE_SYMBOLS.has(out.mint.toUpperCase());
      const action: 'buy' | 'sell' = spendingStable ? 'buy' : 'sell';

      const tokenOut = into.mint;
      const tokenIn = out.mint;
      const targetToken = action === 'buy' ? tokenOut : tokenIn;

      const newPos = action === 'buy' ? isNewPosition(walletAddr, 'sol', targetToken) : false;

      const inserted = insertTrade({
        tx_hash: tx.signature,
        wallet: walletAddr,
        chain: 'sol',
        token_in: tokenIn,
        token_out: tokenOut,
        token_symbol: targetToken.slice(0, 8), // use mint address prefix as fallback symbol
        amount_usd: null,
        action,
        is_new_position: newPos ? 1 : 0,
        block_number: String(tx.slot),
        timestamp: tx.timestamp,
      });

      if (!inserted) continue;

      if (newPos) {
        recordNewPosition(walletAddr, 'sol', targetToken, null);
      }

      await sendTradeAlert({
        wallet: walletAddr,
        chain: 'sol',
        action,
        tokenSymbol: targetToken.slice(0, 8),
        txHash: tx.signature,
        isNewPosition: newPos,
        winRate: wallet.win_rate,
        totalPnl: wallet.total_pnl,
        sourceToken: wallet.source_token,
      });
      markAlerted(tx.signature);
    }
  }
}
