import os

import dotenv
import pytest

# 测试不读本机的 server/.env，配置全部在这里给定（必须在 import app 之前）
dotenv.load_dotenv = lambda *args, **kwargs: False
os.environ.update(
    {
        "OLLAMA_URL": "http://ollama.test",
        "OLLAMA_MODEL": "deepseek-r1:8b",
        "ACCESS_TOKENS": "good-token, other-token",
        "RATE_LIMIT_PER_MIN": "5",
        "TTS_RATE_PER_MIN": "50",
        "MAX_PERSONA_CHARS": "1000",
        "MEMORY_MAX_CHARS": "500",
        "TTS_MAX_CHARS": "300",
    }
)

from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402

AUTH = {"Authorization": "Bearer good-token"}


@pytest.fixture(autouse=True)
def _reset_state():
    app_module._requests.clear()
    app_module._models_cache = (0.0, [])
    yield
    app_module._requests.clear()
    app_module._models_cache = (0.0, [])


@pytest.fixture
def client():
    with TestClient(app_module.app) as c:
        yield c


@pytest.fixture
def app():
    return app_module
