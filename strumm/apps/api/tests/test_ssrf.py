"""Regression tests for SSRF hardening (PHASE 6).

Domain: ``app/services/security.py`` (``assert_public_http_url``, piped-DNS
transport), ``app/services/http_client.py`` (``safe_http_get``) and the media
proxy routes in ``app/routes/stream.py``.

The core guarantee tested here: a URL's hostname is resolved **exactly once**,
validated as public, and then **pinned** — no later re-resolution can redirect
the TCP connection at an internal address (DNS rebinding / TOCTOU).
"""

import asyncio
from types import SimpleNamespace

import httpcore
import httpx
import pytest
import socket

from app.services import security


class _LocalDNS:
    """Stand-in for ``socket.getaddrinfo`` returning canned records."""

    def __init__(self, records):
        self._records = records

    def __call__(self, hostname, port, **kwargs):
        if not self._records:
            raise socket.gaierror(8, "Name or service not known")
        return self._records


PUBLIC_A = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))
PRIVATE_A = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))


# ---------------------------------------------------------------------------
# URL validation (check-time)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://127.0.0.2/",
        "http://10.0.0.5/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://0.0.0.0/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:169.254.169.254]/",
    ],
)
def test_rejects_private_literal_addresses(url):
    with pytest.raises(ValueError, match=r"not allowed"):
        security._public_target(url)
    with pytest.raises(ValueError):
        security.assert_public_http_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/",
        "http://localhost.localhost/",
        "http://foo.local/",
        "http://metadata.google.internal/latest/meta-data/",
        "http://foo.internal/x",
    ],
)
def test_rejects_private_hostnames_without_resolving(url, monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("resolver must not be contacted for known-private names")

    monkeypatch.setattr(security.socket, "getaddrinfo", boom)
    with pytest.raises(ValueError, match=r"not allowed"):
        security._public_target(url)


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd", "gopher://x"])
def test_rejects_non_http_schemes(url):
    with pytest.raises(ValueError, match=r"http or https"):
        security._public_target(url)


@pytest.mark.parametrize("port", [0, -1, 65536, 99999])
@pytest.mark.parametrize("host", ["good-host.example.com", "1.2.3.4"])
def test_rejects_invalid_ports(host, port, monkeypatch):
    if not host[0].isdigit():
        monkeypatch.setattr(security.socket, "getaddrinfo", _LocalDNS([PUBLIC_A]))
    with pytest.raises(ValueError, match=r"port"):
        security._public_target(f"http://{host}:{port}/")


def test_accepts_public_hostname_and_returns_pin(monkeypatch):
    monkeypatch.setattr(
        security.socket,
        "getaddrinfo",
        _LocalDNS(
            [
                PUBLIC_A,
                (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1::1", 80)),
            ]
        ),
    )
    scheme, hostname, ip, port = security._public_target("http://Example.COM/audio.m4a")
    assert (scheme, hostname, ip, port) == ("http", "example.com", "93.184.216.34", 80)


def test_rejects_if_any_resolved_record_is_private(monkeypatch):
    monkeypatch.setattr(security.socket, "getaddrinfo", _LocalDNS([PUBLIC_A, PRIVATE_A]))
    with pytest.raises(ValueError, match=r"not allowed"):
        security._public_target("http://rebinding.example.com/")


def test_rejects_unparseable_scoped_record(monkeypatch):
    scoped = (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fe80::1%ens3", 80))
    monkeypatch.setattr(security.socket, "getaddrinfo", _LocalDNS([scoped]))
    with pytest.raises(ValueError, match=r"not allowed"):
        security._public_target("http://scopey.example.com/")


def test_rejects_unresolvable_hostname(monkeypatch):
    monkeypatch.setattr(security.socket, "getaddrinfo", _LocalDNS([]))
    with pytest.raises(ValueError, match=r"could not be resolved"):
        security._public_target("http://nope.invalid/x")


def test_create_pinned_client_resolves_once(monkeypatch):
    calls = []

    def recording(hostname, port, **kwargs):
        calls.append(hostname)
        return [PUBLIC_A]

    monkeypatch.setattr(security.socket, "getaddrinfo", recording)
    client = security.create_pinned_client("http://cdn.example.com/a.m4a")
    try:
        assert isinstance(client, httpx.AsyncClient)
        assert calls == ["cdn.example.com"]
        assert client.follow_redirects is False
    finally:
        asyncio.run(client.aclose())


# ---------------------------------------------------------------------------
# Pinned network backend (connect-time)
# ---------------------------------------------------------------------------


class _StubSocket:
    pass


def test_backend_connects_to_pinned_ip(monkeypatch):
    recorded = {}

    def fake_open(ip, port, timeout):
        recorded["ip"] = ip
        recorded["port"] = port
        return _StubSocket()

    monkeypatch.setattr(security, "_open_pinned_socket", fake_open)
    backend = security._PinnedNetworkBackend({"stream.example.com": "93.184.216.34"})

    stream = asyncio.run(backend.connect_tcp("stream.example.com", 443, timeout=5.0))
    assert isinstance(stream, security._PinnedNetworkStream)
    assert recorded == {"ip": "93.184.216.34", "port": 443}


def test_backend_refuses_unpinned_host_and_unix_sockets(monkeypatch):
    def fake_open(ip, port, timeout):
        raise AssertionError("must not connect for an unpinned host")

    monkeypatch.setattr(security, "_open_pinned_socket", fake_open)
    backend = security._PinnedNetworkBackend({"ok.example.com": "93.184.216.34"})

    with pytest.raises(httpcore.ConnectError, match=r"pre-validated"):
        asyncio.run(backend.connect_tcp("evil.example.com", 80, timeout=5.0))
    with pytest.raises(httpcore.ConnectError, match=r"not supported"):
        asyncio.run(backend.connect_unix_socket("/var/run/x.sock"))


def test_dns_rebinding_flip_does_not_reach_resolver(monkeypatch):
    """After the client is created the resolver may change; the connection
    must still go to the originally validated public IP even if DNS now points
    the same host at a private address."""
    resolve_calls = []

    def resolving(hostname, port, **kwargs):
        resolve_calls.append((hostname, port))
        return [PUBLIC_A]

    monkeypatch.setattr(security.socket, "getaddrinfo", resolving)
    client = security.create_pinned_client("http://cdn.example.com/song.m4a")

    # The attacker's DNS now flips the same host to a private address.
    monkeypatch.setattr(security.socket, "getaddrinfo", _LocalDNS([PRIVATE_A]))

    recorded = {}

    def fake_open(ip, port, timeout):
        recorded["ip"] = ip
        raise OSError("connection refused")

    monkeypatch.setattr(security, "_open_pinned_socket", fake_open)

    try:
        with pytest.raises(httpx.ConnectError):
            asyncio.run(client.get("http://cdn.example.com/song.m4a"))
    finally:
        asyncio.run(client.aclose())

    # The TCP connect used the pinned public IP — the private flip was ignored.
    assert recorded == {"ip": "93.184.216.34"}
    assert resolve_calls == [("cdn.example.com", 80)]


def test_pinned_transport_unknown_request_host_refused():
    """A request for a host that was never pinned is refused at connect."""
    pool = httpcore.AsyncConnectionPool(
        http1=True,
        network_backend=security._PinnedNetworkBackend({"ok.example.com": "93.184.216.34"}),
    )
    client = httpx.AsyncClient(
        transport=security._PinnedClientTransport(pool), follow_redirects=False
    )
    try:
        with pytest.raises(httpx.ConnectError):
            asyncio.run(client.get("http://other.example.com/x"))
    finally:
        asyncio.run(client.aclose())


# ---------------------------------------------------------------------------
# safe_http_get — redirect chain re-pins every hop
# ---------------------------------------------------------------------------


def test_safe_http_get_repins_each_redirect_hop(monkeypatch):
    hops = []

    class FakeClient:
        def __init__(self, first_hop_redirects: bool):
            self._first_hop_redirects = first_hop_redirects

        async def get(self, url, **kwargs):
            hops.append(url)
            if self._first_hop_redirects:
                self._first_hop_redirects = False
                return httpx.Response(
                    302,
                    headers={"location": "https://cdn2.example.com/final.png"},
                    request=httpx.Request("GET", url),
                )
            return httpx.Response(200, text="img", request=httpx.Request("GET", url))

        async def aclose(self):
            pass

    def fake_create(url, *a, **kw):
        return FakeClient(first_hop_redirects=(len(hops) == 0))

    monkeypatch.setattr(security, "create_pinned_client", fake_create)

    from app.services.http_client import safe_http_get

    resp = asyncio.run(safe_http_get("https://a.example.com/img.png"))
    assert resp.status_code == 200
    assert hops == ["https://a.example.com/img.png", "https://cdn2.example.com/final.png"]


def test_safe_http_get_rejects_private_first_hop(monkeypatch):
    from app.services.http_client import safe_http_get

    def fake_create(url, *a, **kw):
        raise ValueError("Private or local URLs are not allowed.")

    monkeypatch.setattr(security, "create_pinned_client", fake_create)
    with pytest.raises(ValueError, match=r"not allowed"):
        asyncio.run(safe_http_get("http://127.0.0.1/x.png"))


# ---------------------------------------------------------------------------
# Media-proxy endpoints
# ---------------------------------------------------------------------------


def test_audio_proxy_rejects_private_url():
    from fastapi import HTTPException
    from app.routes.stream import proxy_audio

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            proxy_audio(request=SimpleNamespace(headers={}), url="http://127.0.0.1/a.mp4")
        )
    assert exc_info.value.status_code == 400


def test_image_proxy_rejects_private_url():
    from fastapi import HTTPException
    from app.routes.stream import proxy_image

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(proxy_image(url="http://169.254.169.254/x.png", w=0, quality=80))
    assert exc_info.value.status_code == 502

# ---------------------------------------------------------------------------
# TEST-02: endpoint happy paths with the pinned transport
# ---------------------------------------------------------------------------

from app.services import http_client as http_client_mod


async def _drain(iterator):
    return [chunk async for chunk in iterator]


def test_audio_proxy_streams_from_pinned_client(monkeypatch):
    import base64
    import asyncio
    import hashlib

    from fastapi.responses import StreamingResponse
    from app.routes.stream import proxy_audio

    class _FakeResp:
        status_code = 200
        headers = {"content-type": "audio/mp4", "content-length": "5"}

        async def aiter_raw(self):
            yield b"hello"
            yield b"!"

        async def aclose(self):
            pass

    class _FakeClient:
        def __init__(self, url):
            self.url = url

        def build_request(self, method, url, headers):
            return (method, url, headers)

        async def send(self, req, stream=False):
            return _FakeResp()

        async def aclose(self):
            pass

    monkeypatch.setattr(security, "create_pinned_client", _FakeClient)
    response = asyncio.run(
        proxy_audio(request=SimpleNamespace(headers={"range": "bytes=0-5"}), url="https://cdn.example.com/song.m4a")
    )

    assert isinstance(response, StreamingResponse)
    chunks = asyncio.run(_drain(response.body_iterator))
    assert b"".join(chunks) == b"hello!"
    assert response.headers["content-type"] == "audio/mp4"


def test_image_proxy_returns_optimized_payload_on_public_url(monkeypatch):
    import base64
    import asyncio

    from app.routes.stream import proxy_image

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    fake_resp = httpx.Response(200, content=png, headers={"content-type": "image/png"})
    fake_resp.request = httpx.Request("GET", "https://cdn.example.com/x.png")

    async def fake_safe_http_get(url, timeout=8.0):
        return fake_resp

    monkeypatch.setattr(http_client_mod, "safe_http_get", fake_safe_http_get)

    response = asyncio.run(proxy_image(url="https://cdn.example.com/x.png", w=0, quality=80))
    assert response.status_code == 200
    # Optimization re-encodes (lossy), so assert it's a still-valid image.
    assert response.body.startswith(b"\x89PNG\r\n")
    assert response.headers["content-type"].startswith("image/")


def test_podcast_audio_rejects_private_url():
    from fastapi import HTTPException
    from app.routes.stream import stream_podcast_audio

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(stream_podcast_audio(url="http://192.168.1.1/episode.mp3", quality="balanced"))
    assert exc_info.value.status_code == 502
