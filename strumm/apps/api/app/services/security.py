import asyncio
import html
import httpcore
import httpx
import ipaddress
import os
import re
import secrets
import socket
import ssl
from typing import Any, Iterable, Optional, Tuple
from urllib.parse import urlparse

from bson import ObjectId
from fastapi import Header, HTTPException, status
from httpx import Timeout as HttpxTimeout


MAX_TEXT_LENGTH = 500
MAX_LONG_TEXT_LENGTH = 5000
YOUTUBE_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
# Canonical YouTube video ID format (base64url, exactly 11 chars).
YOUTUBE_VIDEO_ID_STRICT_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
# Podcast episodes use a synthetic "podcast-<ObjectId-hex>" videoId namespace.
PODCAST_EPISODE_ID_RE = re.compile(r"^podcast-[0-9a-fA-F]{24}$")
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,30}$")


def sanitize_text(value: Optional[str], *, max_length: int = MAX_TEXT_LENGTH) -> str:
    if value is None:
        return ""
    cleaned = " ".join(str(value).replace("\x00", "").split())
    cleaned = html.escape(cleaned, quote=True)
    return cleaned[:max_length]


def normalize_email(value: Optional[str]) -> str:
    """Return a canonical (lowercase, whitespace-free) email form.

    Every auth boundary that stores or looks up an email must pass through
    this so a given mailbox always maps to exactly one key: ``"Foo@Bar.com"``,
    ``" foo@bar.com "`` and ``"f o o@bar.com"`` all become ``foo@bar.com``.
    This closes account-confusion / enumeration-by-variant holes.
    """
    email = "".join(str(value or "").split()).lower()
    if len(email) > 254:
        raise ValueError("Invalid email address.")
    local, sep, domain = email.partition("@")
    if not sep or not local or not domain or "." not in domain:
        raise ValueError("Invalid email address.")
    return email


def sanitize_multiline_text(value: Optional[str], *, max_length: int = MAX_LONG_TEXT_LENGTH) -> str:
    if value is None:
        return ""
    cleaned = str(value).replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    cleaned = "\n".join(" ".join(line.split()) for line in cleaned.split("\n"))
    return html.escape(cleaned.strip(), quote=True)[:max_length]


def sanitize_username(value: str) -> str:
    username = sanitize_text(value, max_length=30).lower()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("Username must be 3-30 characters and use only lowercase letters, numbers, or underscores.")
    return username


def sanitize_youtube_id(value: str) -> str:
    video_id = sanitize_text(value, max_length=32)
    if not YOUTUBE_VIDEO_ID_RE.fullmatch(video_id):
        raise ValueError("Invalid YouTube video ID.")
    return video_id


def is_valid_youtube_id(value: Any) -> bool:
    """True iff ``value`` is a canonical YouTube video ID.

    Enforces the strict canonical format ``^[A-Za-z0-9_-]{11}$``. Leading and
    trailing whitespace is ignored for the check; callers persist the stripped
    form. Non-strings (int, None, dict…) are invalid.
    """
    if not isinstance(value, str):
        return False
    return bool(YOUTUBE_VIDEO_ID_STRICT_RE.fullmatch(value.strip()))


def sanitize_youtube_id_strict(value: Optional[str]) -> str:
    """Return the stripped canonical video ID or raise ValueError.

    Rejects anything that is not a well-formed 11-char YouTube video ID. This
    is the server-side trust-boundary validator for externally supplied
    YouTube video IDs (browser candidates, parsed provider IDs).
    """
    if not isinstance(value, str):
        raise ValueError("Invalid YouTube video ID.")
    cleaned = value.strip()
    if not YOUTUBE_VIDEO_ID_STRICT_RE.fullmatch(cleaned):
        raise ValueError("Invalid YouTube video ID.")
    return cleaned


def sanitize_enum(value: Optional[str], allowed: Iterable[str], default: str) -> str:
    allowed_values = set(allowed)
    cleaned = sanitize_text(value or default, max_length=40).lower()
    if cleaned not in allowed_values:
        raise ValueError(f"Value must be one of: {', '.join(sorted(allowed_values))}.")
    return cleaned


def sanitize_positive_int(value: int, *, minimum: int = 0, maximum: int = 3600) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError("Expected an integer value.")
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"Value must be between {minimum} and {maximum}.")
    return parsed


def escaped_regex(value: str) -> dict:
    return {"$regex": re.escape(sanitize_text(value, max_length=120)), "$options": "i"}


def validate_password_strength(password: str) -> dict:
    """Validate password strength.
    Returns {"valid": True/False, "message": str}.
    """
    if len(password) < 8:
        return {"valid": False, "message": "Password must be at least 8 characters long."}
    if len(password) > 128:
        return {"valid": False, "message": "Password must be no more than 128 characters long."}
    if not re.search(r"[A-Z]", password):
        return {"valid": False, "message": "Password must contain at least one uppercase letter."}
    if not re.search(r"[a-z]", password):
        return {"valid": False, "message": "Password must contain at least one lowercase letter."}
    if not re.search(r"[0-9]", password):
        return {"valid": False, "message": "Password must contain at least one number."}
    return {"valid": True, "message": "Password meets strength requirements."}


def parse_object_id(value: str) -> ObjectId:
    cleaned = sanitize_text(value, max_length=32)
    if not ObjectId.is_valid(cleaned):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid identifier.")
    return ObjectId(cleaned)


def get_admin_api_key() -> Optional[str]:
    key = os.getenv("ADMIN_API_KEY")
    return key if key and len(key) >= 24 else None


async def require_admin(x_admin_api_key: Optional[str] = Header(None)):
    expected = get_admin_api_key()
    if not expected:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not x_admin_api_key or not secrets.compare_digest(x_admin_api_key, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def assert_public_http_url(url: str) -> str:
    _public_target(url)
    return url


# ---------------------------------------------------------------------------
# DNS-pinned HTTP transport (SSRF hardening)
# ---------------------------------------------------------------------------
# ``assert_public_http_url`` resolves a hostname and validates every address at
# check time, but the actual TCP connection is made later by an ``httpx``
# client, which re-resolves the hostname on its own.  An attacker that can flip
# their DNS records between the check and the connect (DNS rebinding) could
# therefore point the connection at a private address (e.g. ``169.254.169.254``)
# without ever being caught.
#
# The transport below removes that window: the hostname is resolved exactly
# once, all addresses are validated as public, and the single validated IP is
# *pinned* into an ``httpcore`` network backend.  The pinned backend refuses to
# open a TCP connection to any host that was not pre-validated, and it resolves
# that host's IP itself (never letting the resolver run again).  TLS still
# validates the original hostname: ``start_tls`` is driven by the URL hostname,
# independent of the pinned TCP peer.

_SSRF_PINNED_TIMEOUT = HttpxTimeout(connect=5.0, read=10.0, write=5.0, pool=5.0)


def _is_public_address(addr) -> bool:
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


def _public_target(url: str) -> Tuple[str, str, str, int]:
    """Return ``(scheme, hostname, pinned_ip, port)`` for a public URL.

    Resolves DNS exactly once and validates **every** returned address; if any
    record is private/loopback/link-local the whole URL is rejected (a dual-
    stack host must not be allowed to pick the safe record at check time and
    connect through a malicious one).
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL must be http or https.")

    try:
        raw_port = parsed.port
    except ValueError:
        raise ValueError("URL port must be between 1 and 65535.")
    if raw_port is not None and not 1 <= raw_port <= 65535:
        raise ValueError("URL port must be between 1 and 65535.")

    hostname = parsed.hostname.lower()
    port = raw_port or (443 if parsed.scheme == "https" else 80)

    try:
        addr = ipaddress.ip_address(hostname)
    except ValueError:
        addr = None
    else:
        if not _is_public_address(addr):
            raise ValueError("Private or local URLs are not allowed.")
        return parsed.scheme, hostname, str(addr), port

    if hostname in {"localhost", "ip6-localhost"} or hostname.endswith((".local", ".localhost", ".internal")):
        raise ValueError("Private or local URLs are not allowed.")

    try:
        infos = socket.getaddrinfo(
            hostname, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
        )
    except socket.gaierror:
        raise ValueError("URL host could not be resolved.")

    resolved: list = []
    for info in infos:
        try:
            resolved.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            # Unparseable (e.g. zone-scoped link-local) — do not skip silently.
            raise ValueError("URL host could not be validated.")

    if not resolved:
        raise ValueError("URL host could not be resolved.")
    for addr in resolved:
        if not _is_public_address(addr):
            raise ValueError("Private or local URLs are not allowed.")
    return parsed.scheme, hostname, str(resolved[0]), port


def _open_pinned_socket(ip: str, port: int, timeout: float) -> socket.socket:
    sock = socket.create_connection((ip, port), timeout=timeout)
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass
    return sock


class _PinnedNetworkStream(httpcore.AsyncNetworkStream):
    """Asyncio network stream over a socket connected to a pinned IP."""

    def __init__(self, sock: socket.socket):
        self._sock = sock
        self._eof = False

    async def read(self, max_bytes: int, timeout: Optional[float] = None) -> bytes:
        if self._eof:
            return b""
        if timeout is not None:
            self._sock.settimeout(timeout)
        try:
            data = await asyncio.to_thread(self._sock.recv, max_bytes)
        except socket.timeout as exc:
            raise httpcore.ReadTimeout(str(exc)) from exc
        except (ConnectionError, OSError) as exc:
            raise httpcore.ReadError(str(exc)) from exc
        if not data:
            self._eof = True
        return data

    async def write(self, buffer: bytes, timeout: Optional[float] = None) -> None:
        if timeout is not None:
            self._sock.settimeout(timeout)
        try:
            await asyncio.to_thread(self._sock.sendall, buffer)
        except socket.timeout as exc:
            raise httpcore.WriteTimeout(str(exc)) from exc
        except (ConnectionError, OSError) as exc:
            raise httpcore.WriteError(str(exc)) from exc

    async def aclose(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass

    async def start_tls(
        self,
        ssl_context: ssl.SSLContext,
        server_hostname: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> httpcore.AsyncNetworkStream:
        if timeout is not None:
            self._sock.settimeout(timeout)
        try:
            wrapped = await asyncio.to_thread(
                ssl_context.wrap_socket,
                self._sock,
                server_hostname=server_hostname,
                do_handshake_on_connect=False,
            )
        except OSError as exc:
            raise httpcore.ConnectError(str(exc)) from exc
        try:
            await asyncio.to_thread(wrapped.do_handshake)
        except OSError as exc:
            raise httpcore.ConnectError(str(exc)) from exc
        return _PinnedNetworkStream(wrapped)

    def get_extra_info(self, info: str) -> Optional[Any]:
        if info == "socket":
            return self._sock
        try:
            return {
                "sockname": self._sock.getsockname,
                "peername": self._sock.getpeername,
            }[info]()
        except (KeyError, OSError):
            return None


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Backend that only opens connections to pre-validated, pinned IPs.

    ``host`` here is the **URL hostname**; the TCP connection goes to the pinned
    IP for that host.  Any host absent from the pin map is refused outright, so
    a re-resolution (which is what makes DNS rebinding work) can never happen.
    """

    def __init__(self, pins: dict[str, str]):
        self._pins = dict(pins)

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: Optional[float] = None,
        local_address: Optional[str] = None,
        socket_options: Optional[Iterable] = None,
    ) -> httpcore.AsyncNetworkStream:
        ip = self._pins.get(host)
        if ip is None:
            raise httpcore.ConnectError(
                "Connection host must be pre-validated (DNS-pinned)."
            )
        try:
            sock = await asyncio.to_thread(
                _open_pinned_socket, ip, port, timeout if timeout is not None else 5.0
            )
        except OSError as exc:
            raise httpcore.ConnectError(str(exc)) from exc
        return _PinnedNetworkStream(sock)

    async def connect_unix_socket(self, path: str, timeout=None, socket_options=None):
        raise httpcore.ConnectError(
            "Unix sockets are not supported by the pinned transport."
        )

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class _PinnedResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream):
        self._stream = stream

    async def __aiter__(self):
        try:
            async for chunk in self._stream:
                yield chunk
        finally:
            await self._stream.aclose()


class _PinnedClientTransport(httpx.AsyncBaseTransport):
    """httpx transport backed by a DNS-pinned ``httpcore`` connection pool."""

    def __init__(self, pool: httpcore.AsyncConnectionPool):
        self._pool = pool

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        import httpcore
        from httpx._transports.default import map_httpcore_exceptions

        req = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions,
        )
        with map_httpcore_exceptions():
            resp = await self._pool.handle_async_request(req)
        return httpx.Response(
            status_code=resp.status,
            headers=resp.headers,
            stream=_PinnedResponseStream(resp.stream),
            extensions=resp.extensions,
            request=request,
        )

    async def aclose(self) -> None:
        await self._pool.aclose()


def create_pinned_client(url: str, *, timeout: HttpxTimeout = _SSRF_PINNED_TIMEOUT) -> httpx.AsyncClient:
    """Create an ``httpx.AsyncClient`` whose single URL host is DNS-pinned.

    The hostname in ``url`` is resolved and validated exactly once; every
    connection is then made against the validated public IP, with the original
    hostname still used for TLS (SNI + certificate verification).  Only ``url``'s
    host may be reached — redirects and other hosts are refused by the pool.
    """
    scheme, hostname, ip, port = _public_target(url)
    pool = httpcore.AsyncConnectionPool(
        max_connections=10,
        max_keepalive_connections=2,
        keepalive_expiry=30,
        http1=True,
        http2=False,
        retries=0,
        network_backend=_PinnedNetworkBackend({hostname: ip}),
    )
    return httpx.AsyncClient(
        transport=_PinnedClientTransport(pool),
        timeout=timeout,
        follow_redirects=False,
        headers={"User-Agent": "Strumm/1.0 (https://strumm.me)"},
    )
