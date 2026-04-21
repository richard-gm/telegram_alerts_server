import axios from 'axios';
import { getConfig } from '../config/config';
import { getQualifiedWallets, getWallet, insertTrade, markAlerted, updateLastCheckedBlock, insertDebugLog } from '../db/queries';
import { fetchTokenTxs, etherscanRateLimit, EtherscanTokenTx, EvmChain, EVM_CHAIN_ID } from '../analysis/ethAnalyzer';
import { isNewPosition, recordNewPosition } from './newPositionDetector';
import { sendTradeAlert } from '../alerts/telegram';
import logger from '../logger';

// Only alert on trades that occurred within 5 minutes before the monitor started.
// This prevents flooding Telegram with all historical trades on first run.
let MONITOR_START_TS: Record<EvmChain, number> = { eth: 0, base: 0 };

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP']);

interface GroupedSwap {
  hash: string;
  blockNumber: string;
  timestamp: number;
  out: EtherscanTokenTx;
  into: EtherscanTokenTx;
}

function groupSwaps(address: string, txs: EtherscanTokenTx[]): GroupedSwap[] {
  const addr = address.toLowerCase();
  const byHash = new Map<string, EtherscanTokenTx[]>();

  for (const tx of txs) {
    const list = byHash.get(tx.hash) ?? [];
    list.push(tx);
    byHash.set(tx.hash, list);
  }

  const swaps: GroupedSwap[] = [];
  for (const [hash, transfers] of byHash.entries()) {
    const outTransfers = transfers.filter(t => t.from.toLowerCase() === addr);
    const inTransfers = transfers.filter(t => t.to.toLowerCase() === addr);
    if (outTransfers.length === 0 || inTransfers.length === 0) continue;
    swaps.push({
      hash,
      blockNumber: transfers[0].blockNumber,
      timestamp: parseInt(transfers[0].timeStamp),
      out: outTransfers[0],
      into: inTransfers[0],
    });
  }
  return swaps;
}

async function fetchCurrentBlock(chain: EvmChain): Promise<string | null> {
  const cfg = getConfig();
  const apiKey = cfg.etherscan.api_key || 'YourApiKeyToken';
  try {
    await etherscanRateLimit();
    const resp = await axios.get('https://api.etherscan.io/v2/api', {
      params: { chainid: EVM_CHAIN_ID[chain], module: 'proxy', action: 'eth_blockNumber', apikey: apiKey },
      timeout: 10000,
    });
    const hex = resp.data?.result as string;
    return hex ? parseInt(hex, 16).toString() : null;
  } catch {
    return null;
  }
}

async function pollWallet(address: string, lastBlock: string | null, chain: EvmChain): Promise<string | null> {
  const chainLabel = chain.toUpperCase();

  // First time seeing this wallet — anchor to current block without pulling history
  if (!lastBlock || lastBlock === '0') {
    const currentBlock = await fetchCurrentBlock(chain);
    if (currentBlock) {
      logger.info(`${chainLabel} monitor: anchoring ${address} at block ${currentBlock} — no historical scan`);
      return currentBlock;
    }
    return null;
  }

  const startBlock = (parseInt(lastBlock) + 1).toString();
  let txs: EtherscanTokenTx[];

  try {
    txs = await fetchTokenTxs(address, 0, startBlock, chain);
  } catch (err) {
    logger.debug(`${chainLabel} monitor: fetch failed for ${address}`, { err });
    return null;
  }

  if (txs.length === 0) return null;

  const swaps = groupSwaps(address, txs);
  const wallet = getWallet(address);
  if (!wallet) return null;

  let maxBlock = lastBlock;

  for (const swap of swaps) {
    if (!maxBlock || parseInt(swap.blockNumber) > parseInt(maxBlock)) {
      maxBlock = swap.blockNumber;
    }

    const spendingStable = STABLES.has(swap.out.tokenSymbol?.toUpperCase());
    const action: 'buy' | 'sell' = spendingStable ? 'buy' : 'sell';
    const tokenOut = swap.into.contractAddress.toLowerCase();
    const tokenIn = swap.out.contractAddress.toLowerCase();
    const targetSymbol = action === 'buy' ? swap.into.tokenSymbol : swap.out.tokenSymbol;
    const newPos = action === 'buy' && isNewPosition(address, chain, tokenOut);

    const inserted = insertTrade({
      tx_hash: swap.hash,
      wallet: address,
      chain,
      token_in: tokenIn,
      token_out: tokenOut,
      token_symbol: targetSymbol,
      amount_usd: null,
      action,
      is_new_position: newPos ? 1 : 0,
      block_number: swap.blockNumber,
      timestamp: swap.timestamp,
    });

    insertDebugLog(`${chain}_trade_detected`, address, {
      tx_hash: swap.hash, action, token: targetSymbol, block: swap.blockNumber,
      timestamp: swap.timestamp, inserted, new_position: newPos,
    });

    if (!inserted) continue;

    // Skip alerting on historical trades present before the monitor started
    if (swap.timestamp < MONITOR_START_TS[chain] - 300) {
      logger.debug(`${chainLabel} monitor: skipping historical trade ${swap.hash} (ts=${swap.timestamp})`);
      markAlerted(swap.hash);
      continue;
    }

    if (newPos) recordNewPosition(address, chain, tokenOut, targetSymbol);

    await sendTradeAlert({
      wallet: address,
      chain,
      action,
      tokenSymbol: targetSymbol,
      txHash: swap.hash,
      isNewPosition: newPos,
      winRate: wallet.win_rate,
      totalPnl: wallet.total_pnl,
      sourceToken: wallet.source_token,
    });
    insertDebugLog(`${chain}_alert_sent`, address, { tx_hash: swap.hash, action, token: targetSymbol });
    markAlerted(swap.hash);
  }

  return maxBlock !== lastBlock ? maxBlock : null;
}

export function startEthMonitor(intervalSeconds: number, chain: EvmChain = 'eth'): void {
  const chainLabel = chain.toUpperCase();
  MONITOR_START_TS[chain] = Math.floor(Date.now() / 1000);
  logger.info(`${chainLabel} monitor started — polling every ${intervalSeconds}s`);

  const poll = async () => {
    const wallets = getQualifiedWallets(chain);
    for (const wallet of wallets) {
      const newBlock = await pollWallet(wallet.address, wallet.last_checked_block, chain);
      if (newBlock) {
        updateLastCheckedBlock(wallet.address, newBlock);
        logger.debug(`${chainLabel} monitor: updated ${wallet.address} to block ${newBlock}`);
      }
    }
  };

  setInterval(() => {
    poll().catch(err => logger.error(`${chainLabel} monitor poll failed`, { err }));
  }, intervalSeconds * 1000);
}
