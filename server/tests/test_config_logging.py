import json
import logging

import pytest
from pydantic import ValidationError

from deskmate_server.logging_setup import JsonFormatter, TextFormatter
from tests.conftest import AUTH, make_settings


def test_env_tokens_strip_and_dedupe_in_order():
    s = make_settings(access_tokens=" b , a,, b ,c ")
    assert s.env_tokens == ["b", "a", "c"]


def test_settings_read_env_var_names(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://x:1/")
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "7")
    from deskmate_server.config import Settings

    s = Settings(_env_file=None)
    assert s.ollama_url == "http://x:1"
    assert s.rate_limit_per_min == 7


@pytest.mark.parametrize(
    "bad", [{"rate_limit_per_min": 0}, {"port": 70000}, {"max_concurrency": "abc"}, {"log_format": "xml"}]
)
def test_settings_validation(bad):
    with pytest.raises(ValidationError):
        make_settings(**bad)


def test_request_id_header_and_access_log(client, caplog):
    logger = logging.getLogger("deskmate")
    logger.propagate = True
    with caplog.at_level(logging.INFO, logger="deskmate"):
        r = client.get("/auth-check", headers={**AUTH, "X-Request-ID": "abc-123"})
        r2 = client.get("/auth-check", headers={"X-Request-ID": "bad id with spaces!"})
    assert r.headers["x-request-id"] == "abc-123"
    assert r2.status_code == 401
    assert r2.headers["x-request-id"] != "bad id with spaces!"

    records = [rec for rec in caplog.records if rec.name == "deskmate"]
    ok = next(rec for rec in records if rec.request_id == "abc-123")
    assert (ok.method, ok.path, ok.status, ok.token) == ("GET", "/auth-check", 200, "token-1")
    assert ok.ms >= 0
    denied = next(rec for rec in records if rec.status == 401)
    assert denied.token == "-"
    # 日志里只有标签，从不出现令牌本身
    for rec in records:
        assert "good-token" not in TextFormatter().format(rec)
        assert "good-token" not in JsonFormatter().format(rec)


def test_json_formatter_fields():
    rec = logging.LogRecord("deskmate", logging.INFO, "", 0, "request", None, None)
    rec.request_id, rec.path, rec.status = "r1", "/health", 200
    data = json.loads(JsonFormatter().format(rec))
    assert data["msg"] == "request" and data["request_id"] == "r1" and data["status"] == 200


def test_app_entrypoint_imports():
    import app  # noqa: F401  server/app.py 仍可作为入口
