import json
import time

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from deskmate_server import persona
from deskmate_server.main import create_app
from tests.conftest import AUTH, make_settings

# good-token 是 ACCESS_TOKENS 里的第一个，限流按令牌 id 分桶
GOOD_KEY = "env:1"

OLLAMA = "http://ollama.test"

TAGS = {
    "models": [
        {"name": "deepseek-r1:8b", "details": {"family": "qwen3"}},
        {"name": "qwen2.5:7b", "details": {"family": "qwen2", "families": ["qwen2"]}},
        {"name": "bge-m3:latest", "details": {"family": "bert", "families": ["bert"]}},
        {"name": "nomic-embed-text", "details": {"family": "nomic-bert"}},
    ]
}


def user_msg(content="你好"):
    return {"role": "user", "content": content}


def sse_events(body: str) -> list[dict]:
    return [json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")]


# ---------- 鉴权 ----------


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "good-token-but-not"}],
)
def test_auth_rejects_missing_or_wrong_token(client, headers):
    r = client.get("/auth-check", headers=headers)
    assert r.status_code == 401
    assert r.json()["detail"] == "令牌无效"


@pytest.mark.parametrize("token", ["good-token", "other-token"])
def test_auth_accepts_valid_tokens(client, token):
    r = client.get("/auth-check", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_auth_open_when_no_tokens_configured():
    app = create_app(make_settings(access_tokens=""))
    with TestClient(app) as client:
        assert client.get("/auth-check").status_code == 200
        assert client.get("/health").json()["auth"] is False
    assert ("chat", "anonymous") in app.state.limiter.windows


# ---------- 限流 ----------


def test_rate_limit_per_token(client, app, settings):
    for _ in range(settings.rate_limit_per_min):
        assert client.get("/auth-check", headers=AUTH).status_code == 200
    r = client.get("/auth-check", headers=AUTH)
    assert r.status_code == 429
    # 其他令牌不受影响
    assert client.get("/auth-check", headers={"Authorization": "Bearer other-token"}).status_code == 200


def test_rate_limit_window_expires(client, app, settings):
    old = time.monotonic() - 61
    app.state.limiter.windows[("chat", GOOD_KEY)].extend([old] * settings.rate_limit_per_min)
    assert client.get("/auth-check", headers=AUTH).status_code == 200
    assert len(app.state.limiter.windows[("chat", GOOD_KEY)]) == 1


def test_tts_bucket_is_separate_from_chat(client, app, settings):
    now = time.monotonic()
    app.state.limiter.windows[("chat", GOOD_KEY)].extend([now] * settings.rate_limit_per_min)
    assert client.get("/auth-check", headers=AUTH).status_code == 429
    r = client.post("/tts", headers=AUTH, json={"text": ""})
    assert r.status_code == 422  # 过了鉴权和限流，卡在参数校验


# ---------- /health ----------


@respx.mock
def test_health_reports_ollama_down(client):
    respx.get(f"{OLLAMA}/api/tags").mock(side_effect=httpx.ConnectError("down"))
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["ollama"] is False
    assert body["auth"] is True


# ---------- /models ----------


@respx.mock
def test_models_filters_embedding_models(client):
    respx.get(f"{OLLAMA}/api/tags").mock(return_value=httpx.Response(200, json=TAGS))
    r = client.get("/models", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"models": ["deepseek-r1:8b", "qwen2.5:7b"], "default": "deepseek-r1:8b"}


@respx.mock
def test_models_are_cached(client):
    route = respx.get(f"{OLLAMA}/api/tags").mock(return_value=httpx.Response(200, json=TAGS))
    client.get("/models", headers=AUTH)
    client.get("/models", headers=AUTH)
    assert route.call_count == 1


@respx.mock
def test_models_ollama_unreachable(client):
    respx.get(f"{OLLAMA}/api/tags").mock(side_effect=httpx.ConnectError("down"))
    r = client.get("/models", headers=AUTH)
    assert r.status_code == 502


def test_models_requires_auth(client):
    assert client.get("/models").status_code == 401


# ---------- /chat ----------


def test_chat_requires_auth(client):
    assert client.post("/chat", json={"messages": [user_msg()]}).status_code == 401


def test_chat_rejects_empty_messages(client):
    assert client.post("/chat", headers=AUTH, json={"messages": []}).status_code == 422


def test_chat_last_message_must_be_user(client):
    r = client.post(
        "/chat",
        headers=AUTH,
        json={"messages": [user_msg(), {"role": "assistant", "content": "嗯"}]},
    )
    assert r.status_code == 400


def test_chat_rejects_bad_role(client):
    r = client.post("/chat", headers=AUTH, json={"messages": [{"role": "system", "content": "x"}]})
    assert r.status_code == 422


def test_chat_input_length_cap(client, app, settings):
    r = client.post(
        "/chat", headers=AUTH, json={"messages": [user_msg("字" * (settings.max_input_chars + 1))]}
    )
    assert r.status_code == 400


def test_chat_persona_length_cap(client, app, settings):
    r = client.post(
        "/chat",
        headers=AUTH,
        json={"messages": [user_msg()], "persona": "人" * (settings.max_persona_chars + 1)},
    )
    assert r.status_code == 400
    assert "人设太长" in r.json()["detail"]


def test_chat_memory_hard_cap(client):
    r = client.post("/chat", headers=AUTH, json={"messages": [user_msg()], "memory": "记" * 4001})
    assert r.status_code == 422


@respx.mock
def test_chat_rejects_model_not_on_server(client):
    respx.get(f"{OLLAMA}/api/tags").mock(return_value=httpx.Response(200, json=TAGS))
    r = client.post("/chat", headers=AUTH, json={"messages": [user_msg()], "model": "llama3:70b"})
    assert r.status_code == 400
    assert "llama3:70b" in r.json()["detail"]


@respx.mock
def test_chat_rejects_embedding_model(client):
    respx.get(f"{OLLAMA}/api/tags").mock(return_value=httpx.Response(200, json=TAGS))
    r = client.post("/chat", headers=AUTH, json={"messages": [user_msg()], "model": "bge-m3:latest"})
    assert r.status_code == 400


@respx.mock
def test_chat_streams_filtered_events(client, app, settings):
    lines = [
        {"message": {"thinking": "嗯"}},
        {"message": {"content": "<think>想"}},
        {"message": {"content": "想</think>[ha"}},
        {"message": {"content": "ppy]你好"}},
        {"message": {"content": "呀"}, "done": True},
    ]
    route = respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=httpx.Response(200, text="\n".join(json.dumps(x) for x in lines) + "\n")
    )
    memory = "记" * 600
    r = client.post(
        "/chat",
        headers=AUTH,
        json={"messages": [user_msg()], "persona": "你是猫", "memory": memory},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = sse_events(r.text)
    assert events[0] == {"type": "thinking"}
    assert {"type": "emotion", "value": "happy"} in events
    assert "".join(e["text"] for e in events if e["type"] == "delta") == "你好呀"
    assert events[-1] == {"type": "done"}

    payload = json.loads(route.calls.last.request.content)
    assert payload["model"] == settings.ollama_model
    system = payload["messages"][0]
    assert system["role"] == "system"
    assert system["content"].startswith("你是猫\n规则：")
    assert system["content"].endswith("记" * settings.memory_max_chars)
    assert "记" * (settings.memory_max_chars + 1) not in system["content"]


@respx.mock
def test_chat_ollama_error_is_reported_in_stream(client):
    respx.post(f"{OLLAMA}/api/chat").mock(return_value=httpx.Response(500, text="boom"))
    events = sse_events(client.post("/chat", headers=AUTH, json={"messages": [user_msg()]}).text)
    assert events[-1]["type"] == "error"
    assert "500" in events[-1]["message"]


@respx.mock
def test_chat_sends_only_recent_history(client, app, settings):
    route = respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=httpx.Response(200, text=json.dumps({"message": {"content": "[wave]嗨"}, "done": True}))
    )
    msgs = [user_msg(f"m{i}") for i in range(settings.max_history + 5)]
    client.post("/chat", headers=AUTH, json={"messages": msgs})
    sent = json.loads(route.calls.last.request.content)["messages"][1:]
    assert [m["content"] for m in sent] == [m["content"] for m in msgs[-settings.max_history :]]


# ---------- 提示词 / 工具函数 ----------


def test_system_prompt_default_and_memory():
    assert persona.system_prompt(None).startswith(persona.DEFAULT_PERSONA)
    assert persona.MEMORY_INTRO not in persona.system_prompt("  ", "   ")
    prompt = persona.system_prompt("", "x" * 900)
    assert prompt.endswith(f"{persona.MEMORY_INTRO}\n" + "x" * 500)


def test_clip_lines_cuts_at_line_boundary():
    assert persona.clip_lines("短", 10) == "短"
    assert persona.clip_lines("aaaa\nbbbb\ncccc", 12) == "aaaa\nbbbb"
    assert persona.clip_lines("abcdefghij", 4) == "abcd"


@respx.mock
def test_memory_endpoint_strips_think_and_handles_empty(client):
    route = respx.post(f"{OLLAMA}/api/chat")
    route.mock(return_value=httpx.Response(200, json={"message": {"content": "<think>嗯</think>- 喜欢猫"}}))
    r = client.post("/memory", headers=AUTH, json={"messages": [user_msg("我喜欢猫")]})
    assert r.json() == {"memory": "- 喜欢猫"}

    route.mock(return_value=httpx.Response(200, json={"message": {"content": "（暂无）"}}))
    r = client.post("/memory", headers=AUTH, json={"messages": [user_msg()]})
    assert r.json() == {"memory": ""}
