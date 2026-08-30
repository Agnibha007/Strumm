"""Tests for the YTMusic residential-egress proxy layer.

The ytmusic module reads ZENROWS_PROXY_URL / ZENROWS_PROXY_ENABLED at import
time, so these tests monkeypatch the environment and then re-import the module
to exercise the enabled/disabled paths.
"""

import importlib
import os
import pytest

import app.services.ytmusic as yt


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Ensure no ambient proxy vars leak into tests and reload between cases."""
    monkeypatch.delenv("ZENROWS_PROXY_URL", raising=False)
    monkeypatch.delenv("ZENROWS_PROXY_ENABLED", raising=False)
    yield
    # Restore the originally-imported module state for any later modules.
    importlib.reload(yt)


def _reload_with(proxy_url):
    if proxy_url is None:
        os.environ.pop("ZENROWS_PROXY_URL", None)
    else:
        os.environ["ZENROWS_PROXY_URL"] = proxy_url
    os.environ.pop("ZENROWS_PROXY_ENABLED", None)
    return importlib.reload(yt)


class TestProxyConfig:
    def test_disabled_when_no_url(self):
        mod = _reload_with(None)
        assert mod._proxy_is_enabled() is False
        assert mod._proxies_config() is None

    def test_enabled_with_url(self):
        url = "http://u:p@superproxy.zenrows.com:1337"
        mod = _reload_with(url)
        assert mod._proxy_is_enabled() is True
        assert mod._proxies_config() == {"http": url, "https": url}

    def test_explicitly_disabled_even_with_url(self, monkeypatch):
        os.environ["ZENROWS_PROXY_ENABLED"] = "false"
        mod = importlib.reload(yt)
        assert mod._proxy_is_enabled() is False

    def test_proxy_enabled_flag_defaults_to_true_when_url_set(self):
        mod = _reload_with("http://u:p@superproxy.zenrows.com:1337")
        assert mod._proxy_is_enabled() is True


class TestSessionProxyAttach:
    def test_session_proxies_when_enabled(self):
        url = "http://u:p@superproxy.zenrows.com:1337"
        mod = _reload_with(url)
        session = mod.SessionManager.create_session()
        assert session.proxies["https"] == url
        assert session.proxies["http"] == url
        # Explicit proxy should not be overridden by ambient env.
        assert session.trust_env is False

    def test_session_no_proxy_when_disabled(self):
        mod = _reload_with(None)
        session = mod.SessionManager.create_session()
        assert session.proxies == {}
        assert session.trust_env is True


class TestProxyAdapterTls:
    def test_proxy_manager_uses_chrome_ssl_context(self):
        url = "http://u:p@superproxy.zenrows.com:1337"
        mod = _reload_with(url)
        session = mod.SessionManager.create_session()
        adapter = session.get_adapter("https://music.youtube.com/x")
        pm = adapter.proxy_manager_for(url)
        assert "ssl_context" in pm.connection_pool_kw
        assert pm.connection_pool_kw["ssl_context"] is adapter._ssl_ctx_verified

    def test_proxy_manager_negotiates_tls1_2_only(self):
        import ssl as stdlib_ssl

        url = "http://u:p@superproxy.zenrows.com:1337"
        mod = _reload_with(url)
        session = mod.SessionManager.create_session()
        adapter = session.get_adapter("https://music.youtube.com/x")
        pm = adapter.proxy_manager_for(url)
        ctx = pm.connection_pool_kw["ssl_context"]
        min_version = ctx.minimum_version
        max_version = ctx.maximum_version
        assert min_version == stdlib_ssl.TLSVersion.TLSv1_2
        assert max_version == stdlib_ssl.TLSVersion.TLSv1_2
