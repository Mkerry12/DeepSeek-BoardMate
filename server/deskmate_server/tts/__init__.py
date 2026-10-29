"""语音合成：只用本机 GPT-SoVITS。没配置音色、连不上、出错或排队已满时 /tts 返回 503，客户端就不出声，没有任何备用语音。"""

from collections.abc import Awaitable, Callable

from fastapi import HTTPException

from ..config import Settings
from ..logging_setup import logger
from .base import Audio, TTSUnavailable, VoiceInfo
from .gpt_sovits import Cancelled, GPTSoVITSProvider
from .text import clean_for_speech

__all__ = ["Audio", "TTSService", "VoiceInfo"]

NOT_ENABLED = "语音服务未开启"
UNAVAILABLE = "语音服务暂时不可用"


class TTSService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.gsv = GPTSoVITSProvider(settings) if settings.tts_enabled else None

    @property
    def enabled(self) -> bool:
        """关了 TTS_ENABLED 或一个音色都没配置时，朗读就是关闭的。"""
        return self.gsv is not None and bool(self.gsv.presets)

    def describe(self) -> str:
        if self.gsv is None:
            return "已关闭（TTS_ENABLED=false），不朗读"
        if not self.gsv.presets:
            return "未配置 GPT-SoVITS 音色（GSV_VOICES_FILE 或 GSV_REF_AUDIO），不朗读"
        return f"GPT-SoVITS @ {self.gsv.base_url}，音色：{'、'.join(self.gsv.presets)}"

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
        if not self.enabled:
            raise HTTPException(status_code=503, detail=NOT_ENABLED)
        assert self.gsv is not None
        text = self.prepare(text)
        try:
            return await self.gsv.synthesize(text, voice, is_cancelled)
        except Cancelled:
            raise HTTPException(status_code=499, detail="已取消") from None
        except TTSUnavailable as e:
            logger.warning("GPT-SoVITS 不可用，这句不读：%s", e)
            raise HTTPException(status_code=503, detail=f"{UNAVAILABLE}：{e}") from None

    def voices(self) -> dict:
        voices = self.gsv.voices() if self.enabled and self.gsv else []
        return {
            "provider": GPTSoVITSProvider.name,
            "default": self.default_voice() or "",
            "voices": [{"id": v.id, "label": v.label} for v in voices],
        }

    def default_voice(self) -> str | None:
        return (self.gsv.default_voice() or None) if self.enabled and self.gsv else None

    async def health(self) -> dict:
        # tts_provider 固定为 gpt_sovits：旧客户端靠它显示「GPT-SoVITS 语音 / 未运行」
        return {
            "tts": self.default_voice(),
            "tts_provider": GPTSoVITSProvider.name,
            "gsv": bool(self.enabled and self.gsv and await self.gsv.ping()),
        }

    async def warmup(self) -> None:
        if self.enabled and self.gsv and self.settings.gsv_warmup:
            await self.gsv.warmup()
