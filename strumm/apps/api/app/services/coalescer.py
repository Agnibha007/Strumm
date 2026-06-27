"""
Async request coalescer.

Prevents duplicate external API calls when multiple users search for the
same query concurrently. If 10 users all search "Taylor Swift" at once,
only ONE request reaches YouTube Music — the other 9 await the result.

Thread-safe: designed for FastAPI async endpoints that call synchronous
YTMusic methods via asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Optional

logger = logging.getLogger("strumm-coalescer")


class RequestCoalescer:
    """
    Coalesces identical concurrent requests.

    Usage:
        coalescer = RequestCoalescer()

        async def search(query: str) -> list:
            return await coalescer.execute(
                key=f"search:{query}",
                factory=lambda: asyncio.to_thread(yt_search, query),
            )

    The *factory* callable is invoked only when no in-flight request exists
    for the given *key*. Subsequent callers with the same key await the
    same underlying future.
    """

    def __init__(self) -> None:
        self._in_flight: dict[str, asyncio.Future] = {}
        self._lock = asyncio.Lock()

    async def execute(
        self,
        key: str,
        factory: Callable[[], Any],
        timeout: Optional[float] = None,
    ) -> Any:
        """
        Execute *factory* for *key*, coalescing concurrent callers.

        Args:
            key: Unique identifier for the operation (e.g. "search:Taylor Swift").
            factory: Async callable that performs the actual work.
            timeout: Optional timeout in seconds for the entire operation.

        Returns:
            The result of *factory*, or the result from the in-flight request.

        Raises:
            asyncio.TimeoutError: If *timeout* seconds elapse.
            Exception: Any exception raised by *factory*.
        """
        # Fast-path: check under lock if already in-flight
        async with self._lock:
            existing = self._in_flight.get(key)
            if existing is not None:
                logger.info(f"Coalescer HIT — reusing in-flight request for key='{key}'")
                # Await outside the lock so we don't block other coalescer operations
                result = await asyncio.wait_for(existing, timeout=timeout)
                return result

            # Create a future and register it before releasing the lock
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            self._in_flight[key] = future

        # Future is now registered — invoke factory outside the lock
        logger.info(f"Coalescer MISS — executing request for key='{key}'")
        start = time.monotonic()

        try:
            result = await asyncio.wait_for(factory(), timeout=timeout)
            elapsed = time.monotonic() - start
            future.set_result(result)
            logger.info(
                f"Coalescer result for key='{key}' in {elapsed*1000:.0f}ms"
            )
            return result
        except BaseException as exc:
            # Catch BaseException so asyncio.CancelledError doesn't orphan waiters
            if not future.done():
                future.set_exception(
                    exc if isinstance(exc, Exception) else RuntimeError(f"Coalesced request failed: {exc}")
                )
            raise
        finally:
            async with self._lock:
                self._in_flight.pop(key, None)


# Global singleton shared across search routes
_global_coalescer: Optional[RequestCoalescer] = None


def get_coalescer() -> RequestCoalescer:
    global _global_coalescer
    if _global_coalescer is None:
        _global_coalescer = RequestCoalescer()
    return _global_coalescer
