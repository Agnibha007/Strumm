import pytest

from app.main import app


@pytest.fixture
def client():
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_legacy_youtube_download_route_is_removed(client):
    async with client:
        response = await client.get("/download/abcdefghijk")

    assert response.status_code == 404
