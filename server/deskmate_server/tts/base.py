"""语音合成提供方的公共类型。"""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Audio:
    data: bytes
    media_type: str  # 如 audio/mpeg、audio/wav、audio/ogg
    provider: str


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    label: str


class TTSUnavailable(Exception):
    """提供方暂时不可用（连不上、超时、返回错误、排队已满），可以改用备用方案。"""


class TTSProvider(Protocol):
    name: str

    async def synthesize(self, text: str, voice: str | None) -> Audio: ...

    def voices(self) -> list[VoiceInfo]: ...

    def default_voice(self) -> str: ...
