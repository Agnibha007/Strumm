"""
Sensitive-value redaction for log output.

Production logs must never contain credentials. The concrete leak that
motivated this: the shared ``httpx`` client logs ``HTTP Request: GET
https://oauth2.googleapis.com/tokeninfo?id_token=eyJ...`` at DEBUG level, and
Sentry breadcrumbs record the same URL with the id_token query parameter.
Both channels are covered here:

* :func:`redact_sensitive` — masks sensitive query parameters in any string
  (``id_token``, ``access_token``, ``refresh_token``, ``token``, ``code``,
  authorization-related credentials, API keys, signatures, ...). The original
  value is replaced with ``[REDACTED]`` and never written to the output.
* :class:`SensitiveQueryFilter` — a :class:`logging.Filter` that applies the
  same redaction to every record that passes through it.
* :func:`install_log_redaction` — attaches the filter to the ``httpx`` /
  ``httpcore`` loggers (the sources of request-URL log lines) AND to the root
  logger, so no child logger can emit a sensitive query value either.
* :func:`redact_sentry_breadcrumb` — a ``before_breadcrumb`` hook for
  ``sentry_sdk.init`` that strips sensitive query params from breadcrumb
  ``url`` / ``message`` fields.

The regex only matches query parameters (``?`` / ``&`` followed by the
parameter name) so ordinary log content is untouched, and it never needs to
know the actual secret value to mask it.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

# Query parameter names whose values are secrets. Matched case-insensitively.
_SENSITIVE_PARAMS = (
    "id_token",
    "access_token",
    "refresh_token",
    "token",
    "code",
    "auth",
    "authorization",
    "apikey",
    "api_key",
    "key",
    "sig",
    "signature",
    "secret",
    "password",
    "passwd",
    "credential",
    "oauth",
    "client_secret",
)

_SENSITIVE_RE = re.compile(
    r"(?i)([?&](?:" + "|".join(re.escape(p) for p in _SENSITIVE_PARAMS) + r")=)[^&\s\"'<>]+"
)

REDACTED = "[REDACTED]"


def redact_sensitive(text: Any) -> Any:
    """Mask sensitive query parameters in ``text`` (str in -> str out).

    Non-string input is returned unchanged so the function is safe to apply to
    arbitrary record attributes.
    """
    if not isinstance(text, str):
        return text
    return _SENSITIVE_RE.sub(rf"\1{REDACTED}", text)


def _redact_arg(arg: Any) -> Any:
    if isinstance(arg, str):
        return redact_sensitive(arg)
    s = str(arg)
    redacted = redact_sensitive(s)
    if redacted != s:
        return redacted
    return arg


class SensitiveQueryFilter(logging.Filter):
    """Logging filter that redacts sensitive query params in every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_sensitive(record.msg)
        if record.args:
            if isinstance(record.args, tuple):
                record.args = tuple(_redact_arg(a) for a in record.args)
            elif isinstance(record.args, list):
                record.args = [_redact_arg(a) for a in record.args]
            elif isinstance(record.args, dict):
                record.args = {k: _redact_arg(v) for k, v in record.args.items()}
        return True


_root_filter: Optional[SensitiveQueryFilter] = None


def install_log_redaction() -> None:
    """Attach the redaction filter to the httpx/httpcore loggers, the root, and all handlers.

    Idempotent: repeated calls (e.g. app re-import in tests) do not stack
    duplicate filters. Attaching to the root and its handlers covers every
    logger in the process — a future code path cannot accidentally reintroduce the leak.
    """
    global _root_filter
    filt = SensitiveQueryFilter()
    for name in ("httpx", "httpcore", "root"):
        logger_ = logging.getLogger() if name == "root" else logging.getLogger(name)
        existing = any(
            isinstance(f, SensitiveQueryFilter) for f in (logger_.filters or [])
        )
        if not existing:
            logger_.addFilter(filt)

    for h in logging.getLogger().handlers:
        existing = any(
            isinstance(f, SensitiveQueryFilter) for f in (h.filters or [])
        )
        if not existing:
            h.addFilter(filt)


def redact_sentry_breadcrumb(crumb: dict, hint: dict) -> dict:
    """``before_breadcrumb`` hook for Sentry: redact URLs and messages.

    Returns the (possibly modified) crumb. Messages and ``data.url`` fields are
    passed through :func:`redact_sensitive`, so an OAuth tokeninfo request can
    never be recorded with its ``id_token`` intact.
    """
    if crumb.get("message"):
        crumb["message"] = redact_sensitive(crumb["message"])
    data = crumb.get("data")
    if isinstance(data, dict):
        for key in ("url", "path", "query_string"):
            if isinstance(data.get(key), str):
                data[key] = redact_sensitive(data[key])
        # httpx breadcrumbs store the URL under ``url``; also cover the generic
        # ``http.request`` bodies that may embed a URL string.
        for key in list(data.keys()):
            if isinstance(data[key], str) and ("http://" in data[key] or "https://" in data[key]):
                data[key] = redact_sensitive(data[key])
    return crumb