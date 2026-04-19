import axios from 'axios';
import { getConfig, patchConfig } from '../config/config';
import { getQualifiedWallets } from '../db/queries';
import logger from '../logger';

const BASE = 'https://api.helius.xyz';

function apiUrl(path: string): string {
  return `${BASE}${path}?api-key=${getConfig().helius.api_key}`;
}

export async function initHeliusWebhook(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.helius.api_key) {
    logger.warn('Helius api_key not set — skipping Helius webhook init');
    return;
  }
  if (!cfg.webhook.public_url) {
    logger.warn('webhook.public_url not set — cannot register Helius webhook');
    return;
  }

  let webhookId = cfg.helius.webhook_id;

  if (webhookId) {
    try {
      await axios.get(apiUrl(`/v0/webhooks/${webhookId}`));
      logger.info(`Helius webhook ${webhookId} already exists`);
    } catch {
      logger.warn(`Helius webhook ${webhookId} not found — creating new one`);
      webhookId = '';
    }
  }

  if (!webhookId) {
    const secret = cfg.helius.webhook_secret || generateSecret();
    const resp = await axios.post(apiUrl('/v0/webhooks'), {
      webhookURL: `${cfg.webhook.public_url}/webhook/helius`,
      transactionTypes: ['SWAP'],
      accountAddresses: [],
      webhookType: 'enhanced',
      authHeader: secret,
    });
    webhookId = resp.data.webhookID as string;
    patchConfig({ helius: { ...cfg.helius, webhook_id: webhookId, webhook_secret: secret } });
    logger.info(`Helius webhook created: ${webhookId}`);
  }

  // Sync all existing qualified SOL wallets
  const wallets = getQualifiedWallets('sol');
  if (wallets.length > 0) {
    await bulkAddSolAddresses(webhookId, wallets.map(w => w.address));
    logger.info(`Helius: synced ${wallets.length} existing SOL wallets`);
  }
}

async function bulkAddSolAddresses(webhookId: string, newAddresses: string[]): Promise<void> {
  // Helius PUT replaces the full address list, so fetch existing first
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
  if (!cfg.helius.webhook_id) {
    logger.warn('Helius webhook_id not set — cannot add address');
    return;
  }
  try {
    await bulkAddSolAddresses(cfg.helius.webhook_id, [address]);
    logger.info(`Helius: added ${address} to webhook`);
  } catch (err) {
    logger.error('Helius addSolAddress failed', { err, address });
  }
}

function generateSecret(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
