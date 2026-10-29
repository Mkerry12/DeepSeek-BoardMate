"""GPT-SoVITS 音色预设：从 GSV_VOICES_FILE（JSON）和 GSV_REF_AUDIO 等环境变量读取。

音色由参考音频决定；参考音频路径是 GPT-SoVITS 那台机器上的路径，本服务只原样转发，不读取文件。
"""

import json
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from ..config import Settings
from ..logging_setup import logger


class VoicePreset(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    label: str = ""
    ref_audio_path: str = Field(min_length=1)
    prompt_text: str = ""
    prompt_lang: str = "zh"
    text_lang: str = "zh"
    speed: float = Field(default=1.0, ge=0.9, le=2.0)
    text_split_method: str = Field(default="cut0", pattern="^cut[0-5]$")


class VoicesFile(BaseModel):
    default: str | None = None
    voices: list[VoicePreset] = Field(default_factory=list)


def _read_file(path: Path) -> VoicesFile:
    if not path.is_file():
        return VoicesFile()
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        return VoicesFile.model_validate({"voices": raw} if isinstance(raw, list) else raw)
    except (OSError, ValueError, ValidationError) as e:
        logger.error("音色预设文件 %s 读取失败，已忽略：%s", path, e)
        return VoicesFile()


def load_presets(settings: Settings) -> tuple[dict[str, VoicePreset], str | None]:
    """返回 (按名字索引的预设, 默认音色名)。文件优先，环境变量里的单个音色在文件里没有同名时追加。"""
    data = _read_file(settings.gsv_voices_file)
    presets = {p.name: p for p in data.voices}
    if settings.gsv_ref_audio and settings.gsv_voice_name not in presets:
        presets[settings.gsv_voice_name] = VoicePreset(
            name=settings.gsv_voice_name,
            ref_audio_path=settings.gsv_ref_audio,
            prompt_text=settings.gsv_prompt_text,
            prompt_lang=settings.gsv_prompt_lang,
            text_lang=settings.gsv_text_lang,
            speed=settings.gsv_speed,
            text_split_method=settings.gsv_text_split_method,
        )
    default = data.default if data.default in presets else next(iter(presets), None)
    for p in presets.values():
        if not p.prompt_text:
            logger.warning("音色「%s」没有填 prompt_text，GPT-SoVITS 首次合成会慢很多", p.name)
    return presets, default
