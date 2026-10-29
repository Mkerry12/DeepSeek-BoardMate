"""语音合成：按 TTS_PROVIDER 选择提供方（edge / gpt_sovits），GPT-SoVITS 不可用时按 TTS_FALLBACK 改用 Edge。

新增提供方：实现 base.TTSProvider（synthesize / voices / default_voice），在 TTSService 里按配置创建即可。
"""

from collections.abc import Awaitable, Callable

from fastapi import HTTPException

from ..config import Settings
from ..logging_setup import logger
from .base import Audio, TTSUnavailable, VoiceInfo
from .edge import EdgeProvider
from .gpt_sovits import Cancelled, GPTSoVITSProvider
from .text import clean_for_speech

__all__ = ["Audio", "TTSService", "VoiceInfo"]


class TTSService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.edge = EdgeProvider(settings.tts_voice)
        self.gsv = GPTSoVITSProvider(settings) if settings.tts_provider == "gpt_sovits" else None
        self.fallback = settings.tts_fallback

    @property
    def provider(self) -> str:
        return self.gsv.name if self.gsv else self.edge.name

    def describe(self) -> str:
        if not self.gsv:
            return f"edge（默认音色 {self.edge.default_voice()}）"
        names = "、".join(self.gsv.presets) or "无（请配置 GSV_VOICES_FILE 或 GSV_REF_AUDIO）"
        return f"gpt_sovits @ {self.gsv.base_url}，音色：{names}，备用：{self.fallback}"

    def prepare(self, text: str) -> str:
        text = clean_for_speech(text)[: self.settings.tts_max_chars].strip()
        if not text:
            raise HTTPException(status_code=400, detail="没有可朗读的文字")
        return text

    async def synthesize(
        self,
        text: str,
        voice: str | None,
        is_cancelled: Callable[[], Awaitable[bool]] | None = None,
    ) -> Audio:
        text = self.prepare(text)
        if self.gsv is None:
            return await self.edge.synthesize(text, voice)
        try:
            return await self.gsv.synthesize(text, voice, is_cancelled)
        except Cancelled:
            raise HTTPException(status_code=499, detail="已取消") from None
        except TTSUnavailable as e:
            if self.fallback != "edge":
                raise HTTPException(status_code=502, detail=f"语音合成失败：{e}") from None
            logger.warning("GPT-SoVITS 不可用，改用 Edge 语音：%s", e)
            return await self.edge.synthesize(text, self.edge.usable_voice(voice))

    def voices(self) -> dict:
        active = self.gsv or self.edge
        return {
            "provider": active.name,
            "default": active.default_voice(),
            "voices": [{"id": v.id, "label": v.label} for v in active.voices()],
        }

    async def health(self) -> dict:
        return {
            "tts_provider": self.provider,
            "gsv": await self.gsv.ping() if self.gsv else None,
        }

    async def warmup(self) -> None:
        if self.gsv and self.settings.gsv_warmup:
            await self.gsv.warmup()
