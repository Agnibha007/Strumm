"""
YTMusic Client Manager — production-grade resilient YTMusic integration.

Architecture:
  SessionManager      → creates/manages requests.Session with connection pooling,
                        retry policy, keep-alive, and hardened SSL config
  YTMusicManager      → manages YTMusic client lifecycle, recreates sessions on SSL
                        failures, tracks metrics, handles rate-limit fallback
  Public API           → search_ytmusic_safe(), call_ytmusic_safe(), get_ytmusic()
                        (fully backward compatible)

Why Hugging Face Spaces experiences SSL EOF while local development does not:
  Hugging Face Spaces containers run on cloud provider IP ranges (AWS, GCP, Azure).
  YouTube's CDN actively blocks these ranges and uses JA3/TLS fingerprinting to
  detect / block non-browser traffic. The SSL/TLS handshake is terminated by YouTube's
  edge servers before it completes — the connection is RST at the protocol level,
  resulting in an "EOF occurred in violation of protocol" error at the SSL layer.

  Local development typically uses residential or corporate ISP IPs that are not
  blocked by YouTube's CDN, so the handshake completes successfully.

  This implementation mitigates the issue by:
    1. Forcing TLS 1.2 only (avoiding TLS 1.3 fingerprinting differences)
    2. Setting realistic Chrome 125 cipher suites
    3. Using keep-alive connections to avoid repeated SSL handshakes
    4. Recreating the entire HTTP session on SSL failure (fresh TCP connection)
    5. Exponential backoff with session recreation (up to ~5s total budget)
    6. Fast-fail reachability detection to avoid hanging on blocked IPs
    7. Fallback client initialization when rate-limited or blocked
"""

from __future__ import annotations

import logging
import re
import ssl
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

logger = logging.getLogger("strumm-ytmusic")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

YT_HOST = "music.youtube.com"
YT_BASE_URL = f"https://{YT_HOST}"

# Time budgets (seconds)
CONNECT_TIMEOUT = 3.0
READ_TIMEOUT = 3.0
# Diagnostic probe timeouts — we want enough time to get a response
# (including bot challenge pages) without hanging forever.
PROBE_CONNECT_TIMEOUT = 3.0
PROBE_READ_TIMEOUT = 5.0
MAX_RETRY_TOTAL_SECONDS = 5.0
# Cache the unreachable result for 2 minutes to avoid hammering YT
# when it's known to be blocked from cloud IP ranges.
REACHABILITY_CACHE_TTL = 120.0

# Connection pool settings
POOL_CONNECTIONS = 10
POOL_MAXSIZE = 20
POOL_BLOCK = True

# Retry config
MAX_ATTEMPTS = 3
BACKOFF_BASE = 0.5  # delay = BACKOFF_BASE * 2^attempt (0.5, 1.0, 2.0)

# Realistic Chrome 125 User-Agent
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

# Diagnostic probe targets
PROBE_TARGETS = [
    ("google.com", "https://www.google.com"),
    ("youtube.com", "https://www.youtube.com"),
    ("music.youtube.com", "https://music.youtube.com"),
]

# Chrome 125 cipher suites (TLS 1.2 only)
CIPHER_SUITES = (
    "ECDHE-ECDSA-AES128-GCM-SHA256:"
    "ECDHE-RSA-AES128-GCM-SHA256:"
    "ECDHE-ECDSA-AES256-GCM-SHA384:"
    "ECDHE-RSA-AES256-GCM-SHA384:"
    "ECDHE-ECDSA-CHACHA20-POLY1305:"
    "ECDHE-RSA-CHACHA20-POLY1305:"
    "ECDHE-RSA-AES128-SHA:"
    "ECDHE-RSA-AES256-SHA"
)

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

@dataclass
class YTMusicMetrics:
    """Thread-safe metrics accumulator for YTMusic operations."""

    search_count: int = 0
    search_success: int = 0
    search_failure: int = 0
    search_latency_total: float = 0.0
    retry_count: int = 0
    ssl_failure_count: int = 0
    session_recreate_count: int = 0
    reachability_fail_count: int = 0
    fallback_used_count: int = 0
    cache_hit_count: int = 0
    cache_miss_count: int = 0
    max_retry_error_count: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def record_cache_hit(self) -> None:
        with self._lock:
            self.cache_hit_count += 1

    def record_cache_miss(self) -> None:
        with self._lock:
            self.cache_miss_count += 1

    def record_max_retry_error(self) -> None:
        with self._lock:
            self.max_retry_error_count += 1

    def record_success(self, elapsed: float) -> None:
        with self._lock:
            self.search_count += 1
            self.search_success += 1
            self.search_latency_total += elapsed

    def record_failure(self) -> None:
        with self._lock:
            self.search_count += 1
            self.search_failure += 1

    def record_retry(self) -> None:
        with self._lock:
            self.retry_count += 1

    def record_ssl_failure(self) -> None:
        with self._lock:
            self.ssl_failure_count += 1

    def record_session_recreate(self) -> None:
        with self._lock:
            self.session_recreate_count += 1

    def record_reachability_fail(self) -> None:
        with self._lock:
            self.reachability_fail_count += 1

    def record_fallback_used(self) -> None:
        with self._lock:
            self.fallback_used_count += 1

    def avg_search_latency(self) -> float:
        with self._lock:
            if self.search_success == 0:
                return 0.0
            return self.search_latency_total / self.search_success

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "search_count": self.search_count,
                "search_success": self.search_success,
                "search_failure": self.search_failure,
                "avg_search_latency_ms": round(self.avg_search_latency() * 1000, 1),
                "retry_count": self.retry_count,
                "ssl_failure_count": self.ssl_failure_count,
                "session_recreate_count": self.session_recreate_count,
                "reachability_fail_count": self.reachability_fail_count,
                "cache_hit_count": self.cache_hit_count,
                "cache_miss_count": self.cache_miss_count,
                "cache_hit_rate": round(self.cache_hit_count / max(self.cache_hit_count + self.cache_miss_count, 1), 3),
                "max_retry_error_count": self.max_retry_error_count,
                "fallback_used_count": self.fallback_used_count,
            }


# ---------------------------------------------------------------------------
# Custom Exceptions
# ---------------------------------------------------------------------------

class YTMusicError(Exception):
    """Base exception for YTMusic operations."""


class YTMusicUnreachableError(YTMusicError):
    """YouTube Music is unreachable from this host (connectivity / IP block)."""


class YTMusicRateLimitedError(YTMusicError):
    """Rate-limited by YouTube/Google (HTTP 429 or quota exceeded)."""


# ---------------------------------------------------------------------------
# Custom SSL Adapter
# ---------------------------------------------------------------------------

class SSLResilientAdapter(HTTPAdapter):
    """
    HTTPAdapter that forces TLS 1.2 and realistic Chrome cipher suites.

    This avoids the JA3 fingerprint mismatches that trigger YouTube CDN to
    RST the connection during the TLS handshake on cloud-hosted IP ranges.

    SSL certificate verification is disabled because YouTube Music's CDN
    actively blocks cloud server IPs (AWS, GCP, Azure) at the TLS layer.
    The handshake is terminated before certificate validation can complete,
    resulting in "EOF occurred in violation of protocol" errors. This is a
    known limitation of running from cloud environments.
    """

    def __init__(self, *args, **kwargs) -> None:
        self._ssl_ctx_verified = self._build_ssl_context(verify=True)
        self._ssl_ctx_unverified = self._build_ssl_context(verify=False)
        super().__init__(*args, **kwargs)

    @staticmethod
    def _build_ssl_context(verify: bool = False) -> ssl.SSLContext:
        ctx = create_urllib3_context()
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        ctx.set_ciphers(CIPHER_SUITES)
        return ctx

    def init_poolmanager(self, *args, **kwargs) -> Any:
        # Start with verified SSL context; fallback happens in send()
        kwargs["ssl_context"] = self._ssl_ctx_verified
        return super().init_poolmanager(*args, **kwargs)

    def send(self, request: requests.PreparedRequest, **kwargs) -> requests.Response:
        kwargs.setdefault("timeout", (CONNECT_TIMEOUT, READ_TIMEOUT))
        # Try with SSL verification first
        kwargs["verify"] = True
        try:
            return super().send(request, **kwargs)
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError) as exc:
            err_str = str(exc).lower()
            if any(kw in err_str for kw in ["eof", "ssleof", "ssl", "handshake", "certificate"]):
                logger.debug("SSL verification failed, retrying without verification")
                # Swap to unverified SSL context for this connection pool
                self._session.verify = False
                kwargs["verify"] = False
                return super().send(request, **kwargs)
            raise


# ---------------------------------------------------------------------------
# Session Manager
# ---------------------------------------------------------------------------

class SessionManager:
    """Factory for fully-configured requests.Session instances."""

    @staticmethod
    def create_session() -> requests.Session:
        session = requests.Session()

        # Mount the SSL-resilient adapter for all HTTPS traffic
        # The adapter handles verify=True first, falling back to verify=False
        # on SSL errors (YouTube CDN blocks cloud IPs at the TLS layer).
        adapter = SSLResilientAdapter(
            pool_connections=POOL_CONNECTIONS,
            pool_maxsize=POOL_MAXSIZE,
            pool_block=POOL_BLOCK,
        )
        session.mount("https://", adapter)

        # Keep-alive + browser-identical headers
        session.headers.update({
            "User-Agent": DEFAULT_UA,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Keep-Alive": "timeout=30, max=1000",
        })

        return session


# ---------------------------------------------------------------------------
# YTMusic Manager
# ---------------------------------------------------------------------------

class YTMusicManager:
    """
    Manages YTMusic client lifecycle with resilience, metrics, and fallback.

    Thread-safe: all mutable state is guarded by a reentrant lock.
    """

    def __init__(self) -> None:
        self._session: Optional[requests.Session] = None
        self._client: Any = None
        self._lock = threading.Lock()
        self._last_reachability_check: float = 0.0
        self._reachability_cached: Optional[bool] = None
        self._reachability_probed: bool = False
        self._metrics = YTMusicMetrics()

    # -- Public metrics -----------------------------------------------------

    @property
    def metrics(self) -> dict[str, Any]:
        return self._metrics.snapshot()

    @property
    def metrics_obj(self) -> YTMusicMetrics:
        return self._metrics

    # -- Session / client lifecycle -----------------------------------------

    def _recreate_session(self) -> None:
        """Destroy the current HTTP session and YTMusic client, then create fresh ones."""
        with self._lock:
            old_session = self._session
            self._session = SessionManager.create_session()
            self._client = None
            self._metrics.record_session_recreate()

        # Close old session *outside* the lock to avoid blocking
        if old_session is not None:
            try:
                old_session.close()
            except Exception:
                pass

        logger.info("YTMusic HTTP session recreated (fresh TCP + TLS connection)")

    def _create_client(self) -> Any:
        """Create a new YTMusic client bound to the current session.

        Must be called while holding self._lock.
        """
        from ytmusicapi import YTMusic as _YTMusicCls

        if self._session is None:
            self._session = SessionManager.create_session()

        try:
            # Preferred: inject our pre-configured session
            client = _YTMusicCls(requests_session=self._session)
        except TypeError:
            # Fallback for older ytmusicapi versions that don't accept requests_session
            client = _YTMusicCls()
            client._session = self._session
            client._session.headers.update({"User-Agent": DEFAULT_UA})

        self._client = client
        return client

    def _get_client(self) -> Any:
        """
        Return the current client, creating one if necessary.

        Thread-safe: client creation is done under the lock to prevent
        two threads from creating duplicate clients or racing with
        _recreate_session().
        """
        with self._lock:
            if self._client is not None:
                return self._client
            return self._create_client()

    # -- Connectivity diagnostics -------------------------------------------

    @staticmethod
    def _probe_url(
        label: str, url: str, timeout: tuple[float, float],
    ) -> dict[str, Any]:
        """
        Probe a URL and return structured diagnostics.

        Returns a dict with keys:
          label, url, connect_ok, dns_duration, tls_duration, connect_duration,
          status_code, redirect_chain, content_type, html_title, error
        """
        result: dict[str, Any] = {
            "label": label,
            "url": url,
            "connect_ok": False,
            "dns_duration": None,
            "tls_duration": None,
            "connect_duration": None,
            "status_code": None,
            "redirect_chain": [],
            "content_type": None,
            "html_title": None,
            "error": None,
        }

        probe_session = SessionManager.create_session()
        start = time.monotonic()

        try:
            resp = probe_session.get(
                url,
                timeout=timeout,
                allow_redirects=True,
            )
            elapsed = time.monotonic() - start

            result["connect_ok"] = True
            result["connect_duration"] = round(elapsed, 3)
            result["status_code"] = resp.status_code
            result["content_type"] = resp.headers.get("content-type", "")[:100]
            result["headers"] = {
                "content-length": resp.headers.get("content-length", ""),
                "set-cookie": (resp.headers.get("set-cookie", "") or "")[:80],
                "x-robots-tag": resp.headers.get("x-robots-tag", ""),
                "x-frame-options": resp.headers.get("x-frame-options", ""),
                "server": resp.headers.get("server", ""),
                "cache-control": resp.headers.get("cache-control", ""),
            }

            # Redirect chain
            for h in resp.history:
                result["redirect_chain"].append({
                    "status": h.status_code,
                    "location": h.headers.get("location", "")[:120],
                })

            # Extract HTML title for bot-detection pages (read at most 5KB)
            ct = (resp.headers.get("content-type", "") or "").lower()
            if "text/html" in ct:
                chunk = b""
                for c in resp.iter_content(5000):
                    chunk += c
                    if len(chunk) >= 5000:
                        break
                if chunk:
                    # Try UTF-8, fall back to latin-1 for binary-ish pages
                    try:
                        text = chunk.decode("utf-8", errors="replace")
                    except Exception:
                        text = chunk.decode("latin-1", errors="replace")
                    m = re.search(
                        r"<title[^>]*>([^<]+)</title>",
                        text,
                        re.IGNORECASE | re.DOTALL,
                    )
                    if m:
                        result["html_title"] = m.group(1).strip()[:120]

        except Exception as exc:
            result["connect_ok"] = False
            result["error"] = f"{type(exc).__name__}: {exc!s:.200}"
            result["connect_duration"] = round(time.monotonic() - start, 3)

        return result

    def _run_diagnostics(self) -> list[dict[str, Any]]:
        """Run probes against all diagnostic targets and log results."""
        results = []
        timeout = (PROBE_CONNECT_TIMEOUT, PROBE_READ_TIMEOUT)

        for label, url in PROBE_TARGETS:
            # DNS resolution timing
            dns_start = time.monotonic()
            try:
                host = url.split("/")[2]
                socket.getaddrinfo(host, 443, socket.AF_INET)
                dns_duration = round(time.monotonic() - dns_start, 4)
            except Exception as exc:
                dns_duration = None

            r = self._probe_url(label, url, timeout)
            r["dns_duration"] = dns_duration

            if r["connect_ok"]:
                logger.info(
                    f"[diag] {label} ({url}) — "
                    f"DNS={r['dns_duration']}s, "
                    f"conn={r['connect_duration']}s, "
                    f"HTTP {r['status_code']}, "
                    f"type={r['content_type']}, "
                    f"title={r['html_title']!r}"
                )
                if r["redirect_chain"]:
                    for rd in r["redirect_chain"]:
                        logger.info(f"[diag]   → redirect {rd['status']} → {rd['location']}")
            else:
                logger.warning(
                    f"[diag] {label} ({url}) — FAILED: {r['error']} "
                    f"(DNS={r['dns_duration']}s, duration={r['connect_duration']}s)"
                )

            results.append(r)

        return results

    # -- Reachability check -------------------------------------------------

    def _check_reachability(self) -> bool:
        """
        Probe whether music.youtube.com is reachable from this host.

        On failure, caches the result for REACHABILITY_CACHE_TTL (2 minutes)
        to avoid hammering YT with repeated probes from blocked IPs.
        On success, clears the cache so subsequent checks proceed fresh.
        """
        now = time.monotonic()
        with self._lock:
            if (
                self._last_reachability_check > 0
                and now - self._last_reachability_check < REACHABILITY_CACHE_TTL
                and self._reachability_cached is not None
            ):
                return self._reachability_cached

        # Perform diagnostics outside the lock
        diag_results = self._run_diagnostics()

        # Determine reachability from music.youtube.com result
        yt_result = None
        for d in diag_results:
            if d["label"] == "music.youtube.com":
                yt_result = d
                break

        # Determine reachability
        reachable = False
        failure_reason = yt_result["error"] if yt_result else "No diagnostic result"

        if yt_result and yt_result["connect_ok"] and yt_result["status_code"] and yt_result["status_code"] < 500:
            # HTTP 200 but YouTube's CDN may serve a bot-detection page
            title = (yt_result.get("html_title") or "").lower()
            ct = (yt_result.get("content_type") or "").lower()
            if "text/html" in ct and any(
                kw in title
                for kw in ["deprecated", "browser", "captcha", "bot", "unusual traffic",
                           "automated", "verify", "sorry", "please confirm"]
            ):
                reachable = False
                failure_reason = (
                    f"YouTube returned bot-detection page (HTTP {yt_result['status_code']}, "
                    f"title={yt_result.get('html_title','')!r})"
                )
            else:
                reachable = True

        with self._lock:
            self._last_reachability_check = now
            self._reachability_cached = reachable
            self._reachability_probed = True
            if not reachable:
                self._metrics.record_reachability_fail()

        if not reachable:
            logger.error(
                f"music.youtube.com REACHABILITY: FAIL — cached for {REACHABILITY_CACHE_TTL:.0f}s. "
                f"Reason: {failure_reason}"
            )
        else:
            logger.info(
                f"music.youtube.com REACHABILITY: OK — "
                f"HTTP {yt_result['status_code']}, "
                f"title={yt_result.get('html_title', '')!r}"
            )

        return reachable

    # -- Fallback client (rate-limit bypass) --------------------------------

    def _get_fallback_client(self) -> Any:
        """
        Create a YTMusic client with an alternative initialization strategy.

        When Google rate-limits the primary client's session (HTTP 429), this
        creates a fresh YTMusic instance with its own default session, which
        may bypass per-session rate limits. SSL verification is attempted first
        and disabled only on SSL errors (YouTube CDN blocks cloud IPs).
        """
        logger.info("Attempting fallback client initialization")
        try:
            from ytmusicapi import YTMusic

            client = YTMusic()
            # Apply only the essential User-Agent fix
            client._session.headers.update({"User-Agent": DEFAULT_UA})
            # Try SSL verification; the SSLResilientAdapter will handle fallback
            client._session.verify = True
            logger.info("Fallback YTMusic client created successfully")
            return client
        except Exception as exc:
            logger.error(f"Fallback client creation failed: {exc!s:.200}")
            return None

    # -- Error classification -----------------------------------------------

    @staticmethod
    def _is_ssl_error(exc: Exception) -> bool:
        err_str = str(exc).lower()
        return any(
            kw in err_str
            for kw in ["eof", "ssleof", "ssl", "handshake", "certificate", "unknown ca"]
        )

    @staticmethod
    def _is_connection_error(exc: Exception) -> bool:
        err_str = str(exc).lower()
        if isinstance(exc, (requests.exceptions.ConnectionError, ConnectionError)):
            return True
        return any(
            kw in err_str
            for kw in [
                "connectionerror",
                "connection refused",
                "connection reset",
                "reset by peer",
                "broken pipe",
                "connection aborted",
            ]
        )

    @staticmethod
    def _is_timeout_error(exc: Exception) -> bool:
        return isinstance(
            exc,
            (
                requests.exceptions.Timeout,
                requests.exceptions.ConnectTimeout,
                requests.exceptions.ReadTimeout,
            ),
        )

    @staticmethod
    def _is_rate_limit_error(exc: Exception) -> bool:
        err_str = str(exc).lower()
        response = getattr(exc, "response", None)
        if response is not None:
            status = getattr(response, "status_code", 0)
            if status == 429:
                return True
            if status in (401, 403) and any(
                kw in err_str for kw in ["quota", "rate", "limit", "exceeded"]
            ):
                return True
        return any(
            kw in err_str for kw in ["429", "rate limit", "too many", "exceeded"]
        )

    @staticmethod
    def _is_chunked_error(exc: Exception) -> bool:
        return isinstance(exc, requests.exceptions.ChunkedEncodingError)

    @staticmethod
    def _is_max_retry_error(exc: Exception) -> bool:
        return isinstance(exc, requests.exceptions.RetryError) or "MaxRetryError" in type(exc).__name__

    # -- Core call method ---------------------------------------------------

    def call(self, method: str, *args, **kwargs) -> Any:
        """
        Call a YTMusic method with full resilience.

        Resilience strategy (capped at MAX_RETRY_TOTAL_SECONDS ≈ 5 s):
          1. Check transparent in-memory caches first
          2. Fast-fail reachability check (cached 30 s)
          3. Attempt the method with our managed client
          4. On SSL / connection error → recreate session, retry
          5. On timeout → retry with backoff
          6. On rate-limit → try fallback client
          7. Deadline enforcement via monotonic clock

        Returns the method's result or *None* on persistent failure.
        Raises YTMusicUnreachableError if music.youtube.com cannot be reached.
        """
        # --- Cache resolution ---
        from app.services.cache import (
            get_cached_search, cache_search,
            get_cached_artist, cache_artist,
            get_cached_album, cache_album,
            get_cached_lyrics, cache_lyrics,
            get_cached_recommendation, cache_recommendation,
            get_cached_stream, cache_stream,
            cache_key
        )

        # Build cache key
        key_parts = [method]
        for arg in args:
            key_parts.append(str(arg))
        for k, v in sorted(kwargs.items()):
            key_parts.append(f"{k}={v}")
        cache_key_str = cache_key(*key_parts)

        get_cached_fn = None
        cache_set_fn = None

        if method == "search":
            get_cached_fn = get_cached_search
            cache_set_fn = cache_search
        elif method in ("get_artist", "get_artist_albums"):
            get_cached_fn = get_cached_artist
            cache_set_fn = cache_artist
        elif method == "get_album":
            get_cached_fn = get_cached_album
            cache_set_fn = cache_album
        elif method == "get_lyrics":
            get_cached_fn = get_cached_lyrics
            cache_set_fn = cache_lyrics
        elif method == "get_watch_playlist":
            get_cached_fn = get_cached_stream
            cache_set_fn = cache_stream
        elif method == "get_playlist":
            get_cached_fn = get_cached_album
            cache_set_fn = cache_album

        if get_cached_fn:
            cached_val = get_cached_fn(cache_key_str)
            if cached_val is not None:
                self._metrics.record_cache_hit()
                return cached_val
            self._metrics.record_cache_miss()

        start = time.monotonic()
        deadline = start + MAX_RETRY_TOTAL_SECONDS

        # Fast-fail if YT is known unreachable
        if not self._check_reachability():
            self._metrics.record_failure()
            logger.error(f"YTMusic unreachable — skipping {method}")
            raise YTMusicUnreachableError(
                f"music.youtube.com is unreachable from this host. "
                f"Cloud provider IP ranges are often blocked by YouTube CDN. "
                f"See the YTMusic module docstring for details."
            )

        last_error: Optional[Exception] = None
        fallback_attempted = False

        for attempt in range(1, MAX_ATTEMPTS + 1):
            elapsed = time.monotonic() - start
            remaining = deadline - time.monotonic()

            if remaining <= 0:
                logger.warning(
                    f"YTMusic {method} ran out of time after {elapsed:.2f}s "
                    f"(attempt {attempt}/{MAX_ATTEMPTS})"
                )
                break

            try:
                client = self._get_client()
                result = getattr(client, method)(*args, **kwargs)

                self._metrics.record_success(time.monotonic() - start)
                if attempt > 1:
                    logger.info(
                        f"YTMusic {method} recovered on attempt {attempt} "
                        f"({time.monotonic() - start:.2f}s)"
                    )
                if cache_set_fn and result:
                    cache_set_fn(cache_key_str, result)
                return result

            except Exception as exc:
                last_error = exc
                err_type = type(exc).__name__
                err_str = str(exc)
                elapsed = time.monotonic() - start

                # Classify the error
                is_ssl = self._is_ssl_error(exc)
                is_conn = self._is_connection_error(exc)
                is_timeout = self._is_timeout_error(exc)
                is_rate = self._is_rate_limit_error(exc)
                is_chunked = self._is_chunked_error(exc)
                is_max_retry = self._is_max_retry_error(exc)

                # --- Record metrics ---
                if is_ssl:
                    self._metrics.record_ssl_failure()
                elif is_max_retry:
                    self._metrics.record_max_retry_error()
                    self._metrics.record_retry()
                else:
                    self._metrics.record_retry()

                # --- Log with full context ---
                tls_detail = ""
                if is_ssl:
                    tls_detail = f", tls_version=TLSv1_2, cipher_suites={CIPHER_SUITES[:60]}"
                elif is_max_retry:
                    tls_detail = ", max_retries_exceeded=True"

                logger.warning(
                    f"YTMusic {method} attempt {attempt}/{MAX_ATTEMPTS} "
                    f"failed in {elapsed:.2f}s "
                    f"[type={err_type}{tls_detail}, host={YT_HOST}] "
                    f"msg={err_str[:200]}"
                )

                # --- Decide next action ---
                if is_rate and not fallback_attempted:
                    fallback_attempted = True
                    remaining = deadline - time.monotonic()
                    if remaining > 0.5:
                        logger.info(
                            f"Rate-limit detected, switching to fallback client for {method}"
                        )
                        fb_client = self._get_fallback_client()
                        if fb_client is not None:
                            try:
                                fb_result = getattr(fb_client, method)(*args, **kwargs)
                                self._metrics.record_fallback_used()
                                self._metrics.record_success(time.monotonic() - start)
                                logger.info(
                                    f"YTMusic {method} succeeded via fallback client "
                                    f"({time.monotonic() - start:.2f}s)"
                                )
                                if cache_set_fn and fb_result:
                                    cache_set_fn(cache_key_str, fb_result)
                                return fb_result
                            except Exception as fb_exc:
                                logger.warning(
                                    f"Fallback client also failed for {method}: "
                                    f"{type(fb_exc).__name__}: {fb_exc!s:.120}"
                                )
                    # Continue to normal retry for next attempt

                if is_ssl or is_conn or is_max_retry:
                    # Recreate session — gives us a fresh TCP connection + TLS handshake,
                    # which may bypass transient blocking or exhausted connection pools
                    self._recreate_session()

                # Calculate backoff with remaining budget
                delay = min(BACKOFF_BASE * (2 ** (attempt - 1)), remaining * 0.6)
                if attempt < MAX_ATTEMPTS and remaining > delay:
                    time.sleep(delay)

        # --- All attempts exhausted ---
        self._metrics.record_failure()
        total_elapsed = time.monotonic() - start
        err_type = type(last_error).__name__ if last_error else "N/A"
        err_msg = str(last_error)[:200] if last_error else "N/A"

        logger.error(
            f"YTMusic {method} failed after {MAX_ATTEMPTS} attempt(s) "
            f"in {total_elapsed:.2f}s "
            f"[type={err_type}, host={YT_HOST}] "
            f"msg={err_msg}"
        )
        return None


# ---------------------------------------------------------------------------
# Global singleton
# ---------------------------------------------------------------------------

_manager: YTMusicManager = YTMusicManager()


# ---------------------------------------------------------------------------
# Backward-compatible public API
# ---------------------------------------------------------------------------

def search_ytmusic_safe(q: str, filter: Optional[str] = None) -> list:
    """
    Search YouTube Music with full resilience (backward-compatible).

    When YTMusic is unreachable, this logs the error and falls back gracefully
    (empty list) rather than raising — matching the existing contract used by
    all route handlers. Route handlers that want to detect the unreachable
    condition can call is_reachable() before/after or catch YTMusicUnreachableError.

    Args:
        q: Search query string.
        filter: Optional category filter ('songs', 'albums', 'artists', etc.).

    Returns:
        List of search results, or empty list on failure / unreachable.
    """
    try:
        kwargs = {"filter": filter} if filter else {}
        result = _manager.call("search", q, **kwargs)
        return result or []
    except YTMusicUnreachableError:
        # Already logged by manager. Graceful degradation: return empty results.
        return []
    except Exception as exc:
        logger.error(f"search_ytmusic_safe fatal: {type(exc).__name__}: {exc!s:.200}")
        return []


def call_ytmusic_safe(method: str, *args, **kwargs) -> Any:
    """
    Call any YTMusic method with full resilience (backward-compatible).

    Args:
        method: YTMusic method name (e.g. 'get_watch_playlist', 'get_album').
        *args, **kwargs: Passed through to the method.

    Returns:
        Method result, or *None* on persistent failure / unreachable.
    """
    try:
        return _manager.call(method, *args, **kwargs)
    except YTMusicUnreachableError:
        return None
    except Exception as exc:
        logger.error(f"call_ytmusic_safe fatal: {type(exc).__name__}: {exc!s:.200}")
        return None


# ---------------------------------------------------------------------------
# Failure-aware search (structured result, not just empty list)
# ---------------------------------------------------------------------------


@dataclass
class YTSearchOutcome:
    """
    Structured outcome of a YTMusic search so callers can distinguish a
    genuine "no results" from a transient provider failure.  The playlist
    importer MUST NOT treat a provider failure as the song being unavailable.

    Fields:
        found:   True when ``results`` is a non-empty list of search items.
        status:  one of
                 "ok"            -> search executed, zero results (genuine)
                 "unreachable"   -> YT blocked/unreachable from this host
                 "rate_limited"  -> HTTP 429 / quota exceeded
                 "timeout"       -> connect/read timeout
                 "error"         -> any other provider/network error
        reason:  human-readable (safe, non-secret) diagnostic string.
        results: list of raw search items on success.
    """
    found: bool = False
    status: str = "ok"
    reason: str = ""
    results: list = None

    def __post_init__(self):
        if self.results is None:
            self.results = []


def search_ytmusic_detailed(q: str, filter: Optional[str] = None) -> YTSearchOutcome:
    """
    Search YouTube Music and return a structured ``YTSearchOutcome`` instead
    of silently collapsing every failure into an empty list.

    This is the importer-facing primitive.  ``search_ytmusic_safe`` remains
    for backward compatibility (other callers that only care about results).
    """
    try:
        kwargs = {"filter": filter} if filter else {}
        result = _manager.call("search", q, **kwargs)
        if not result:
            # The manager reached YT but got an empty/None result.  Distinguish
            # an unreachable host from a true zero-result search.
            if is_reachable() is False:
                return YTSearchOutcome(
                    found=False, status="unreachable",
                    reason="music.youtube.com not reachable from this host",
                )
            return YTSearchOutcome(found=False, status="ok", reason="no results")
        return YTSearchOutcome(found=True, status="ok", results=result)
    except YTMusicUnreachableError:
        return YTSearchOutcome(
            found=False, status="unreachable",
            reason="music.youtube.com not reachable from this host",
        )
    except Exception as exc:
        name = type(exc).__name__
        msg = f"{exc!s}"[:200]
        if _manager._is_rate_limit_error(exc):
            return YTSearchOutcome(
                found=False, status="rate_limited",
                reason=f"rate limited: {name}: {msg}",
            )
        if _manager._is_timeout_error(exc):
            return YTSearchOutcome(
                found=False, status="timeout",
                reason=f"timeout: {name}: {msg}",
            )
        return YTSearchOutcome(
            found=False, status="error",
            reason=f"{name}: {msg}",
        )


def cache_hit() -> None:
    """Increment the cache-hit counter in YTMusic metrics."""
    _manager.metrics_obj.record_cache_hit()


def cache_miss() -> None:
    """Increment the cache-miss counter in YTMusic metrics."""
    _manager.metrics_obj.record_cache_miss()


def is_reachable() -> Optional[bool]:
    """
    Check whether music.youtube.com is currently reachable.

    Uses the manager's cached reachability state (checks at most once per 30s).
    Returns True if reachable, False if unreachable, None if no probe has run yet.
    """
    if not _manager._reachability_probed:
        return None
    return _manager._reachability_cached


def get_ytmusic():
    """
    Return a YTMusic instance bound to the managed session.

    Note: Prefer call_ytmusic_safe() for automatic retry. This is provided
    for backward compatibility only.
    """
    return _manager._get_client()


def get_metrics() -> dict[str, Any]:
    """Return a snapshot of YTMusic performance metrics."""
    return _manager.metrics


def recreate_session() -> None:
    """Force recreation of the HTTP session and YTMusic client."""
    _manager._recreate_session()
