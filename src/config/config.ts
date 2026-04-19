import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

const ConfigSchema = z.object({
  telegram: z.object({
    bot_token: z.string(),
    chat_id: z.string(),
  }),
  etherscan: z.object({
    api_key: z.string().default(''),
  }),
  solscan: z.object({
    api_key: z.string().default(''),
  }),
  coingecko: z.object({
    api_key: z.string().default(''),
  }),
  alchemy: z.object({
    api_key: z.string().default(''),
    auth_token: z.string().default(''),
    webhook_id: z.string().default(''),
    webhook_secret: z.string().default(''),
  }).default({}),
  helius: z.object({
    api_key: z.string().default(''),
    webhook_id: z.string().default(''),
    webhook_secret: z.string().default(''),
  }).default({}),
  webhook: z.object({
    port: z.number().int().default(3000),
    public_url: z.string().default(''),
  }).default({}),
  scoring: z.object({
    min_win_rate: z.number().min(0).max(1).default(0.6),
    min_pnl_usd: z.number().default(5000),
    min_trade_count: z.number().int().default(10),
    min_pnl_multiplier: z.number().default(5.0),
    lookback_days: z.number().int().default(30),
  }),
  discovery: z.object({
    interval_hours: z.number().default(6),
    coingecko_top_n: z.number().int().default(20),
    min_dex_volume_usd: z.number().default(50000),
    traders_per_token: z.number().int().default(10),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;
let _configPath: string | null = null;

export function loadConfig(configPath?: string): Config {
  const filePath = configPath ?? path.join(process.cwd(), 'config.yaml');
  _configPath = filePath;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config.yaml:\n${result.error.toString()}`);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

export function patchConfig(patch: Partial<Config>): void {
  if (!_config || !_configPath) throw new Error('Config not loaded');
  _config = { ..._config, ...patch } as Config;

  // Write back to yaml so IDs/secrets persist across restarts
  const raw = fs.readFileSync(_configPath, 'utf-8');
  const doc = yaml.load(raw) as Record<string, unknown>;

  for (const [section, values] of Object.entries(patch)) {
    if (typeof values === 'object' && values !== null) {
      doc[section] = { ...(doc[section] as object ?? {}), ...(values as object) };
    } else {
      doc[section] = values;
    }
  }

  fs.writeFileSync(_configPath, yaml.dump(doc, { lineWidth: 120 }), 'utf-8');
}
