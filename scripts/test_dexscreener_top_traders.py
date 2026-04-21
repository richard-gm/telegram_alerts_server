#!/usr/bin/env python3
"""
Test script to probe DEX Screener for top traders per token.

DEX Screener's website shows a "Top Traders" tab per pair, but that endpoint
(io.dexscreener.com) is behind Cloudflare bot protection — not accessible
programmatically. This script confirms that and shows what IS available via
the official public API that could help with wallet discovery.

Usage:
    python scripts/test_dexscreener_top_traders.py [chain] [tokenAddress]

Test tokens (presets used when no args given):
    ethereum  0x6982508145454Ce325dDbE47a25d4ec3d2311933  PEPE
    base      0x532f27101965dd16442E59d40670FaF5eBb142E4  BRETT
    solana    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  USDC
"""

import sys
import json
import time
import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PRESETS = [
    ("ethereum", "0x6982508145454Ce325dDbE47a25d4ec3d2311933", "PEPE (ETH)"),
    ("base",     "0x532f27101965dd16442E59d40670FaF5eBb142E4", "BRETT (Base)"),
    ("solana",   "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "Bonk (SOL)"),
]

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://dexscreener.com/",
    "Origin": "https://dexscreener.com",
}

# All known top-traders endpoint candidates
TOP_TRADERS_CANDIDATES = [
    # io.dexscreener.com — internal endpoint used by their website (Cloudflare-protected)
    "https://io.dexscreener.com/dex/pair-details/topTraders/{chain}/{pair}?rankBy=pnl&order=desc&period={period}",
    "https://io.dexscreener.com/dex/chart/v2/pairs/{chain}/{pair}/topTraders?rankBy=pnl&order=desc&period={period}",
    # api.dexscreener.com — various path guesses
    "https://api.dexscreener.com/dex/pair-details/topTraders/{chain}/{pair}?rankBy=pnl&order=desc&period={period}",
    "https://api.dexscreener.com/dex/v1/topTraders/{chain}/{pair}?period={period}",
    "https://api.dexscreener.com/dex/topTraders/v1/{chain}/{pair}?period={period}",
    "https://api.dexscreener.com/dex/pair-details/v2/top-traders/{chain}/{pair}?period={period}",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sep(char="─", width=72):
    print(char * width)

def fmt_usd(val):
    if val is None:
        return "N/A"
    if abs(val) >= 1_000_000:
        return f"${val/1_000_000:.1f}M"
    if abs(val) >= 1_000:
        return f"${val/1_000:.1f}k"
    return f"${val:.0f}"

def get_json(url, timeout=10):
    """Returns (status_code, data_or_None, error_str)."""
    try:
        r = requests.get(url, headers=BROWSER_HEADERS, timeout=timeout)
        try:
            return r.status_code, r.json(), None
        except Exception:
            return r.status_code, None, r.text[:200]
    except requests.exceptions.Timeout:
        return None, None, f"TIMEOUT after {timeout}s"
    except requests.exceptions.ConnectionError as e:
        return None, None, f"CONNECTION ERROR: {e}"
    except Exception as e:
        return None, None, str(e)

# ---------------------------------------------------------------------------
# Step 1: Official API — pairs for token
# ---------------------------------------------------------------------------

def fetch_pairs(chain, token_address):
    url = f"https://api.dexscreener.com/token-pairs/v1/{chain}/{token_address}"
    print(f"\n[1] Official pairs API")
    print(f"    {url}")
    status, data, err = get_json(url)
    if err:
        print(f"    ✗ {err}")
        return []
    if status != 200:
        print(f"    HTTP {status}")
        return []

    pairs = data if isinstance(data, list) else data.get("pairs", [])
    if not pairs:
        print("    No pairs returned.")
        return []

    def vol(p):
        return (p.get("volume") or {}).get("h24") or 0

    pairs_sorted = sorted(pairs, key=vol, reverse=True)[:5]

    print(f"    ✓  {len(pairs)} pairs found. Top {len(pairs_sorted)} by 24h volume:")
    for i, p in enumerate(pairs_sorted, 1):
        dex  = p.get("dexId", "?")
        addr = p.get("pairAddress", "?")
        v24  = fmt_usd(vol(p))
        base = (p.get("baseToken") or {}).get("symbol", "?")
        qte  = (p.get("quoteToken") or {}).get("symbol", "?")
        txns = p.get("txns", {}).get("h24", {})
        buys = txns.get("buys", "?")
        sells = txns.get("sells", "?")
        print(f"    {i}. [{dex}] {base}/{qte}  vol={v24}  buys={buys}  sells={sells}")
        print(f"       pairAddress: {addr}")
    return pairs_sorted

# ---------------------------------------------------------------------------
# Step 2: Probe all top-traders endpoint candidates
# ---------------------------------------------------------------------------

def probe_top_traders_all(chain, pair_address, dex_id):
    short = pair_address[:14] + "..."
    print(f"\n[2] Probing top-traders endpoints for pair {short} (dex={dex_id})")

    for tmpl in TOP_TRADERS_CANDIDATES:
        url = tmpl.format(chain=chain, pair=pair_address, period="1d")
        status, data, err = get_json(url, timeout=8)

        if err:
            indicator = "TIMEOUT" if "TIMEOUT" in err else "ERR"
            print(f"    [{indicator}]  {url}")
            print(f"              {err}")
        elif status == 200 and data is not None:
            print(f"    [HTTP 200 ✓]  {url}")
            return url, data
        else:
            cf_protected = (data is None and status == 403)
            note = " (Cloudflare-protected)" if cf_protected else ""
            print(f"    [HTTP {status}]  {url}{note}")

    return None, None

def print_traders(data):
    traders = []
    if isinstance(data, list):
        traders = data
    elif isinstance(data, dict):
        for key in ("topTraders", "data", "traders", "results"):
            if key in data and isinstance(data[key], list):
                traders = data[key]
                break

    if not traders:
        print("\n    No traders array found. Raw response:")
        print("   ", json.dumps(data, indent=2)[:1500])
        return

    sample = traders[0] if traders else {}
    wallet_key = next((k for k in ("wallet", "address", "maker", "account") if k in sample), None)
    bought_key = next((k for k in ("boughtUsd", "bought_usd", "buyUsd", "volumeBuyUsd") if k in sample), None)
    sold_key   = next((k for k in ("soldUsd", "sold_usd", "sellUsd", "volumeSellUsd") if k in sample), None)
    pnl_key    = next((k for k in ("pnl", "pnlUsd", "pnl_usd", "realizedPnl", "profit") if k in sample), None)

    print(f"\n    {len(traders)} traders returned. First {min(10, len(traders))}:\n")
    print(f"  {'#':<4} {'wallet':<46} {'bought':>10} {'sold':>10} {'pnl':>10}")
    sep("  ─", 82)
    for i, t in enumerate(traders[:10], 1):
        wallet  = str(t.get(wallet_key, "?")) if wallet_key else "?"
        bought  = fmt_usd(t.get(bought_key)) if bought_key else "?"
        sold    = fmt_usd(t.get(sold_key)) if sold_key else "?"
        pnl_val = t.get(pnl_key) if pnl_key else None
        pnl_str = fmt_usd(pnl_val) if pnl_val is not None else "?"
        print(f"  {i:<4} {wallet:<46} {bought:>10} {sold:>10} {pnl_str:>10}")

    print(f"\n    [RAW first trader record]")
    print("   ", json.dumps(traders[0], indent=4))

# ---------------------------------------------------------------------------
# Step 3: Show what useful data IS available in the official pair endpoint
# ---------------------------------------------------------------------------

def show_available_data(pair):
    print(f"\n[3] Data available in official pair response (for discovery purposes)")
    addr = pair.get("pairAddress", "?")
    chain = pair.get("chainId", "?")
    dex = pair.get("dexId", "?")
    base = (pair.get("baseToken") or {}).get("symbol", "?")
    qte  = (pair.get("quoteToken") or {}).get("symbol", "?")
    txns = pair.get("txns", {})
    vol  = pair.get("volume", {})
    price_change = pair.get("priceChange", {})

    print(f"    Pair: {base}/{qte} on {dex} ({chain})")
    print(f"    Address: {addr}")
    print(f"    Price change  — 1h: {price_change.get('h1','?')}%  6h: {price_change.get('h6','?')}%  24h: {price_change.get('h24','?')}%")
    print(f"    Volume (USD)  — 1h: {fmt_usd(vol.get('h1'))}  24h: {fmt_usd(vol.get('h24'))}")
    for tf in ("m5", "h1", "h6", "h24"):
        t = txns.get(tf, {})
        print(f"    Txns {tf:<4}    — buys: {t.get('buys','?')}  sells: {t.get('sells','?')}")
    print(f"\n    ↳ The official API gives aggregate counts/volume but NO individual wallet data.")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(chain, token_address, label):
    sep("═")
    print(f"TOKEN: {label}")
    print(f"chain={chain}  address={token_address}")
    sep("═")

    pairs = fetch_pairs(chain, token_address)
    if not pairs:
        print("  Cannot proceed — no pairs found.")
        return

    top_pair = pairs[0]
    pair_addr = top_pair.get("pairAddress", "")
    dex_id    = top_pair.get("dexId", "?")

    # Fetch full pair data for the data-available display
    status, pair_detail, _ = get_json(
        f"https://api.dexscreener.com/latest/dex/pairs/{chain}/{pair_addr}", timeout=10
    )
    full_pair = None
    if status == 200 and pair_detail:
        full_pairs = pair_detail.get("pairs", [])
        full_pair = full_pairs[0] if full_pairs else None

    # Probe top traders
    endpoint, data = probe_top_traders_all(chain, pair_addr, dex_id)

    if data is not None:
        print(f"\n  ✅ SUCCESS — top traders accessible at:\n     {endpoint}")
        print_traders(data)
    else:
        print(f"\n  ❌ Top traders not accessible via any probed endpoint.")

    if full_pair:
        show_available_data(full_pair)

def main():
    args = sys.argv[1:]
    if len(args) >= 2:
        targets = [(args[0], args[1], f"{args[0]} {args[1][:12]}...")]
    else:
        print("No args — running all presets.\n")
        targets = PRESETS

    for chain, addr, label in targets:
        run(chain, addr, label)
        print()
        time.sleep(1)

    print("\n" + "═"*72)
    print("SUMMARY")
    print("═"*72)
    print("""
  io.dexscreener.com/dex/pair-details/topTraders/{chain}/{pair}
    → HTTP 403  Cloudflare bot protection — programmatic access blocked.
      Their website calls this endpoint via browser JS, which passes the
      Cloudflare challenge. Python requests/curl cannot.

  api.dexscreener.com top-traders paths
    → HTTP 404  No such endpoint exists on the public API.

  NEXT OPTIONS:
    A) Apify scraper  https://apify.com/crypto-scraper/dexscreener-top-traders-scraper
       Paid service that scrapes DEX Screener in a real browser. ~$5/1000 results.

    B) DEX Screener paid API plan ($35–$299/mo)
       Check if higher tiers unlock top-traders endpoint (not confirmed).

    C) Abandon DEX Screener for wallet discovery.
       Use on-chain data directly: Etherscan/Helius already give us wallet
       addresses. The real fix is improving the P&L scoring filter, not the
       source. See architecture gap #5 in architecture.instructions.md.
""")

if __name__ == "__main__":
    main()
