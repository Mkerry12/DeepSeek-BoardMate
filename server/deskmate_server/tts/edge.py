"""微软 Edge 神经网络语音（需要服务器能访问外网），返回 mp3。"""

import asyncio
import re

import edge_tts
from fastapi import HTTPException

from .base import Audio, VoiceInfo

VOICE_RE = re.compile(r"^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$")

# 与客户端 services/voice.ts 的 VOICES 一致
EDGE_VOICES = [
    VoiceInfo("zh-CN-XiaoyiNeural", "晓伊 · 活泼可爱"),
    VoiceInfo("zh-CN-XiaoxiaoNeural", "晓晓 · 温柔"),
    VoiceInfo("zh-CN-liaoning-XiaobeiNeural", "晓北 · 东北话"),
    VoiceInfo("zh-CN-shaanxi-XiaoniNeural", "晓妮 · 陕西话"),
    VoiceInfo("zh-TW-HsiaoYuNeural", "曉雨 · 台湾腔"),
    VoiceInfo("zh-CN-YunxiaNeural", "云夏 · 少年音"),
]


class EdgeProvider:
    name = "edge"

    def __init__(self, default_voice: str, concurrency: int = 4) -> None:
        self._default = default_voice
        self._semaphore = asyncio.Semaphore(concurrency)

    def default_voice(self) -> str:
        return self._default

    def voices(self) -> list[VoiceInfo]:
        known = [v for v in EDGE_VOICES if v.id != self._default]
        default = next(
            (v for v in EDGE_VOICES if v.id == self._default), VoiceInfo(self._default, self._default)
        )
        return [default, *known]

    def usable_voice(self, voice: str | None) -> str:
        """给备用方案用：不是 Edge 音色名（比如 GPT-SoVITS 的预设名）时用默认音色。"""
        return voice if voice and VOICE_RE.match(voice) else self._default

    async def synthesize(self, text: str, voice: str | None) -> Audio:
        voice = voice or self._default
        if not VOICE_RE.match(voice):
            raise HTTPException(status_code=400, detail="不支持的音色")
        audio = bytearray()
        async with self._semaphore:
            try:
                async for chunk in edge_tts.Communicate(text, voice).stream():
                    if chunk["type"] == "audio":
                        audio += chunk["data"]
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"语音合成失败: {e.__class__.__name__}") from e
        if not audio:
            raise HTTPException(status_code=502, detail="语音合成失败")
        return Audio(bytes(audio), "audio/mpeg", self.name)
