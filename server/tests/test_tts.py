import asyncio
import io
import json
import wave

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from deskmate_server.config import Settings
from deskmate_server.main import create_app
from deskmate_server.tts.gpt_sovits import GPTSoVITSProvider, concat_wav
from deskmate_server.tts.text import clean_for_speech, split_text
from deskmate_server.tts.voices import load_presets
from tests.conftest import AUTH, make_settings

GSV = "http://gsv.test"

VOICES = {
    "default": "穗",
    "voices": [
        {"name": "小鲸", "ref_audio_path": "/ref/whale.wav", "prompt_text": "你好", "speed": 1.1},
        {"name": "穗", "label": "满穗", "ref_audio_path": "D:\\voices\\sui.wav", "prompt_text": "嗯"},
    ],
}


def wav_bytes(frames: int, rate: int = 32000) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x01\x00" * frames)
    return out.getvalue()


def wav_frames(data: bytes) -> int:
    with wave.open(io.BytesIO(data)) as w:
        return w.getnframes()


def gsv_settings(tmp_path, voices=VOICES, **overrides):
    path = tmp_path / "voices.json"
    if voices is not None:
        path.write_text(json.dumps(voices, ensure_ascii=False), encoding="utf-8")
    return make_settings(gsv_voices_file=path, db_path=tmp_path / "t.db", **overrides)


@pytest.fixture
def gsv_client(tmp_path):
    app = create_app(gsv_settings(tmp_path))
    with TestClient(app) as c:
        yield c
    app.state.auth.store.close()


# ---------- 文本处理 ----------


def test_clean_for_speech_strips_tags_markdown_and_emoji():
    text = "[happy]<think>想想</think>**你好**呀😀，看 https://x.y 和 [链接](http://a.b)```code```"
    assert clean_for_speech(text) == "你好 呀，看 和 链接"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("好耶(｡•̀ᴗ-)✧", "好耶"),
        ("气死了(╯°□°）╯︵ ┻━┻", "气死了"),
        ("开心(≧▽≦)", "开心"),
        ("嗯(´・ω・`)", "嗯"),
        ("哇o(*￣▽￣*)o好棒", "哇好棒"),
        ("耶\\(^o^)/", "耶"),
        ("呜呜QwQ", "呜呜"),
        ("哈哈^_^", "哈哈"),
        ("好难T_T", "好难"),
        ("啊>_<", "啊"),
        ("(T_T)不要", "不要"),
        ("好的:)", "好的"),
        ("太好了:D", "太好了"),
        ("owo是什么", "是什么"),
        ("晚安★☆♡❤✿♪✧", "晚安"),
    ],
)
def test_clean_for_speech_strips_kaomoji(text, expected):
    assert clean_for_speech(text) == expected


@pytest.mark.parametrize(
    "text", ["（比如这样）", "第(1)步", "用(TTS)朗读", "10:30 开会", "QwQa 不算", "好的～"]
)
def test_clean_for_speech_keeps_normal_text(text):
    assert clean_for_speech(text) == text


def test_split_text_merges_short_and_splits_long():
    assert split_text("你好。今天怎么样？", 80) == ["你好。今天怎么样？"]
    s = "啊" * 50 + "。"
    assert split_text(s * 3, 80) == [s, s, s]
    long = "一" * 30 + "，" + "二" * 60
    assert split_text(long, 40) == ["一" * 30 + "，", "二" * 40, "二" * 20]
    assert split_text("   ", 80) == []


def test_concat_wav_inserts_pause():
    merged = concat_wav([wav_bytes(100), wav_bytes(200)], pause=0.01)
    assert wav_frames(merged) == 100 + 200 + 320


def test_concat_wav_rejects_mismatched_formats():
    with pytest.raises(wave.Error):
        concat_wav([wav_bytes(10, 32000), wav_bytes(10, 24000)])


# ---------- 配置 / 音色 ----------


def test_old_edge_env_vars_are_ignored(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "TTS_PROVIDER=edge\nTTS_FALLBACK=edge\nTTS_VOICE=zh-CN-XiaoyiNeural\nGSV_SPEED=1.1\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TTS_PROVIDER", "gpt_sovits")
    settings = Settings(_env_file=env)
    assert settings.tts_enabled is True and settings.gsv_speed == 1.1
    assert not hasattr(settings, "tts_provider") and not hasattr(settings, "tts_voice")


def test_load_presets_file_and_env(tmp_path):
    settings = gsv_settings(
        tmp_path, gsv_voice_name="环境", gsv_ref_audio="/env.wav", gsv_prompt_text="嗨", gsv_speed=1.2
    )
    presets, default = load_presets(settings)
    assert list(presets) == ["小鲸", "穗", "环境"]
    assert default == "穗"
    assert presets["环境"].ref_audio_path == "/env.wav" and presets["环境"].speed == 1.2


def test_load_presets_env_only_and_bad_file(tmp_path):
    (tmp_path / "voices.json").write_text("{not json", encoding="utf-8")
    settings = gsv_settings(tmp_path, voices=None, gsv_ref_audio="/env.wav")
    presets, default = load_presets(settings)
    assert list(presets) == ["default"] and default == "default"


def test_load_presets_plain_list(tmp_path):
    presets, default = load_presets(gsv_settings(tmp_path, voices=VOICES["voices"]))
    assert default == "小鲸" and len(presets) == 2


# ---------- /tts（GPT-SoVITS） ----------


@respx.mock
def test_gsv_request_body_mapping_and_content_type(gsv_client):
    route = respx.post(f"{GSV}/tts").mock(
        return_value=httpx.Response(200, content=wav_bytes(10), headers={"content-type": "audio/wav"})
    )
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "[happy]你好呀～", "voice": "小鲸"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["x-tts-provider"] == "gpt_sovits"
    assert r.content == wav_bytes(10)
    assert json.loads(route.calls.last.request.content) == {
        "text": "你好呀～",
        "text_lang": "zh",
        "ref_audio_path": "/ref/whale.wav",
        "prompt_text": "你好",
        "prompt_lang": "zh",
        "text_split_method": "cut0",
        "speed_factor": 1.1,
        "media_type": "wav",
        "streaming_mode": False,
        "batch_size": 1,
    }


@respx.mock
def test_gsv_unknown_voice_uses_default_preset(gsv_client):
    route = respx.post(f"{GSV}/tts").mock(return_value=httpx.Response(200, content=wav_bytes(10)))
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "你好", "voice": "zh-CN-XiaoyiNeural"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"  # 上游没给 content-type 时按 GSV_MEDIA_TYPE
    assert json.loads(route.calls.last.request.content)["ref_audio_path"] == "D:\\voices\\sui.wav"


@respx.mock
def test_gsv_ogg_passthrough(tmp_path):
    app = create_app(gsv_settings(tmp_path, gsv_media_type="ogg"))
    route = respx.post(f"{GSV}/tts").mock(
        return_value=httpx.Response(200, content=b"OggS", headers={"content-type": "audio/ogg"})
    )
    with TestClient(app) as c:
        long = "啊" * 50 + "。" + "哦" * 50 + "。"
        r = c.post("/tts", headers=AUTH, json={"text": long})
    assert r.headers["content-type"] == "audio/ogg" and r.content == b"OggS"
    body = json.loads(route.calls.last.request.content)
    assert route.call_count == 1 and body["media_type"] == "ogg" and body["text_split_method"] == "cut5"


@respx.mock
def test_gsv_long_text_split_and_concatenated(gsv_client):
    route = respx.post(f"{GSV}/tts").mock(return_value=httpx.Response(200, content=wav_bytes(1000)))
    s = "啊" * 50 + "。"
    r = gsv_client.post("/tts", headers=AUTH, json={"text": s * 3})
    assert r.status_code == 200
    assert route.call_count == 3
    assert [json.loads(c.request.content)["text"] for c in route.calls] == [s, s, s]
    pause = int(32000 * 0.12)
    assert wav_frames(r.content) == 3 * 1000 + 2 * pause


@respx.mock
def test_gsv_down_returns_503_without_fallback(gsv_client):
    route = respx.post(f"{GSV}/tts").mock(side_effect=httpx.ConnectError("refused"))
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "你好", "voice": "穗"})
    assert r.status_code == 503
    assert r.json()["detail"].startswith("语音服务暂时不可用")
    # 冷却期内不再去连，直接 503
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "再来一句"})
    assert r.status_code == 503 and route.call_count == 1


@respx.mock
def test_gsv_error_status_returns_503(gsv_client):
    respx.post(f"{GSV}/tts").mock(return_value=httpx.Response(400, json={"message": r"C:\secret\ref.wav"}))
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "你好", "voice": "zh-CN-XiaoxiaoNeural"})
    assert r.status_code == 503
    assert "GPT-SoVITS 返回 400" in r.json()["detail"]
    # 错误内容（可能有本机路径）不回给客户端
    assert "secret" not in r.json()["detail"]


def test_tts_without_presets_returns_503(client):
    r = client.post("/tts", headers=AUTH, json={"text": "你好", "voice": "zh-CN-XiaoyiNeural"})
    assert r.status_code == 503
    assert r.json() == {"detail": "语音服务未开启"}


def test_tts_disabled_returns_503(tmp_path):
    app = create_app(gsv_settings(tmp_path, tts_enabled=False))
    with TestClient(app) as c:
        assert c.post("/tts", headers=AUTH, json={"text": "你好"}).json() == {"detail": "语音服务未开启"}
        assert c.get("/tts/voices", headers=AUTH).json()["voices"] == []


@respx.mock
def test_tts_truncates_long_text(gsv_client):
    route = respx.post(f"{GSV}/tts").mock(return_value=httpx.Response(200, content=wav_bytes(10)))
    gsv_client.post("/tts", headers=AUTH, json={"text": "读" * 1000})
    sent = "".join(json.loads(c.request.content)["text"] for c in route.calls)
    assert sent == "读" * 300


@pytest.mark.parametrize("text", ["", "x" * 4001])
def test_tts_text_length_validation(gsv_client, text):
    assert gsv_client.post("/tts", headers=AUTH, json={"text": text}).status_code == 422


def test_tts_requires_auth(gsv_client):
    assert gsv_client.post("/tts", json={"text": "hi"}).status_code == 401


def test_tts_rejects_text_without_speakable_content(gsv_client):
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "[happy] 😀"})
    assert r.status_code == 400


# ---------- 串行 / 排队 ----------


def test_gsv_requests_are_serialized(tmp_path):
    provider = GPTSoVITSProvider(gsv_settings(tmp_path))
    active = 0
    peak = 0

    async def fake_locked(text, preset):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return text

    provider._synthesize_locked = fake_locked

    async def main():
        return await asyncio.gather(*(provider.synthesize(f"句子{i}", None) for i in range(5)))

    assert asyncio.run(main()) == [f"句子{i}" for i in range(5)]
    assert peak == 1


def test_gsv_queue_full_raises_unavailable(tmp_path):
    from deskmate_server.tts.base import TTSUnavailable

    provider = GPTSoVITSProvider(gsv_settings(tmp_path, gsv_max_queue=2))

    async def slow(text, preset):
        await asyncio.sleep(0.05)
        return text

    provider._synthesize_locked = slow

    async def main():
        return await asyncio.gather(
            *(provider.synthesize("嗨", None) for _ in range(3)), return_exceptions=True
        )

    results = asyncio.run(main())
    assert sum(isinstance(r, TTSUnavailable) for r in results) == 1


def test_gsv_skips_cancelled_requests(tmp_path):
    from deskmate_server.tts.gpt_sovits import Cancelled

    provider = GPTSoVITSProvider(gsv_settings(tmp_path))

    async def gone():
        return True

    with pytest.raises(Cancelled):
        asyncio.run(provider.synthesize("嗨", None, gone))


@respx.mock
def test_gsv_warmup_synthesizes_default_voice(tmp_path):
    respx.get(f"{GSV}/control").mock(return_value=httpx.Response(400))
    route = respx.post(f"{GSV}/tts").mock(return_value=httpx.Response(200, content=wav_bytes(10)))
    provider = GPTSoVITSProvider(gsv_settings(tmp_path))
    assert asyncio.run(provider.warmup(attempts=1)) is True
    assert json.loads(route.calls.last.request.content)["ref_audio_path"] == "D:\\voices\\sui.wav"


@respx.mock
def test_gsv_warmup_gives_up_when_down(tmp_path):
    respx.get(f"{GSV}/control").mock(side_effect=httpx.ConnectError("refused"))
    provider = GPTSoVITSProvider(gsv_settings(tmp_path))
    assert asyncio.run(provider.warmup(attempts=2, interval=0)) is False


# ---------- /health ----------


@respx.mock
def test_health_without_voice_config(client):
    respx.get("http://ollama.test/api/tags").mock(return_value=httpx.Response(200, json={"models": []}))
    control = respx.get(f"{GSV}/control")
    body = client.get("/health").json()
    assert body["tts"] is None
    assert body["tts_provider"] == "gpt_sovits" and body["gsv"] is False
    assert control.call_count == 0


@respx.mock
@pytest.mark.parametrize(
    ("mock", "alive"),
    [
        ({"return_value": httpx.Response(400)}, True),  # /control 返回 400 就是活着
        ({"return_value": httpx.Response(200)}, True),
        ({"side_effect": httpx.ConnectError("refused")}, False),
        ({"side_effect": httpx.ReadTimeout("slow")}, False),
    ],
)
def test_health_gsv_reachability(gsv_client, mock, alive):
    respx.get("http://ollama.test/api/tags").mock(return_value=httpx.Response(200, json={"models": []}))
    respx.get(f"{GSV}/control").mock(**mock)
    body = gsv_client.get("/health").json()
    assert body["ok"] is True
    assert body["tts"] == "穗"
    assert body["tts_provider"] == "gpt_sovits"
    assert body["gsv"] is alive


# ---------- /tts/voices ----------


def test_voices_empty_without_config(client):
    body = client.get("/tts/voices", headers=AUTH).json()
    assert body == {"provider": "gpt_sovits", "default": "", "voices": []}


def test_voices_gsv(gsv_client):
    body = gsv_client.get("/tts/voices", headers=AUTH).json()
    assert body == {
        "provider": "gpt_sovits",
        "default": "穗",
        "voices": [{"id": "小鲸", "label": "小鲸"}, {"id": "穗", "label": "满穗"}],
    }


def test_voices_requires_auth(client):
    assert client.get("/tts/voices").status_code == 401
