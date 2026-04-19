#!/bin/sh
set -e

# Generate config.yaml from environment variables at container startup.
# This keeps secrets out of the image — they are injected as env vars by Cloud Run.
cat > /app/config.yaml << YAML
telegram:
  bot_token: "${TELEGRAM_BOT_TOKEN}"
  chat_id: "${TELEGRAM_CHAT_ID}"

etherscan:
  api_key: "${ETHERSCAN_API_KEY:-}"

alchemy:
  api_key: "${ALCHEMY_API_KEY:-}"
  auth_token: "${ALCHEMY_AUTH_TOKEN:-}"
  webhook_id: "${ALCHEMY_WEBHOOK_ID:-}"
  webhook_secret: "${ALCHEMY_WEBHOOK_SECRET:-}"

helius:
  api_key: "${HELIUS_API_KEY:-}"
  webhook_id: "${HELIUS_WEBHOOK_ID:-}"
  webhook_secret: "${HELIUS_WEBHOOK_SECRET:-}"

webhook:
  port: ${WEBHOOK_PORT:-3000}
  public_url: "${WEBHOOK_PUBLIC_URL:-}"

solscan:
  api_key: "${SOLSCAN_API_KEY:-}"

coingecko:
  api_key: "${COINGECKO_API_KEY:-}"

scoring:
  min_win_rate: ${SCORING_MIN_WIN_RATE:-0.60}
  min_pnl_usd: ${SCORING_MIN_PNL_USD:-5000}
  min_trade_count: ${SCORING_MIN_TRADE_COUNT:-10}
  min_pnl_multiplier: ${SCORING_MIN_PNL_MULTIPLIER:-5.0}
  lookback_days: ${SCORING_LOOKBACK_DAYS:-30}

discovery:
  interval_hours: ${DISCOVERY_INTERVAL_HOURS:-6}
  coingecko_top_n: ${DISCOVERY_COINGECKO_TOP_N:-20}
  min_dex_volume_usd: ${DISCOVERY_MIN_DEX_VOLUME_USD:-50000}
  traders_per_token: ${DISCOVERY_TRADERS_PER_TOKEN:-10}
YAML

exec node dist/index.js
