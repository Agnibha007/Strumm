"""
HuggingFace Inference API provider — single point of contact for all AI
requests (recommendations, chat, smart playlists, etc.).

Environment variables:
  HF_API_KEY  — Hugging Face access token (https://huggingface.co/settings/tokens)
  HF_BASE_URL — optional, defaults to https://api-inference.huggingface.co
  HF_MODEL    — optional, defaults to deepseek-ai/DeepSeek-R1-Distill-Qwen-32B
"""

from __future__ import annotations

import json
import os
import re
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger("strumm-hf-provider")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HF_API_KEY = os.getenv("HF_API_KEY", "")
HF_BASE_URL = os.getenv("HF_BASE_URL", "https://api-inference.huggingface.co").rstrip("/")
HF_MODEL = os.getenv("HF_MODEL", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B")

HF_CHAT_URL = f"{HF_BASE_URL}/models/{HF_MODEL}/v1/chat/completions"

# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class HuggingFaceProvider:
    """Encapsulates all Hugging Face Inference API interactions.

    Every AI-calling route in the backend should go through this class so
    that secrets stay server-side and the integration point is easy to
    audit / swap in the future.
    """

    def __init__(self) -> None:
        if not HF_API_KEY:
            logger.warning(
                "HF_API_KEY is not set — AI features will be degraded / fall back."
            )

    # -- public helpers -----------------------------------------------------

    @property
    def configured(self) -> bool:
        return bool(HF_API_KEY)

    # -- chat completions (used by explore-chat, flow, recommendations) -----

    async def chat_completion(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.6,
        max_tokens: int = 1024,
        timeout: float = 8.0,
    ) -> Optional[str]:
        """Send a chat-completion request and return the assistant's text content."""
        if not self.configured:
            logger.warning("HF not configured; cannot call chat_completion.")
            return None

        headers = {
            "Authorization": f"Bearer {HF_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": HF_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    HF_CHAT_URL,
                    headers=headers,
                    json=payload,
                    timeout=timeout,
                )

            if resp.status_code != 200:
                logger.error(
                    f"HF chat_completion HTTP {resp.status_code}: {resp.text[:300]}"
                )
                return None

            data = resp.json()
            choice = data.get("choices", [{}])[0]
            content = choice.get("message", {}).get("content", "")
            return content.strip()

        except httpx.TimeoutException:
            logger.warning("HF chat_completion timed out.")
            return None
        except Exception as exc:
            logger.error(f"HF chat_completion error: {type(exc).__name__}: {exc}")
            return None

    # -- structured JSON extraction (recommendations, curator chat) --------

    async def extract_json(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.6,
        timeout: float = 10.0,
    ) -> Optional[Any]:
        """Request JSON output from the model and parse it.

        The caller's prompt should instruct the model to return raw JSON.
        This method strips markdown fences and returns the parsed object,
        or None on failure.
        """
        content = await self.chat_completion(
            messages, temperature=temperature, timeout=timeout
        )
        if not content:
            return None

        # Strip markdown code fences if present
        cleaned = content.strip()
        if cleaned.startswith("```"):
            # Remove opening fence (```, ```json, ```python, etc.) and closing fence
            cleaned = re.sub(r"^```\w*\n|```$", "", cleaned, flags=re.MULTILINE).strip()

        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as exc:
            logger.warning(
                f"HF extract_json failed to parse response: {exc}. "
                f"Raw: {content[:200]}"
            )
            return None


# ---------------------------------------------------------------------------
# Singleton convenience
# ---------------------------------------------------------------------------

_provider: HuggingFaceProvider = HuggingFaceProvider()


def get_hf_provider() -> HuggingFaceProvider:
    return _provider
