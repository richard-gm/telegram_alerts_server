import TelegramBot from 'node-telegram-bot-api';
import { getConfig } from '../config/config';
import { WalletScore } from '../analysis/scorer';
import logger from '../logger';

let _bot: TelegramBot | null = null;

function getBot(): TelegramBot {
  if (!_bot) {
    const cfg = getConfig();
    if (!cfg.telegram.bot_token) throw new Error('Telegram bot_token not configured in config.yaml');
    // polling: true enables receiving callback_query events from inline keyboards
    _bot = new TelegramBot(cfg.telegram.bot_token, { polling: true });
    let _conflictLogged = false;
    _bot.on('polling_error', err => {
      const msg = err instanceof Error ? err.message : String(err);
      // 409 Conflict means another instance is already polling — log once then suppress
      if (msg.includes('409')) {
        if (!_conflictLogged) {
          logger.error('Telegram 409 Conflict: another bot instance is already running. Stop the other process.');
          _conflictLogged = true;
        }
        return;
      }
      // Transient network resets — bot auto-reconnects, no action needed
      if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED') || msg.includes('EFATAL')) {
        logger.warn('Telegram polling: connection reset, reconnecting...');
        return;
      }
      logger.error('Telegram polling error', { err });
    });
  }
  return _bot;
}

export interface TradeAlertParams {
  wallet: string;
  chain: 'eth' | 'sol' | 'base';
  action: 'buy' | 'sell';
  tokenSymbol: string;
  txHash: string;
  isNewPosition: boolean;
  winRate: number | null;
  totalPnl: number | null;
  sourceToken: string | null;
}

type ApproveCallback = (address: string, chain: 'eth' | 'sol' | 'base') => Promise<void>;
type SkipCallback = (address: string) => Promise<void>;

export function initBotCallbackHandler(onApprove: ApproveCallback, onSkip: SkipCallback): void {
  const bot = getBot();

  bot.on('callback_query', async (query) => {
    if (!query.data) return;

    const [action, chain, address] = query.data.split(':') as [string, 'eth' | 'sol' | 'base', string];

    try {
      if (action === 'approve') {
        await onApprove(address, chain);
      } else if (action === 'skip') {
        await onSkip(address);
        await bot.editMessageText(
          `❌ Skipped — ${shortAddress(address)} (${chain.toUpperCase()}) will not be monitored`,
          { chat_id: query.message!.chat.id, message_id: query.message!.message_id },
        );
      }
    } catch (err) {
      logger.error('Callback handler error', { err, data: query.data });
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  });
}

function explorerWalletUrl(chain: 'eth' | 'sol' | 'base', address: string): string {
  if (chain === 'base') return `https://basescan.org/address/${address}`;
  if (chain === 'eth') return `https://etherscan.io/address/${address}`;
  return `https://solscan.io/account/${address}`;
}

function explorerLinks(chain: 'eth' | 'sol' | 'base', wallet: string, txHash: string): { walletUrl: string; txUrl: string } {
  const txBase = chain === 'base' ? 'https://basescan.org/tx' : chain === 'eth' ? 'https://etherscan.io/tx' : 'https://solscan.io/tx';
  return {
    walletUrl: explorerWalletUrl(chain, wallet),
    txUrl: `${txBase}/${txHash}`,
  };
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatPnl(pnl: number | null): string {
  if (pnl === null) return 'N/A';
  const sign = pnl >= 0 ? '+' : '';
  if (Math.abs(pnl) >= 1_000_000) return `${sign}$${(pnl / 1_000_000).toFixed(1)}M`;
  if (Math.abs(pnl) >= 1_000) return `${sign}$${(pnl / 1_000).toFixed(0)}k`;
  return `${sign}$${pnl.toFixed(0)}`;
}

function buildMessage(params: TradeAlertParams): string {
  const { wallet, chain, action, tokenSymbol, txHash, isNewPosition, winRate, totalPnl, sourceToken } = params;
  const { walletUrl, txUrl } = explorerLinks(chain, wallet, txHash);
  const chainLabel = chain === 'eth' ? 'Ethereum' : chain === 'base' ? 'Base' : 'Solana';
  const actionEmoji = action === 'buy' ? '🟢' : '🔴';
  const actionLabel = action === 'buy' ? 'BUY' : 'SELL';

  if (isNewPosition) {
    return [
      `🚨 *Smart Wallet — NEW POSITION*`,
      ``,
      `📍 Chain: ${chainLabel}`,
      `👛 Wallet: [${shortAddress(wallet)}](${walletUrl})`,
      `${actionEmoji} Action: *${actionLabel} $${tokenSymbol}*`,
      winRate !== null ? `📊 Win rate: ${(winRate * 100).toFixed(0)}% | P&L: ${formatPnl(totalPnl)}` : '',
      sourceToken ? `🔍 Discovered via: $${sourceToken.toUpperCase()} trade` : '',
      ``,
      `🔗 [View Tx](${txUrl})`,
    ].filter(Boolean).join('\n');
  }

  return [
    `🔔 *Smart Wallet Trade*`,
    ``,
    `📍 Chain: ${chainLabel}`,
    `👛 Wallet: [${shortAddress(wallet)}](${walletUrl})`,
    `${actionEmoji} Action: *${actionLabel} $${tokenSymbol}*`,
    winRate !== null ? `📊 Win rate: ${(winRate * 100).toFixed(0)}% | P&L: ${formatPnl(totalPnl)}` : '',
    ``,
    `🔗 [View Tx](${txUrl})`,
  ].filter(Boolean).join('\n');
}

export async function sendTradeAlert(params: TradeAlertParams): Promise<void> {
  const cfg = getConfig();
  if (!cfg.telegram.bot_token || !cfg.telegram.chat_id) {
    logger.warn('Telegram not configured — skipping alert', { tx: params.txHash });
    return;
  }

  const message = buildMessage(params);

  try {
    await getBot().sendMessage(cfg.telegram.chat_id, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    logger.info(`Telegram alert sent: ${params.action.toUpperCase()} $${params.tokenSymbol} by ${shortAddress(params.wallet)}`);
  } catch (err) {
    logger.error('Telegram send failed', { err, tx: params.txHash });
  }
}

export async function sendWalletApprovalRequest(score: WalletScore): Promise<void> {
  const cfg = getConfig();
  if (!cfg.telegram.bot_token || !cfg.telegram.chat_id) return;

  const chain = score.chain.toUpperCase();
  const explorerBase = explorerWalletUrl(score.chain, score.address);

  const message = [
    `🔍 *New wallet found*`,
    ``,
    `📍 Chain: ${chain}`,
    `👛 Wallet: [${shortAddress(score.address)}](${explorerBase})`,
    `📊 Win rate: ${(score.win_rate * 100).toFixed(0)}% | P&L: ${formatPnl(score.total_pnl)}`,
    `🔢 Trades: ${score.trade_count} | Best: ${score.best_multiplier.toFixed(1)}x`,
    score.source_token ? `🔍 Discovered via: $${score.source_token.toUpperCase()} trade` : '',
  ].filter(Boolean).join('\n');

  try {
    await getBot().sendMessage(cfg.telegram.chat_id, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${score.chain}:${score.address}` },
          { text: '❌ Skip', callback_data: `skip:${score.chain}:${score.address}` },
        ]],
      },
    });
    logger.info(`Approval request sent for ${score.address} (${chain})`);
  } catch (err) {
    logger.error('Telegram approval request failed', { err, wallet: score.address });
  }
}

export async function sendWalletApprovedConfirmation(address: string, chain: 'eth' | 'sol' | 'base', messageId?: number, chatId?: string | number): Promise<void> {
  const cfg = getConfig();
  if (!cfg.telegram.bot_token || !cfg.telegram.chat_id) return;

  const bot = getBot();
  const text = `✅ *Now watching* [${shortAddress(address)}](${explorerWalletUrl(chain, address)}) \\(${chain.toUpperCase()}\\)`;

  try {
    if (messageId && chatId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
    } else {
      await bot.sendMessage(cfg.telegram.chat_id, text, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    logger.error('Telegram confirmation failed', { err });
  }
}

export async function sendStartupMessage(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.telegram.bot_token || !cfg.telegram.chat_id) return;

  try {
    await getBot().sendMessage(
      cfg.telegram.chat_id,
      `✅ *Smart Wallet Tracker started*\nListening for webhook events on port ${cfg.webhook.port}.\nNew wallet candidates will appear here for approval.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error('Telegram startup message failed', { err });
  }
}
