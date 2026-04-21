import { randomBytes } from 'crypto';
import axios from 'axios';
import { getConfig, patchConfig } from '../config/config';
import { getQualifiedWallets } from '../db/queries';
import logger from '../logger';

const BASE = 'https://api.helius.xyz';

function apiUrl(path: string): string {
  return `${BASE}${path}?api-key=${getConfig().helius.api_key}`;
}

async function createWebhook(firstAddress: string): Promise<string> {
  const cfg = getConfig();
  const secret = cfg.helius.webhook_secret || generateSecret();
  let resp;
  try {
    resp = await axios.post(apiUrl('/v0/webhooks'), {
      webhookURL: `${cfg.webhook.public_url}/webhook/helius`,
      transactionTypes: ['Any'],
      accountAddresses: [firstAddress],
      webhookType: 'enhanced',
      authHeader: secret,
    });
  } catch (err) {
    const body = (err as { response?: { data?: unknown } })?.response?.data;
    throw new Error(`Helius webhook create failed: ${JSON.stringify(body)}`);
  }
  const webhookId = (resp.data.webhookID ?? resp.data.id) as string;
  patchConfig({ helius: { ...cfg.helius, webhook_id: webhookId, webhook_secret: secret } });
  logger.info(`Helius webhook created: ${webhookId}`);
  return webhookId;
}

export async function initHeliusWebhook(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.helius.api_key) {
    logger.warn('Helius api_key not set — skipping Helius webhook init');
    return;
  }

  const webhookId = cfg.helius.webhook_id;
  if (!webhookId) {
    // No webhook yet — will be created lazily when first SOL wallet is approved
    logger.info('Helius webhook not yet created — will be created on first SOL wallet approval');
    return;
  }

  // Verify the existing webhook is still alive
  try {
    await axios.get(apiUrl(`/v0/webhooks/${webhookId}`));
    logger.info(`Helius webhook ${webhookId} verified`);

    // Sync any qualified SOL wallets that may have been added while webhook was offline
    const wallets = getQualifiedWallets('sol');
    if (wallets.length > 0) {
      await bulkAddSolAddresses(webhookId, wallets.map(w => w.address));
      logger.info(`Helius: synced ${wallets.length} existing SOL wallets`);
    }
  } catch {
    logger.warn(`Helius webhook ${webhookId} not found — will recreate on next SOL wallet approval`);
    patchConfig({ helius: { ...cfg.helius, webhook_id: '' } });
  }
}

async function bulkAddSolAddresses(webhookId: string, newAddresses: string[]): Promise<void> {
  const resp = await axios.get(apiUrl(`/v0/webhooks/${webhookId}`));
  const existing: string[] = resp.data.accountAddresses ?? [];
  const merged = Array.from(new Set([...existing, ...newAddresses]));

  await axios.put(apiUrl(`/v0/webhooks/${webhookId}`), {
    webhookURL: resp.data.webhookURL,
    transactionTypes: resp.data.transactionTypes,
    accountAddresses: merged,
    webhookType: resp.data.webhookType,
    authHeader: resp.data.authHeader,
  });
}

export async function addSolAddress(address: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg.helius.api_key) {
    logger.warn('Helius api_key not set — cannot register SOL wallet');
    return;
  }
  try {
    let webhookId = cfg.helius.webhook_id;
    if (!webhookId) {
      // Create webhook with this first address
      webhookId = await createWebhook(address);
    } else {
      await bulkAddSolAddresses(webhookId, [address]);
    }
    logger.info(`Helius: registered ${address}`);
  } catch (err) {
    logger.error('Helius addSolAddress failed', { err, address });
  }
}

function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
