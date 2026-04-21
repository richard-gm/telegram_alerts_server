#!/usr/bin/env bash
set -euo pipefail

# ── Node setup ────────────────────────────────────────────────────────────────
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
nvm use 20

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v ngrok &>/dev/null || {
  echo "[error] ngrok not installed."
  echo "        Install: brew install ngrok"
  echo "        Then authenticate: ngrok config add-authtoken <token>"
  echo "        Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken"
  exit 1
}

# ── Kill any previous app instances ──────────────────────────────────────────
echo "[cleanup] Killing any previous app processes..."
pkill -f "tsx src/index.ts" 2>/dev/null || true
pkill -f "node dist/index.js" 2>/dev/null || true
sleep 1  # Give Telegram's polling a moment to release before we start

# ── Start ngrok ───────────────────────────────────────────────────────────────
echo "[ngrok] Starting tunnel on port 3000..."
ngrok http 3000 --log=stdout > /tmp/ngrok-wallet-tracker.log 2>&1 &
NGROK_PID=$!

VITE_PID=""

cleanup() {
  echo ""
  echo "[cleanup] Stopping app, Vite and ngrok..."
  pkill -f "tsx src/index.ts" 2>/dev/null || true
  pkill -f "node dist/index.js" 2>/dev/null || true
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  kill "$NGROK_PID" 2>/dev/null || true
  wait "$NGROK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Wait for ngrok tunnel URL (up to 15s) ────────────────────────────────────
NGROK_URL=""
for i in $(seq 1 15); do
  sleep 1
  NGROK_URL=$(node -e "
    const http = require('http');
    http.get('http://localhost:4040/api/tunnels', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const tunnels = JSON.parse(d).tunnels ?? [];
          const https = tunnels.find(t => t.proto === 'https');
          process.stdout.write(https ? https.public_url : '');
        } catch { process.stdout.write(''); }
      });
    }).on('error', () => process.stdout.write(''));
  " 2>/dev/null || echo "")
  [ -n "$NGROK_URL" ] && break
done

if [ -z "$NGROK_URL" ]; then
  echo "[error] Could not get ngrok URL after 15s."
  echo "        Is ngrok authenticated? Run: ngrok config add-authtoken <token>"
  echo "        Token available at: https://dashboard.ngrok.com/get-started/your-authtoken"
  exit 1
fi

echo "[ngrok] Tunnel: $NGROK_URL"

# ── Patch config.yaml ─────────────────────────────────────────────────────────
# Uses Node so special characters in the URL are handled safely
NGROK_URL="$NGROK_URL" node -e "
  const fs = require('fs');
  const url = process.env.NGROK_URL;
  let c = fs.readFileSync('config.yaml', 'utf8');
  c = c.replace(/public_url:.*/, 'public_url: \"' + url + '\"');
  fs.writeFileSync('config.yaml', c);
  console.log('[config] Patched webhook.public_url ->', url);
"

# ── Start Vite dev server ─────────────────────────────────────────────────────
if [ -d "web/node_modules" ]; then
  echo "[vite] Starting dashboard on http://localhost:5173 ..."
  (cd web && npm run dev) &
  VITE_PID=$!
else
  echo "[vite] Skipping dashboard — run: cd web && npm install"
fi

# ── Start app ─────────────────────────────────────────────────────────────────
echo "[app] Starting npm run dev..."
echo ""
npm run dev
