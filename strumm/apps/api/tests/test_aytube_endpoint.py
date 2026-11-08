from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.routes.youtube import proxy_aytube_audio


@pytest.mark.asyncio
async def test_aytube_endpoint_returns_audio_metadata():
    result = SimpleNamespace(
        url="https://rr.googlevideo.com/audio",
        title="Test Track",
        quality="high",
        container="webm",
        audio_codec="opus",
        mime_type="audio/webm",
        size=12345,
        itag=251,
    )
    with patch("aytube.get_stream_url", return_value=result) as resolver:
        response = await proxy_aytube_audio("dQw4w9WgXcQ")

    assert response["success"] is True
    assert response["provider"] == "aytube"
    assert response["videoId"] == "dQw4w9WgXcQ"
    assert response["data"]["title"] == "Test Track"
    assert response["data"]["audioCodec"] == "opus"
    resolver.assert_called_once_with(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        audio_only=True,
        quality="high",
        verify=False,
        timeout=12,
        method="innertube",
    )


@pytest.mark.asyncio
async def test_aytube_endpoint_rejects_invalid_video_id():
    with pytest.raises(HTTPException) as exc:
        await proxy_aytube_audio("not-a-valid-id")
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_aytube_endpoint_rejects_non_https_stream_url():
    result = SimpleNamespace(url="http://example.com/audio")
    with patch("aytube.get_stream_url", return_value=result):
        with pytest.raises(HTTPException) as exc:
            await proxy_aytube_audio("dQw4w9WgXcQ")
    assert exc.value.status_code == 502
