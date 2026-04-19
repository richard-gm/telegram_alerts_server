import cron from 'node-cron';
import { loadConfig, getConfig } from './config/config';
import { initDb } from './db/schema';
import { runDiscovery } from './discovery/discoveryRunner';
import { scoreTrader } from './analysis/scorer';
import { snapshotEthPortfolio } from './portfolio/ethPortfolio';
import { snapshotSolPortfolio } from './portfolio/solPortfolio';
import { qualifyWallet, disqualifyWallet, getQualifiedWallets, getWallet } from './db/queries';
import { sendStartupMessage, sendWalletApprovalRequest, sendWalletApprovedConfirmation, initBotCallbackHandler } from './alerts/telegram';
import { initAlchemyWebhook, addEthAddress } from './webhooks/alchemyClient';
import { initHeliusWebhook, addSolAddress } from './webhooks/heliusClient';
import { startWebhookServer } from './webhooks/server';
import logger from './logger';

async function onWalletApproved(address: string, chain: 'eth' | 'sol'): Promise<void> {
  try {
    qualifyWallet(address);

    if (chain === 'eth') {
      await snapshotEthPortfolio(address);
      await addEthAddress(address);
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

async function runFullDiscovery(): Promise<void> {
  logger.info('=== Starting discovery cycle ===');
  try {
    const traders = await runDiscovery();
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

  // Start Telegram bot polling and register approval callbacks
  initBotCallbackHandler(onWalletApproved, onWalletSkipped);

  // Register/verify webhooks — non-fatal: app still runs discovery if providers are unreachable
  await initAlchemyWebhook().catch(err =>
    logger.error(`Alchemy webhook init failed: ${err instanceof Error ? err.message : err}`)
  );
  await initHeliusWebhook().catch(err =>
    logger.error(`Helius webhook init failed: ${err instanceof Error ? err.message : err}`)
  );

  // Start HTTP server for incoming webhook events
  startWebhookServer();

  // Send startup notification
  await sendStartupMessage();

  // Run an immediate discovery on startup
  await runFullDiscovery();

  // Schedule discovery on configured interval
  const discoveryHours = cfg.discovery.interval_hours;
  const discoveryCron = `0 */${discoveryHours} * * *`;
  logger.info(`Scheduling discovery every ${discoveryHours}h (cron: ${discoveryCron})`);
  cron.schedule(discoveryCron, () => {
    runFullDiscovery().catch(err => logger.error('Scheduled discovery failed', { err }));
  });

  logger.info('Smart Wallet Tracker running. Press Ctrl+C to stop.');
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(`Fatal startup error: ${message}`, { stack });
  process.exit(1);
});
