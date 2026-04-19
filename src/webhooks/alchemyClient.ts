import axios from 'axios';
import { getConfig, patchConfig } from '../config/config';
import { getQualifiedWallets } from '../db/queries';
import logger from '../logger';

const BASE = 'https://dashboard.alchemy.com/api';

function headers(): Record<string, string> {
  return { 'X-Alchemy-Token': getConfig().alchemy.auth_token };
}

async function findExistingWebhook(webhookId: string): Promise<boolean> {
  try {
    const resp = await axios.get(`${BASE}/team-webhooks`, { headers: headers() });
    const webhooks: Array<{ id: string }> = resp.data?.data ?? [];
    return webhooks.some(w => w.id === webhookId);
  } catch {
    return false;
  }
}

export async function initAlchemyWebhook(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.alchemy.auth_token) {
    logger.warn('Alchemy auth_token not set — skipping Alchemy webhook init');
    return;
  }
  if (!cfg.webhook.public_url) {
    logger.warn('webhook.public_url not set — cannot register Alchemy webhook');
    return;
  }

  let webhookId = cfg.alchemy.webhook_id;

  if (webhookId) {
    const exists = await findExistingWebhook(webhookId);
    if (exists) {
      logger.info(`Alchemy webhook ${webhookId} already exists`);
    } else {
      logger.warn(`Alchemy webhook ${webhookId} not found — creating new one`);
      webhookId = '';
    }
  }

  if (!webhookId) {
    const resp = await axios.post(
      `${BASE}/create-webhook`,
      {
        network: 'ETH_MAINNET',
        webhook_type: 'ADDRESS_ACTIVITY',
        webhook_url: `${cfg.webhook.public_url}/webhook/alchemy`,
        addresses: [],
      },
      { headers: headers() },
    );
    webhookId = resp.data.data.id as string;
    const secret = resp.data.data.signing_key as string;
    patchConfig({ alchemy: { ...cfg.alchemy, webhook_id: webhookId, webhook_secret: secret } });
    logger.info(`Alchemy webhook created: ${webhookId}`);
    logger.info(`Alchemy webhook secret:  ${secret}`);
  }

  // Sync all existing qualified ETH wallets
  const wallets = getQualifiedWallets('eth');
  if (wallets.length > 0) {
    await bulkAddEthAddresses(webhookId, wallets.map(w => w.address));
    logger.info(`Alchemy: synced ${wallets.length} existing ETH wallets`);
  }
}

async function bulkAddEthAddresses(webhookId: string, addresses: string[]): Promise<void> {
  await axios.patch(
    `${BASE}/update-webhook-addresses`,
    { webhook_id: webhookId, addresses_to_add: addresses, addresses_to_remove: [] },
    { headers: headers() },
  );
}

export async function addEthAddress(address: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg.alchemy.webhook_id) {
    logger.warn('Alchemy webhook_id not set — cannot add address');
    return;
  }
  try {
    await bulkAddEthAddresses(cfg.alchemy.webhook_id, [address]);
    logger.info(`Alchemy: added ${address} to webhook`);
  } catch (err) {
    logger.error('Alchemy addEthAddress failed', { err, address });
  }
}
