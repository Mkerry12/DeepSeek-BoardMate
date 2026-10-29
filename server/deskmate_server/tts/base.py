"""语音合成的公共类型。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Audio:
    data: bytes
    media_type: str  # audio/wav 或 audio/ogg
    provider: str


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    label: str


class TTSUnavailable(Exception):
    """GPT-SoVITS 暂时不可用（连不上、超时、返回错误、排队已满），这句就不读了。"""
