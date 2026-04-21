import cron from 'node-cron';
import { loadConfig, getConfig } from './config/config';
import { initDb } from './db/schema';
import { runDiscovery } from './discovery/discoveryRunner';
import { scoreTrader } from './analysis/scorer';
import { snapshotEthPortfolio } from './portfolio/ethPortfolio';
import { snapshotSolPortfolio } from './portfolio/solPortfolio';
import { qualifyWallet, disqualifyWallet, getQualifiedWallets, getWallet, purgeOldData } from './db/queries';
import { sendStartupMessage, sendWalletApprovalRequest, sendWalletApprovedConfirmation, initBotCallbackHandler } from './alerts/telegram';
import { startEthMonitor } from './monitor/ethMonitor';
import { initHeliusWebhook, addSolAddress } from './webhooks/heliusClient';
import { startWebhookServer } from './webhooks/server';
import logger from './logger';

async function onWalletApproved(address: string, chain: 'eth' | 'sol' | 'base'): Promise<void> {
  try {
    qualifyWallet(address);

    if (chain === 'eth' || chain === 'base') {
      await snapshotEthPortfolio(address, chain);
      // EVM monitoring handled by polling loop — no webhook registration needed
    } else {
      await snapshotSolPortfolio(address);
      await addSolAddress(address);
    }

    await sendWalletApprovedConfirmation(address, chain);
    logger.info(`Wallet approved and registered: ${address} (${chain.toUpperCase()})`);
  } catch (err) {
    logger.error('onWalletApproved failed', { err, address });
  }
}

async function onWalletSkipped(address: string): Promise<void> {
  disqualifyWallet(address);
  logger.info(`Wallet skipped: ${address}`);
}

async function runFullDiscovery(timeWindow: '7d' | '30d' = '30d'): Promise<void> {
  logger.info(`=== Starting discovery cycle (${timeWindow}) ===`);
  try {
    const traders = await runDiscovery(timeWindow);
    logger.info(`Scoring ${traders.length} discovered wallets...`);

    let proposedCount = 0;
    for (const trader of traders) {
      const score = await scoreTrader(trader);
      if (score) {
        await sendWalletApprovalRequest(score);
        proposedCount++;
      }
    }

    const qualified = getQualifiedWallets();
    logger.info(`=== Discovery complete — ${proposedCount} proposed for approval, ${qualified.length} total active wallets ===`);
  } catch (err) {
    logger.error('Discovery cycle failed', { err });
  }
}

async function main(): Promise<void> {
  loadConfig();
  const cfg = getConfig();

  initDb();
  logger.info('Database initialized');
  const purged = purgeOldData(30);
  const purgedTotal = purged.trades + purged.snapshots + purged.debugLogs + purged.wallets;
  if (purgedTotal > 0) {
    logger.info(`Purged data older than 30 days — trades:${purged.trades} snapshots:${purged.snapshots} logs:${purged.debugLogs} wallets:${purged.wallets}`);
  }

  // Start Telegram bot polling and register approval callbacks
  initBotCallbackHandler(onWalletApproved, onWalletSkipped);

  await initHeliusWebhook().catch(err =>
    logger.error(`Helius webhook init failed: ${err instanceof Error ? err.message : err}`)
  );

  // Start HTTP server for incoming webhook events
  startWebhookServer();

  // Send startup notification
  await sendStartupMessage();

  // Start Etherscan polling monitor for approved ETH and Base wallets
  startEthMonitor(cfg.monitor.eth_poll_interval_seconds, 'eth');
  startEthMonitor(cfg.monitor.base_poll_interval_seconds, 'base');

  // Run both discovery windows immediately on startup
  await runFullDiscovery('30d');
  await runFullDiscovery('7d');

  // Schedule 30d discovery on configured interval
  const discoveryHours = cfg.discovery.interval_hours;
  const discoveryCron = `0 */${discoveryHours} * * *`;
  logger.info(`Scheduling 30d discovery every ${discoveryHours}h (cron: ${discoveryCron})`);
  cron.schedule(discoveryCron, () => {
    runFullDiscovery('30d').catch(err => logger.error('Scheduled 30d discovery failed', { err }));
  });

  // Schedule weekly 7d discovery (Monday 09:00 by default, configurable via weekly_discovery_day)
  const weeklyDay = cfg.discovery.weekly_discovery_day;
  const weeklyCron = `0 9 * * ${weeklyDay}`;
  logger.info(`Scheduling weekly 7d discovery on day ${weeklyDay} (cron: ${weeklyCron})`);
  cron.schedule(weeklyCron, () => {
    runFullDiscovery('7d').catch(err => logger.error('Scheduled 7d discovery failed', { err }));
  });

  logger.info('Smart Wallet Tracker running. Press Ctrl+C to stop.');
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(`Fatal startup error: ${message}`, { stack });
  process.exit(1);
});
