import asyncio
import io
import json
import wave

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from deskmate_server.main import create_app
from deskmate_server.tts import edge as edge_module
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


class FakeCommunicate:
    calls: list[tuple[str, str]] = []

    def __init__(self, text, voice):
        FakeCommunicate.calls.append((text, voice))

    async def stream(self):
        yield {"type": "audio", "data": b"ID3mp3"}


@pytest.fixture
def fake_edge(monkeypatch):
    FakeCommunicate.calls = []
    monkeypatch.setattr(edge_module.edge_tts, "Communicate", FakeCommunicate)
    return FakeCommunicate


def gsv_settings(tmp_path, voices=VOICES, **overrides):
    path = tmp_path / "voices.json"
    if voices is not None:
        path.write_text(json.dumps(voices, ensure_ascii=False), encoding="utf-8")
    return make_settings(
        tts_provider="gpt_sovits", gsv_voices_file=path, db_path=tmp_path / "t.db", **overrides
    )


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


def test_provider_alias_and_defaults():
    assert make_settings(tts_provider="GSV").tts_provider == "gpt_sovits"
    assert make_settings().tts_provider == "edge"


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
def test_gsv_down_falls_back_to_edge(gsv_client, fake_edge):
    respx.post(f"{GSV}/tts").mock(side_effect=httpx.ConnectError("refused"))
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "你好", "voice": "穗"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.headers["x-tts-provider"] == "edge"
    assert fake_edge.calls == [("你好", "zh-CN-XiaoyiNeural")]


@respx.mock
def test_gsv_error_status_falls_back_with_edge_voice(gsv_client, fake_edge):
    respx.post(f"{GSV}/tts").mock(return_value=httpx.Response(400, json={"message": "bad"}))
    r = gsv_client.post("/tts", headers=AUTH, json={"text": "你好", "voice": "zh-CN-XiaoxiaoNeural"})
    assert r.status_code == 200
    assert fake_edge.calls == [("你好", "zh-CN-XiaoxiaoNeural")]


@respx.mock
def test_gsv_no_fallback_reports_502(tmp_path, fake_edge):
    app = create_app(gsv_settings(tmp_path, tts_fallback="none"))
    respx.post(f"{GSV}/tts").mock(side_effect=httpx.ConnectError("refused"))
    with TestClient(app) as c:
        r = c.post("/tts", headers=AUTH, json={"text": "你好"})
    assert r.status_code == 502
    assert "GPT-SoVITS" in r.json()["detail"]
    assert fake_edge.calls == []


def test_gsv_without_presets_falls_back(tmp_path, fake_edge):
    app = create_app(gsv_settings(tmp_path, voices=None))
    with TestClient(app) as c:
        r = c.post("/tts", headers=AUTH, json={"text": "你好"})
    assert r.headers["x-tts-provider"] == "edge"


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
def test_health_edge_provider(client):
    respx.get("http://ollama.test/api/tags").mock(return_value=httpx.Response(200, json={"models": []}))
    body = client.get("/health").json()
    assert body["tts"] == "zh-CN-XiaoyiNeural"
    assert body["tts_provider"] == "edge" and body["gsv"] is None


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
    assert body["tts_provider"] == "gpt_sovits"
    assert body["gsv"] is alive


# ---------- /tts/voices ----------


def test_voices_edge(client):
    body = client.get("/tts/voices", headers=AUTH).json()
    assert body["provider"] == "edge"
    assert body["default"] == "zh-CN-XiaoyiNeural"
    assert body["voices"][0] == {"id": "zh-CN-XiaoyiNeural", "label": "晓伊 · 活泼可爱"}
    assert len(body["voices"]) == len(edge_module.EDGE_VOICES)


def test_voices_edge_custom_default_listed_first():
    app = create_app(make_settings(tts_voice="en-US-AriaNeural"))
    with TestClient(app) as c:
        voices = c.get("/tts/voices", headers=AUTH).json()["voices"]
    assert voices[0]["id"] == "en-US-AriaNeural"


def test_voices_gsv(gsv_client):
    body = gsv_client.get("/tts/voices", headers=AUTH).json()
    assert body == {
        "provider": "gpt_sovits",
        "default": "穗",
        "voices": [{"id": "小鲸", "label": "小鲸"}, {"id": "穗", "label": "满穗"}],
    }


def test_voices_requires_auth(client):
    assert client.get("/tts/voices").status_code == 401
