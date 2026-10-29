import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from deskmate_server.config import Settings
from deskmate_server.main import create_app

AUTH = {"Authorization": "Bearer good-token"}

# 测试不读本机的 server/.env，配置全部在这里给定（构造参数优先于环境变量）
TEST_SETTINGS = {
    "ollama_url": "http://ollama.test",
    "ollama_model": "deepseek-r1:8b",
    "access_tokens": "good-token, other-token",
    "rate_limit_per_min": 5,
    "tts_rate_per_min": 50,
    "max_concurrency": 2,
    "max_history": 16,
    "max_input_chars": 1000,
    "max_persona_chars": 1000,
    "memory_max_chars": 500,
    "tts_voice": "zh-CN-XiaoyiNeural",
    "tts_max_chars": 300,
}


def make_settings(**overrides) -> Settings:
    """db_path 默认是一个不存在的目录下的新文件，测试之间互不影响。"""
    overrides.setdefault("db_path", Path(tempfile.mkdtemp(prefix="deskmate-test-")) / "test.db")
    return Settings(_env_file=None, **{**TEST_SETTINGS, **overrides})


@pytest.fixture
def settings(tmp_path) -> Settings:
    return make_settings(db_path=tmp_path / "test.db")


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c
    app.state.auth.store.close()
