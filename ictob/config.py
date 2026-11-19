"""App-wide constants for the ICT OB Scanner web terminal.

Indicator inputs and colours are copied from ict_ob_scanner_indices.py, so
the website scans with the exact same TradingView settings as the desktop
app (FVG + BOS required, volume surge 1.2x, ICT refined zones, close-beyond
-distal mitigation, 6 active OBs per side, PD/PW/PM levels on).
"""
from __future__ import annotations

import os
from datetime import timedelta, timezone
from pathlib import Path

APP_NAME = "ICT OB Scanner"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WEB = ROOT / "web" / "scanner"
CACHE = DATA / "ictob"
CRED_FILE = ROOT / "config" / "credentials.json"
TOKEN_FILE = ROOT / "upstox_token.json"

# Hosting: most PaaS hosts inject PORT and expect a 0.0.0.0 bind, so honour
# PORT too and only fall back to loopback when nothing was injected.
PORT = int(os.environ.get("ICTOB_PORT") or os.environ.get("PORT") or "8770")
HOST = os.environ.get("ICTOB_HOST") or (
    "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")

# Public origin of the deployment, e.g. https://ictob.onrender.com. Upstox
# callbacks land on {BASE_URL}/callback and it must match the redirect URI
# registered in the Upstox developer app.
BASE_URL = (os.environ.get("ICTOB_BASE_URL")
            or os.environ.get("RENDER_EXTERNAL_URL") or "").strip().rstrip("/")

# Optional HTTP Basic password so a public deployment is not wide open.
PASSWORD = os.environ.get("ICTOB_PASSWORD", "").strip()

# Where the access token / credentials are persisted. Point this at a mounted
# volume on a host so a daily re-login survives restarts.
STATE_DIR = Path(os.environ.get("ICTOB_STATE_DIR") or ROOT)

IST = timezone(timedelta(hours=5, minutes=30))

# --- indicator input values, exactly as in the user's TradingView settings ---
IND = {
    # 1. ICT / SMC Validation Engine
    "obLookback": 5,          # Max Impulse Scan Bars
    "swingLen": 10,           # Structure / Liquidity Lookback
    "atrMult": 1.1,           # Min Displacement (ATR Mult)
    "reqFVG": True,           # Require Fair Value Gap (FVG) Displacement
    "reqBOS": True,           # Require Break of Structure (BOS / MSS)
    "reqSweep": False,        # Strict Mode: Require Liquidity Sweep Only

    # 2. Intraday & Volume Filters
    "useVolFilter": True,     # Require Institutional Volume Surge
    "volMult": 1.2,           # Volume Surge Multiplier (vs 20 SMA)
    "useVwapFilter": False,   # Filter by Intraday VWAP Bias
    "showVwap": True,         # Plot Session VWAP

    # 3. Zone Anatomy & Mitigation Rules
    "zoneMode": "ICT Refined (Body to Extremity)",
    "mitigationMode": "Close Beyond Distal (Full Invalidation)",
    "maxActiveOBs": 6,        # Max Active OBs Per Side
    "showMT": True,           # Show 50% Mean Threshold (Equilibrium)
    "showLabels": True,       # Show Confluence Grade & Volume Tags

    # 5. HTF Key Liquidity Levels
    "showPD": True,
    "showPW": True,
    "showPM": True,
    "htfStyle": "solid",
    "htfLineWidth": 2,
    "showLevelPrice": False,
    "showSweepTag": False,
    "htfRightOffset": 6,
}

COLORS = {
    "bull": "#00b894",       # Bullish OB fill/border/text
    "bear": "#ff7675",       # Bearish OB fill/border/text
    "vwap": "#fdcb6e",       # Session VWAP line
    "htf": "#0066ff",        # HTF level lines
    "up": "#089981",         # candle up
    "down": "#f23645",       # candle down
    "bg": "#131722",
    "panel": "#1e222d",
    "text": "#d1d4dc",
    "sub": "#787b86",
    "grid": "#1e222d",
}

TIMEFRAMES = [1, 3, 5, 10, 15, 30, 60]
TF_LABEL = {1: "1", 3: "3", 5: "5", 10: "10", 15: "15", 30: "30", 60: "60"}
DAYS_SHOWN = 1                 # chart shows ONLY the current intraday session
LIVE_TF = 5                    # engine always runs on the 5m series
OI_REFRESH_SEC = 15.0          # option-chain refresh cadence for the OI strip
OPT_ENTRY_TTL = 240.0          # option+TPM score freshness

# --- INDICES MODE — NSE index catalog + constituents ----------------------
IND_LIST_URL = "https://archives.nseindia.com/content/indices/ind_{slug}list.csv"
IND_LIST_URL_B = ("https://nsearchives.nseindia.com/content/indices/"
                  "ind_{slug}list.csv")

INDEX_CATALOG: tuple[tuple[str, str, str], ...] = (
    ("NIFTY 50", "nifty50", "Nifty 50"),
    ("NIFTY NEXT 50", "niftynext50", "Nifty Next 50"),
    ("NIFTY 100", "nifty100", "Nifty 100"),
    ("NIFTY 200", "nifty200", "Nifty 200"),
    ("NIFTY 500", "nifty500", "Nifty 500"),
    ("NIFTY MIDCAP 50", "niftymidcap50", "Nifty Midcap 50"),
    ("NIFTY MIDCAP 100", "niftymidcap100", "NIFTY MIDCAP 100"),
    ("NIFTY MIDCAP 150", "niftymidcap150", "NIFTY MIDCAP 150"),
    ("NIFTY SMALLCAP 50", "niftysmallcap50", ""),
    ("NIFTY SMALLCAP 100", "niftysmallcap100", ""),
    ("NIFTY SMALLCAP 250", "niftysmallcap250", ""),
    ("NIFTY BANK", "niftybank", "Nifty Bank"),
    ("NIFTY PSU BANK", "niftypsubank", "Nifty PSU Bank"),
    ("NIFTY FIN SERVICE", "niftyfinance", "Nifty Fin Service"),
    ("NIFTY IT", "niftyit", "Nifty IT"),
    ("NIFTY FMCG", "niftyfmcg", "Nifty FMCG"),
    ("NIFTY PHARMA", "niftypharma", "Nifty Pharma"),
    ("NIFTY HEALTHCARE", "niftyhealthcare", "NIFTY HEALTHCARE"),
    ("NIFTY AUTO", "niftyauto", "Nifty Auto"),
    ("NIFTY REALTY", "niftyrealty", "Nifty Realty"),
    ("NIFTY METAL", "niftymetal", "Nifty Metal"),
    ("NIFTY ENERGY", "niftyenergy", "Nifty Energy"),
    ("NIFTY INFRA", "niftyinfra", "Nifty Infra"),
    ("NIFTY MEDIA", "niftymedia", "Nifty Media"),
    ("NIFTY MNC", "niftymnc", "Nifty MNC"),
    ("NIFTY OIL & GAS", "niftyoilgas", "NIFTY OIL AND GAS"),
    ("NIFTY CONSUMPTION", "niftyconsumption", "Nifty Consumption"),
    ("NIFTY COMMODITIES", "niftycommodities", "Nifty Commodities"),
)

SCAN_MODES = ("OB VOL (x)", "OPTION + TPM", "RALLY + OPT", "INDICES")
SCAN_MODE_TITLE = {
    "OB VOL (x)": "STOCKS — BY OB VOLUME (x)",
    "OPTION + TPM": "STOCKS — OPTION DETAIL + TPM",
    "RALLY + OPT": "STOCKS — RALLY + OPTION/TPM",
    "INDICES": "INDICES — CLICK TO OPEN ITS F&O STOCKS",
}

SAMPLE_SYMBOLS = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "AXISBANK",
    "BHARTIARTL", "ITC", "LT", "KOTAKBANK", "HINDUNILVR", "BAJFINANCE",
    "MARUTI", "M&M", "TATAMOTORS", "SUNPHARMA", "TITAN", "ASIANPAINT",
    "ADANIENT", "ADANIPORTS", "POWERGRID", "NTPC", "ONGC", "COALINDIA",
    "TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL", "BPCL", "IOC", "DLF",
    "GODREJPROP", "INDUSINDBK", "PNB", "BANKBARODA", "CANBK", "WIPRO",
    "HCLTECH", "TECHM", "DRREDDY", "CIPLA", "DIVISLAB", "APOLLOHOSP",
    "EICHERMOT", "HEROMOTOCO", "BAJAJ-AUTO", "NESTLEIND", "BRITANNIA",
    "TATACONSUM", "GRASIM", "ULTRACEMCO", "SHREECEM", "AMBUJACEM", "ACC",
    "IDEA", "PIDILITIND", "DABUR", "HAVELLS", "SIEMENS", "ABB",
]
