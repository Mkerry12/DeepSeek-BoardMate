"""本机 GPT-SoVITS（api_v2.py，默认 http://127.0.0.1:9880）。

- 单卡串行：所有请求经过一把锁依次发送，排队超过 GSV_MAX_QUEUE 句直接判为不可用（这句不读）
- 连不上时记下来，DOWN_COOLDOWN 秒内的请求直接判为不可用，不再一句句去等连接超时
- 单次最多 GSV_MAX_CHARS 字：更长的按句切开依次合成，wav 拼接成一段（句间留一点停顿）
- 健康检查：GET /control 返回 400 就是活着（它的设计如此），连不上才是没起
"""

import asyncio
import io
import time
import wave
from collections.abc import Awaitable, Callable

import httpx

from ..config import Settings
from ..logging_setup import logger
from .base import Audio, TTSUnavailable, VoiceInfo
from .text import split_text
from .voices import VoicePreset, load_presets

MEDIA_TYPES = {"wav": "audio/wav", "ogg": "audio/ogg"}
PAUSE_SECONDS = 0.12
WARMUP_TEXT = "你好呀。"
DOWN_COOLDOWN = 10.0


class Cancelled(Exception):
    """客户端在排队期间断开了（比如用户按了停止），不必再合成。"""


def concat_wav(parts: list[bytes], pause: float = PAUSE_SECONDS) -> bytes:
    """把几段同格式的 PCM wav 接成一段；格式不一致或不是 PCM 时抛 wave.Error。"""
    if len(parts) == 1:
        return parts[0]
    frames: list[bytes] = []
    params = None
    for part in parts:
        with wave.open(io.BytesIO(part)) as w:
            p = w.getparams()
            if params is None:
                params = p
            elif (p.nchannels, p.sampwidth, p.framerate) != (
                params.nchannels,
                params.sampwidth,
                params.framerate,
            ):
                raise wave.Error("音频格式不一致")
            frames.append(w.readframes(w.getnframes()))
    assert params is not None
    silence = b"\x00" * (int(params.framerate * pause) * params.nchannels * params.sampwidth)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        w.writeframes(silence.join(frames))
    return out.getvalue()


class GPTSoVITSProvider:
    name = "gpt_sovits"

    def __init__(self, settings: Settings) -> None:
        self.base_url = settings.gsv_url
        self.media_type = settings.gsv_media_type
        self.max_chars = settings.gsv_max_chars
        self.max_queue = settings.gsv_max_queue
        self.timeout = httpx.Timeout(10, read=settings.gsv_timeout)
        self.presets, self._default = load_presets(settings)
        self._lock = asyncio.Lock()
        self._pending = 0
        self._down_until = 0.0

    def default_voice(self) -> str:
        return self._default or ""

    def voices(self) -> list[VoiceInfo]:
        return [VoiceInfo(p.name, p.label or p.name) for p in self.presets.values()]

    def preset_for(self, voice: str | None) -> VoicePreset:
        """未知音色（比如旧客户端发来的 Edge 音色名）用默认预设。"""
        preset = self.presets.get(voice or "") or self.presets.get(self._default or "")
        if preset is None:
            raise TTSUnavailable("没有配置 GPT-SoVITS 音色（GSV_VOICES_FILE 或 GSV_REF_AUDIO）")
        return preset

    async def ping(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                await client.get(f"{self.base_url}/control")
            return True
        except httpx.HTTPError:
            return False

    async def synthesize(
        self,
        text: str,
        voice: str | None,
        is_cancelled: Callable[[], Awaitable[bool]] | None = None,
    ) -> Audio:
        preset = self.preset_for(voice)
        if time.monotonic() < self._down_until:
            raise TTSUnavailable("GPT-SoVITS 刚才连不上，稍后再试")
        if self._pending >= self.max_queue:
            raise TTSUnavailable(f"GPT-SoVITS 排队已满（{self.max_queue} 句）")
        self._pending += 1
        try:
            async with self._lock:
                if is_cancelled is not None and await is_cancelled():
                    raise Cancelled
                return await self._synthesize_locked(text, preset)
        finally:
            self._pending -= 1

    async def _synthesize_locked(self, text: str, preset: VoicePreset) -> Audio:
        chunks = split_text(text, self.max_chars)
        if not chunks:
            raise TTSUnavailable("没有可朗读的文字")
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            if len(chunks) == 1 or self.media_type != "wav":
                # ogg 没法简单拼接：交给 GPT-SoVITS 自己按标点切（cut5）
                method = preset.text_split_method if len(chunks) == 1 else "cut5"
                return await self._request(client, text, preset, method)
            parts = [await self._request(client, c, preset, preset.text_split_method) for c in chunks]
            try:
                data = concat_wav([p.data for p in parts])
            except (wave.Error, EOFError):
                return await self._request(client, text, preset, "cut5")
            return Audio(data, "audio/wav", self.name)

    async def _request(self, client: httpx.AsyncClient, text: str, preset: VoicePreset, method: str) -> Audio:
        body = {
            "text": text,
            "text_lang": preset.text_lang,
            "ref_audio_path": preset.ref_audio_path,
            "prompt_text": preset.prompt_text,
            "prompt_lang": preset.prompt_lang,
            "text_split_method": method,
            "speed_factor": preset.speed,
            "media_type": self.media_type,
            "streaming_mode": False,
            "batch_size": 1,
        }
        try:
            r = await client.post(f"{self.base_url}/tts", json=body)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            self._down_until = time.monotonic() + DOWN_COOLDOWN
            raise TTSUnavailable(f"连接 GPT-SoVITS 失败: {e.__class__.__name__}") from e
        except httpx.HTTPError as e:
            raise TTSUnavailable(f"连接 GPT-SoVITS 失败: {e.__class__.__name__}") from e
        if r.status_code != 200 or not r.content:
            raise TTSUnavailable(f"GPT-SoVITS 返回 {r.status_code}: {r.text[:200]}")
        content_type = r.headers.get("content-type", "").split(";")[0].strip()
        media = content_type if content_type.startswith("audio/") else MEDIA_TYPES[self.media_type]
        return Audio(r.content, media, self.name)

    async def warmup(self, attempts: int = 30, interval: float = 10) -> bool:
        """等 GPT-SoVITS 起来后用默认音色合成一句，让模型和参考音频的缓存先热起来。"""
        if not self._default:
            return False
        for i in range(attempts):
            if await self.ping():
                break
            if i == attempts - 1:
                logger.warning("GPT-SoVITS（%s）一直没起来，跳过预热", self.base_url)
                return False
            await asyncio.sleep(interval)
        start = time.monotonic()
        try:
            await self.synthesize(WARMUP_TEXT, self._default)
        except (TTSUnavailable, Cancelled) as e:
            logger.warning("GPT-SoVITS 预热失败：%s", e)
            return False
        logger.info("GPT-SoVITS 预热完成，用时 %.1fs", time.monotonic() - start)
        return True
