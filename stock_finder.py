#!/usr/bin/env python3


import datetime as _dt
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

TIINGO_HOST = "https://api.tiingo.com"
# Free token, read from the environment. Signup: https://www.tiingo.com
API_TOKEN = (
    os.environ.get("TIINGO_API_KEY", "")
    or os.environ.get("TIINGO_TOKEN", "")
).strip()

HEADERS = {
    "User-Agent": "StockX/3.0",
    "Accept": "application/json",
    "Content-Type": "application/json",
}
if API_TOKEN:
    # Token in the header keeps it out of URLs / logs / the cache key.
    HEADERS["Authorization"] = "Token " + API_TOKEN


def _build_ssl_context():
    """Trusted TLS context. Many Python installs (esp. macOS) ship without a
    wired-up CA bundle, so prefer certifi's bundle when it's available."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


SSL_CTX = _build_ssl_context()

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".ico": "image/x-icon",
}

# --- tiny in-memory TTL cache (keeps repeat clicks from spending requests) --
_CACHE = {}  # key -> (expires_epoch, value)


def _cache_get(key):
    hit = _CACHE.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    return None


def _cache_put(key, value, ttl):
    _CACHE[key] = (time.time() + ttl, value)


# --- Tiingo client -------------------------------------------------------
class RateLimited(RuntimeError):
    """Raised when Tiingo signals a throttle (HTTP 429)."""


class MissingToken(RuntimeError):
    """Raised when no API token is configured."""


def tg_get(path, ttl=60):
    """GET a Tiingo endpoint (host-relative path incl. query) -> parsed JSON.

    Errors are normalized: 429 -> RateLimited, 401/403 -> a token-setup hint,
    other 4xx/5xx -> ValueError carrying Tiingo's own `detail` message.
    """
    if not API_TOKEN:
        raise MissingToken(
            "No Tiingo API token set. Grab a free one at https://www.tiingo.com "
            "and run:  export TIINGO_API_KEY=your_token"
        )

    cached = _cache_get(path)
    if cached is not None:
        return cached

    req = urllib.request.Request(TIINGO_HOST + path, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=25, context=SSL_CTX) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RateLimited(
                "Tiingo is rate-limiting requests (free tier: 1000/day, "
                "50 symbols/hour). Wait a moment and try again."
            )
        if exc.code in (401, 403):
            raise ValueError(
                "Tiingo rejected the API token. Check TIINGO_API_KEY — get a "
                "free token at https://www.tiingo.com"
            )
        detail = None
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("detail")
        except Exception:
            pass
        raise ValueError(detail or f"Tiingo request failed ({exc.code}).")
    except urllib.error.URLError as exc:
        raise ValueError(f"Could not reach Tiingo ({exc.reason}).")

    # Tiingo signals some errors with a 200 + {"detail": "..."} body.
    if isinstance(data, dict) and "detail" in data and len(data) == 1:
        raise ValueError(data["detail"])

    _cache_put(path, data, ttl)
    return data


def _f(v):
    """Parse a value -> float or None."""
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _iso_epoch(s):
    """ISO-8601 string ('2024-06-24T00:00:00.000Z') -> epoch seconds, or None."""
    if not s:
        return None
    try:
        dt = _dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return int(dt.timestamp())


# Per UI range: (source, resampleFreq, days_back). source "iex" = intraday bars,
# "daily" = end-of-day series. days_back=None means "from the beginning";
# days_back=-1 means "since Jan 1 of this year" (year-to-date).
RANGE_PLAN = {
    "1d":  ("iex",   "5min",    2),
    "5d":  ("iex",   "15min",   7),
    "1mo": ("daily", "daily",  35),
    "6mo": ("daily", "daily", 190),
    "ytd": ("daily", "daily",  -1),
    "1y":  ("daily", "daily", 370),
    "5y":  ("daily", "weekly", 1830),
    "max": ("daily", "monthly", None),
}


def _start_date(days_back):
    today = _dt.date.today()
    if days_back is None:
        return "1980-01-01"
    if days_back == -1:
        return f"{today.year}-01-01"
    return (today - _dt.timedelta(days=days_back)).isoformat()


def _points_from_rows(rows):
    """Normalize Tiingo price rows (daily or IEX) into the frontend's points."""
    pts = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        c = _f(r.get("close"))
        t = _iso_epoch(r.get("date"))
        if c is None or t is None:
            continue
        pts.append({
            "t": t, "c": c,
            "o": _f(r.get("open")), "h": _f(r.get("high")),
            "l": _f(r.get("low")), "v": _f(r.get("volume")),
        })
    pts.sort(key=lambda p: p["t"])  # Tiingo is usually ascending; be safe.
    return pts


def _fetch_history(symbol, rng):
    source, freq, days_back = RANGE_PLAN.get(rng, ("daily", "daily", 35))
    start = _start_date(days_back)
    sym = urllib.parse.quote(symbol.lower())
    if source == "iex":
        path = f"/iex/{sym}/prices?" + urllib.parse.urlencode(
            {"startDate": start, "resampleFreq": freq,
             "columns": "open,high,low,close,volume"}
        )
        ttl = 45
    else:
        path = f"/tiingo/daily/{sym}/prices?" + urllib.parse.urlencode(
            {"startDate": start, "resampleFreq": freq}
        )
        ttl = 300
    rows = tg_get(path, ttl=ttl)
    return _points_from_rows(rows if isinstance(rows, list) else [])


def _fetch_meta(symbol):
    """Company name + exchange (cached long — it rarely changes)."""
    sym = urllib.parse.quote(symbol.lower())
    try:
        m = tg_get(f"/tiingo/daily/{sym}", ttl=86400)
    except (ValueError, RateLimited):
        return {}
    return m if isinstance(m, dict) else {}


def _fetch_quote(symbol):
    """Live-ish IEX top-of-book quote (last, prevClose, day OHLC, volume)."""
    sym = urllib.parse.quote(symbol.lower())
    try:
        q = tg_get(f"/iex/{sym}", ttl=30)
    except (ValueError, RateLimited):
        return {}
    if isinstance(q, list) and q:
        return q[0]
    return q if isinstance(q, dict) else {}


def _hi_lo(pts):
    hi = lo = None
    for p in pts:
        h = p["h"] if p["h"] is not None else p["c"]
        l = p["l"] if p["l"] is not None else p["c"]
        hi = h if hi is None else max(hi, h)
        lo = l if lo is None else min(lo, l)
    return (hi, lo)


def _fetch_52week(symbol):
    """(high, low) over the trailing ~year of daily bars, cached for an hour."""
    sym = urllib.parse.quote(symbol.lower())
    start = (_dt.date.today() - _dt.timedelta(days=370)).isoformat()
    path = f"/tiingo/daily/{sym}/prices?" + urllib.parse.urlencode(
        {"startDate": start, "resampleFreq": "daily"}
    )
    try:
        rows = tg_get(path, ttl=3600)
    except (ValueError, RateLimited):
        return (None, None)
    return _hi_lo(_points_from_rows(rows if isinstance(rows, list) else []))


def fetch_chart(symbol, rng):
    """Fetch normalized price history + live quote in the frontend's shape."""
    symbol = symbol.upper()
    pts = _fetch_history(symbol, rng)
    if not pts:
        raise ValueError(
            f"No price data for '{symbol}'. Tiingo's free tier covers US "
            f"stocks & ETFs — check the symbol."
        )

    meta = _fetch_meta(symbol)
    quote = _fetch_quote(symbol)
    last = pts[-1]["c"]

    # 52-week range: reuse the chart history when it already spans ~a year of
    # bars; otherwise do a dedicated (cached) daily lookup.
    if rng in ("1y", "5y", "max"):
        wk_hi, wk_lo = _hi_lo(pts)
    else:
        wk_hi, wk_lo = _fetch_52week(symbol)

    live = (_f(quote.get("last")) or _f(quote.get("tngoLast"))
            or _f(quote.get("mid")) or last)
    prev = _f(quote.get("prevClose"))
    if prev is None and len(pts) > 1:
        prev = pts[-2]["c"]

    return {
        "symbol": symbol,
        "shortName": meta.get("name") or symbol,
        "currency": "USD",  # Tiingo's free US universe is USD-denominated.
        "exchangeName": meta.get("exchangeCode") or "Tiingo",
        "instrumentType": "",
        "regularMarketPrice": live,
        "previousClose": prev,
        "regularMarketDayHigh": _f(quote.get("high")),
        "regularMarketDayLow": _f(quote.get("low")),
        "fiftyTwoWeekHigh": wk_hi,
        "fiftyTwoWeekLow": wk_lo,
        "regularMarketVolume": _f(quote.get("volume")),
        "timezone": "America/New_York",
        "range": rng,
        "interval": RANGE_PLAN.get(rng, (None, "daily"))[1],
        "source": "tiingo",
        "points": pts,
    }


def fetch_search(query):
    """Symbol lookup / autocomplete via Tiingo's search utility."""
    path = "/tiingo/utilities/search?" + urllib.parse.urlencode(
        {"query": query, "limit": 8}
    )
    data = tg_get(path, ttl=600)
    out = []
    for m in (data if isinstance(data, list) else []):
        sym = m.get("ticker")
        if not sym:
            continue
        out.append({
            "symbol": sym.upper(),
            "name": m.get("name") or "",
            "exchange": m.get("exchangeCode") or m.get("assetType") or "",
            "type": m.get("assetType") or "",
        })
    return {"results": out}


# --- HTTP server ---------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "StockX/3.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, path):
        ext = os.path.splitext(path)[1]
        ctype = STATIC_TYPES.get(ext)
        if ctype is None or not os.path.isfile(path):
            self._send_json({"error": "Not found"}, status=404)
            return
        with open(path, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if route == "/api/chart":
            symbol = (params.get("symbol", [""])[0] or "").strip()
            rng = (params.get("range", ["1mo"])[0] or "1mo").strip()
            if not symbol:
                return self._send_json({"error": "Missing symbol"}, status=400)
            try:
                return self._send_json(fetch_chart(symbol, rng))
            except MissingToken as exc:
                return self._send_json({"error": str(exc)}, status=503)
            except ValueError as exc:
                return self._send_json({"error": str(exc)}, status=404)
            except RateLimited as exc:
                return self._send_json({"error": str(exc)}, status=429)
            except Exception as exc:
                return self._send_json({"error": str(exc)}, status=502)

        if route == "/api/search":
            query = (params.get("q", [""])[0] or "").strip()
            if not query:
                return self._send_json({"results": []})
            try:
                return self._send_json(fetch_search(query))
            except MissingToken as exc:
                return self._send_json({"error": str(exc), "results": []}, status=503)
            except RateLimited as exc:
                return self._send_json({"error": str(exc), "results": []}, status=429)
            except Exception as exc:
                return self._send_json({"error": str(exc), "results": []}, status=502)

        if route in ("/", ""):
            return self._send_static(os.path.join(HERE, "display.html"))

        safe = os.path.normpath(route.lstrip("/"))
        if safe.startswith("..") or os.path.isabs(safe):
            return self._send_json({"error": "Forbidden"}, status=403)
        return self._send_static(os.path.join(HERE, safe))


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print("\n  Stock-X is running (data: Tiingo)", flush=True)
    if API_TOKEN:
        print("  ✓ Tiingo token loaded — free tier: 1000 req/day, all US stocks/ETFs.", flush=True)
    else:
        print("  ⚠ No TIINGO_API_KEY set. Get a FREE token at https://www.tiingo.com", flush=True)
        print("    then:  export TIINGO_API_KEY=your_token", flush=True)
    print(f"  Open  {url}  in your browser", flush=True)
    print("  Press Ctrl+C to stop\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down. Bye!")
        server.shutdown()


if __name__ == "__main__":
    main()

# python3 stock_finder.py
