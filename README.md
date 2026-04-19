# Smart Money Wallet Tracker

Automates the workflow: CoinGecko → DEX Screener → wallet analysis → Telegram approval → real-time webhook alerts.

**How it works:**
1. Discovery runs every N hours — finds top traders from CoinGecko gainers via DEX Screener
2. Each wallet that passes scoring sends an approval card to Telegram with **Approve / Skip** buttons
3. Approved wallets are registered with Alchemy (ETH) or Helius (SOL) webhooks
4. When a watched wallet makes a swap, the provider calls your server instantly — no polling

---

## Quick Start

Here is the exact order to get everything running from scratch.

### Step 1 — Telegram bot

You need a bot that can send you alerts and receive your Approve/Skip button taps.

1. Open Telegram, search **@BotFather**, send `/newbot`
2. Follow the prompts — pick any name and username
3. BotFather gives you a token like `123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ` → paste into `telegram.bot_token`

**Get your `chat_id` (where alerts are sent):**

*Personal chat — alerts go directly to you:*
1. Search **@userinfobot** in Telegram, send it any message
2. It replies with your numeric ID (e.g. `477645841`) → paste into `telegram.chat_id`

*Group chat — alerts go to a group:*
1. Add your bot to the group (search by username → Add to Group)
2. Send any message in the group, then open this URL in your browser (replace `<TOKEN>`):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Find `"chat":{"id":` in the response — it is a negative number like `-1001234567890` → that is your `chat_id`

> If `getUpdates` returns an empty result, send another message in the group and reload the URL.

---

### Step 2 — Etherscan API key

Used during wallet scoring (not for live monitoring). Free.

1. Go to [etherscan.io](https://etherscan.io) → create an account
2. Click your profile → **API Keys** → **+ Add** → name it anything → copy the key
3. Paste into `etherscan.api_key`

---

### Step 3 — Alchemy (ETH live monitoring)

Alchemy fires a webhook the instant a watched ETH wallet makes a transfer. Free tier covers this easily.

**Get `alchemy.api_key`:**
1. Sign up at [alchemy.com](https://alchemy.com)
2. Click **+ Create new app** → choose **Ethereum** → **Ethereum Mainnet** → give it any name → Create
3. On the app page, click **API Key** (top right) → copy the key that starts with a long alphanumeric string
4. Paste into `alchemy.api_key`

**Get `alchemy.auth_token`:**

This is a *different* key from the API key. It is used to manage webhooks (create, add addresses).

1. In the Alchemy dashboard, click your **account avatar** (top right) → **Account Settings**
2. Scroll to **Auth Token** — copy it (starts with something like `sk_...` or a UUID-style string)
3. Paste into `alchemy.auth_token`

> Leave `alchemy.webhook_id` and `alchemy.webhook_secret` blank — they are written automatically the first time you start the app.

---

### Step 4 — Helius (SOL live monitoring)

Helius fires a webhook the instant a watched SOL wallet makes a swap. Free tier: 1M credits/month, no credit card.

**Get `helius.api_key`:**
1. Sign up at [helius.dev](https://helius.dev)
2. You land on the dashboard — your API key is displayed immediately (e.g. `a1b2c3d4-...`)
3. Paste into `helius.api_key`

**Set `helius.webhook_secret`:**

This is not a key you retrieve — it is a password *you invent* and set here. Helius will include it in every webhook call it sends, and the app checks it to reject fake requests.

- Pick any random string, e.g. `solana-tracker-secret-42`
- Paste into `helius.webhook_secret`

> Leave `helius.webhook_id` blank — it is written automatically on first run.

---

### Step 5 — ngrok public URL (development only)

Alchemy and Helius need to reach your server over the internet. In production you deploy on a server with a real domain. For local development, ngrok creates a temporary public tunnel to your laptop.

**Install ngrok:**
```bash
brew install ngrok         # macOS
# or download from https://ngrok.com/download
```

**Sign up** (free) at [ngrok.com](https://ngrok.com) — you need an account to get a stable tunnel.

**Authenticate ngrok once:**
```bash
ngrok config add-authtoken <YOUR_NGROK_TOKEN>
# Your token is at: https://dashboard.ngrok.com/get-started/your-authtoken
```

**Start the tunnel** (run this in a separate terminal before starting the app):
```bash
ngrok http 3000
```

You will see output like:
```
Forwarding   https://a1b2c3d4.ngrok.io -> http://localhost:3000
```

Copy the `https://...ngrok.io` URL and paste into `webhook.public_url`.

> **Important:** ngrok generates a new URL every time you restart it (free tier). When the URL changes, delete the old `alchemy.webhook_id` and `helius.webhook_id` from `config.yaml` and restart the app — it will re-register the webhooks with the new URL automatically.

**Production alternative:** deploy on any VPS (DigitalOcean, Hetzner, etc.) and set `webhook.public_url` to your server's HTTPS domain. The `webhook.id` fields stay stable permanently.

---

### Step 6 — Fill in `config.yaml` and run

Your `config.yaml` should look like this before first run:

```yaml
telegram:
  bot_token: "123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ"
  chat_id: "477645841"

etherscan:
  api_key: "YOURKEYHERE"

alchemy:
  api_key: "your-alchemy-api-key"
  auth_token: "your-alchemy-auth-token"
  webhook_id: ""        # leave blank
  webhook_secret: ""    # leave blank

helius:
  api_key: "your-helius-api-key"
  webhook_id: ""        # leave blank
  webhook_secret: "solana-tracker-secret-42"

webhook:
  port: 3000
  public_url: "https://a1b2c3d4.ngrok.io"   # your ngrok URL
```

Then start the app:
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20
npm run dev
```

On first run you will see:
```
Alchemy webhook created: wh_xxxxxxxxxxxxxxxxxx
Helius webhook created: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Webhook server listening on port 3000
Smart Wallet Tracker running. Press Ctrl+C to stop.
```

The `webhook_id` fields are now written into your `config.yaml` automatically — do not edit them.

Discovery runs immediately. When a wallet passes scoring, a card appears in Telegram:

```
🔍 New wallet found
Chain: ETH
Wallet: 0xABCD...1234
Win rate: 72% | P&L: +$18k
Trades: 34 | Best: 12.3x
Discovered via: $PEPE trade

[✅ Approve]  [❌ Skip]
```

Tap **Approve** — the wallet is registered and monitoring starts within seconds. Tap **Skip** — the wallet is ignored and won't be proposed again.

---

## Commands

```bash
npm run dev        # Run with hot-reload (development)
npm run build      # Compile TypeScript
npm start          # Run compiled output (production)
npm run typecheck  # Type-check without emitting
```

---

## Deploying to Google Cloud Run

Push to `main` and GitHub Actions builds the Docker image, pushes it to Artifact Registry, and deploys to Cloud Run automatically. Follow this one-time setup first.

### GCP one-time setup

Run these once from your local machine (replace `PROJECT_ID`, `REGION`, `BUCKET_NAME`):

```bash
# Enable required APIs
gcloud services enable run.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  --project=PROJECT_ID

# Create Docker image registry
gcloud artifacts repositories create wallet-tracker \
  --repository-format=docker \
  --location=REGION \
  --project=PROJECT_ID

# Create GCS bucket — SQLite database is stored here (survives container restarts)
gsutil mb -l REGION gs://BUCKET_NAME

# Service account that GitHub Actions uses to build and deploy
gcloud iam service-accounts create github-actions --project=PROJECT_ID
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# Service account that the Cloud Run container runs as (needs GCS access for DB mount)
gcloud iam service-accounts create wallet-tracker-run --project=PROJECT_ID
gsutil iam ch \
  serviceAccount:wallet-tracker-run@PROJECT_ID.iam.gserviceaccount.com:roles/storage.objectAdmin \
  gs://BUCKET_NAME

# Download GitHub Actions SA key — you'll paste this into a GitHub secret
gcloud iam service-accounts keys create /tmp/gha-key.json \
  --iam-account=github-actions@PROJECT_ID.iam.gserviceaccount.com
cat /tmp/gha-key.json   # copy the entire JSON output
```

### GitHub repository secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret** and add each of these:

| Secret | Value |
|--------|-------|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `GCP_REGION` | e.g. `us-central1` |
| `GCP_SA_KEY` | Full JSON from `cat /tmp/gha-key.json` above |
| `GCP_RUN_SA_EMAIL` | `wallet-tracker-run@PROJECT_ID.iam.gserviceaccount.com` |
| `GCS_BUCKET_NAME` | Your GCS bucket name |
| `WEBHOOK_PUBLIC_URL` | Cloud Run service URL — **set this after the first deploy** (see below) |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID |
| `ETHERSCAN_API_KEY` | Etherscan key |
| `ALCHEMY_API_KEY` | Alchemy app API key |
| `ALCHEMY_AUTH_TOKEN` | Alchemy account auth token |
| `ALCHEMY_WEBHOOK_ID` | Leave blank on first deploy — fill after (see below) |
| `ALCHEMY_WEBHOOK_SECRET` | Leave blank on first deploy — fill after (see below) |
| `HELIUS_API_KEY` | Helius API key |
| `HELIUS_WEBHOOK_ID` | Leave blank on first deploy — fill after (see below) |
| `HELIUS_WEBHOOK_SECRET` | Same value as in your local `config.yaml` |
| `SOLSCAN_API_KEY` | Optional |
| `COINGECKO_API_KEY` | Optional |

### First deploy flow

The first deploy is a two-step process because the Cloud Run URL and webhook IDs aren't known until after the service is running.

**Step 1 — initial deploy:**
1. Set all secrets above except `WEBHOOK_PUBLIC_URL`, `ALCHEMY_WEBHOOK_ID`, `ALCHEMY_WEBHOOK_SECRET`, `HELIUS_WEBHOOK_ID` (leave those blank)
2. Push to `main` → Actions runs → service deploys
3. Go to GCP Console → Cloud Run → `wallet-tracker` → copy the service URL (looks like `https://wallet-tracker-xxxxxxxxxx-uc.a.run.app`)
4. Set that URL as the `WEBHOOK_PUBLIC_URL` secret

**Step 2 — get webhook IDs from logs:**
1. In Cloud Run → `wallet-tracker` → **Logs**, look for lines like:
   ```
   Alchemy webhook created: wh_xxxxxxxxxxxxxxxx
   Alchemy webhook secret:  abc123...
   Helius webhook created:  xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
2. Set `ALCHEMY_WEBHOOK_ID`, `ALCHEMY_WEBHOOK_SECRET`, `HELIUS_WEBHOOK_ID` from those values
3. Push any trivial commit (e.g. update README) to trigger a redeploy with the IDs baked in

From this point forward, pushing to `main` deploys automatically and the webhook registrations are stable.

---

## config.yaml reference

| Field | Required | Description |
|-------|----------|-------------|
| `telegram.bot_token` | Yes | Token from @BotFather |
| `telegram.chat_id` | Yes | Numeric ID of your personal chat or group |
| `etherscan.api_key` | Yes | Free key — used for wallet scoring during discovery |
| `alchemy.api_key` | Yes (ETH) | From alchemy.com → app page → API Key |
| `alchemy.auth_token` | Yes (ETH) | From alchemy.com → Account Settings → Auth Token |
| `alchemy.webhook_id` | Auto | Written on first run — do not edit |
| `alchemy.webhook_secret` | Auto | Written on first run — do not edit |
| `helius.api_key` | Yes (SOL) | From helius.dev dashboard |
| `helius.webhook_secret` | Yes (SOL) | Any string you choose — Helius sends it as Bearer auth |
| `helius.webhook_id` | Auto | Written on first run — do not edit |
| `webhook.port` | — | Local HTTP server port (default: 3000) |
| `webhook.public_url` | Yes | Public HTTPS URL pointing to this server (ngrok in dev) |
| `solscan.api_key` | No | Free key from pro.solscan.io — improves SOL analysis rate limits |
| `coingecko.api_key` | No | Free Demo key from coingecko.com/en/api |
| `scoring.min_win_rate` | — | Minimum fraction of profitable trades (0.0–1.0) |
| `scoring.min_pnl_usd` | — | Minimum total profit in USD to qualify a wallet |
| `scoring.min_trade_count` | — | Ignore wallets with fewer trades than this |
| `scoring.min_pnl_multiplier` | — | Must have at least one trade with this return multiple |
| `scoring.lookback_days` | — | Days of history to analyze per wallet |
| `discovery.interval_hours` | — | How often to re-run the full discovery pipeline |
| `discovery.coingecko_top_n` | — | Number of top 30d gainers to scan |
| `discovery.min_dex_volume_usd` | — | Minimum DEX volume for a token to be considered |
| `discovery.traders_per_token` | — | Top traders to pull per token from DEX Screener |
