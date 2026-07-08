"""
Groq AI provider — single point of contact for all AI requests
(recommendations, chat, smart playlists, etc.).

Uses the OpenAI-compatible Groq API for fast inference.

Environment variables:
  GROQ_API_KEY  — Groq API key (https://console.groq.com/keys)
  GROQ_MODEL    — optional, defaults to llama-3.3-70b-versatile
"""

from __future__ import annotations

import json
import os
import re
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger("strumm-groq-provider")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class GroqProvider:
    """Encapsulates all Groq API interactions.

    Drop-in replacement for HuggingFaceProvider — same public interface so
    consuming routes (recommendation.py) work without changes.
    """

    def __init__(self) -> None:
        if not GROQ_API_KEY:
            logger.warning(
                "GROQ_API_KEY is not set — AI features will be degraded / fall back."
            )

    # -- public helpers -----------------------------------------------------

    @property
    def configured(self) -> bool:
        return bool(GROQ_API_KEY)

    # -- chat completions (used by explore-chat, flow, recommendations) -----

    async def chat_completion(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.6,
        max_tokens: int = 1024,
        timeout: float = 8.0,
        response_format: Optional[dict] = None,
    ) -> Optional[str]:
        """Send a chat-completion request and return the assistant's text content."""
        if not self.configured:
            logger.warning("Groq not configured; cannot call chat_completion.")
            return None

        headers = {
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": GROQ_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            payload["response_format"] = response_format

        try:
            from app.services.http_client import get_http_client
            client = get_http_client()
            resp = await client.post(
                GROQ_CHAT_URL,
                headers=headers,
                json=payload,
                timeout=timeout,
            )

            if resp.status_code != 200:
                logger.error(
                    f"Groq chat_completion HTTP {resp.status_code}: {resp.text[:300]}"
                )
                return None

            data = resp.json()
            choice = data.get("choices", [{}])[0]
            content = choice.get("message", {}).get("content", "")
            return content.strip()

        except httpx.TimeoutException:
            logger.warning("Groq chat_completion timed out.")
            return None
        except Exception as exc:
            logger.error(f"Groq chat_completion error: {type(exc).__name__}: {exc}")
            return None

    # -- structured JSON extraction (recommendations, curator chat) --------

    async def extract_json(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.1,
        timeout: float = 15.0,
    ) -> Optional[Any]:
        """Request JSON output from the model and parse it.

        Uses Groq's JSON mode (response_format: json_object) to constrain
        the model to produce valid JSON, eliminating parsing failures.
        For structured / extraction tasks, temperature should be kept low
        (default 0.1) to maximize determinism.
        """
        content = await self.chat_completion(
            messages,
            temperature=temperature,
            timeout=timeout,
            response_format={"type": "json_object"},
        )
        if not content:
            return None

        # Strip markdown code fences if present
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```\w*\n|```$", "", cleaned, flags=re.MULTILINE).strip()

        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as exc:
            logger.warning(
                f"Groq extract_json failed to parse response: {exc}. "
                f"Raw: {content[:200]}"
            )
            return None


# ---------------------------------------------------------------------------
# Singleton convenience
# ---------------------------------------------------------------------------

_provider: GroqProvider = GroqProvider()


def get_ai_provider() -> GroqProvider:
    return _provider
