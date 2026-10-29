"""配置：从环境变量 / server/.env 读取（变量名与 .env.example 一致），启动时校验。"""

from functools import cached_property
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_DIR = Path(__file__).resolve().parents[1]
# .env.example 里的占位令牌：照抄就拒绝启动（公开仓库里的值谁都知道）
EXAMPLE_TOKEN = "REPLACE-ME-with-your-own-random-token"
# 旧版 .env.example 的示例令牌，同样是公开的；为了不让老部署直接起不来，只警告
OLD_EXAMPLE_TOKENS = ("change-me-123",)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=SERVER_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "deepseek-r1:8b"
    # 逗号分隔的明文令牌（旧方式，仍然有效）
    access_tokens: str = ""
    rate_limit_per_min: int = Field(default=20, ge=1)
    max_concurrency: int = Field(default=2, ge=1)
    max_history: int = Field(default=16, ge=1)
    max_input_chars: int = Field(default=1000, ge=1)
    max_persona_chars: int = Field(default=1000, ge=1)
    memory_max_chars: int = Field(default=500, ge=0)
    # 朗读只用本机 GPT-SoVITS（api_v2）；没配置 / 连不上时 /tts 返回 503，客户端不出声。
    # 旧版的 TTS_PROVIDER / TTS_FALLBACK / TTS_VOICE 已废弃，留在 .env 里也会被忽略。
    tts_enabled: bool = True
    tts_max_chars: int = Field(default=300, ge=1)
    tts_rate_per_min: int = Field(default=90, ge=1)
    gsv_url: str = "http://127.0.0.1:9880"
    # 音色预设文件（JSON，相对路径以 server/ 为基准），格式见 server/voices.example.json
    gsv_voices_file: Path = Field(default=Path("data/voices.json"), validate_default=True)
    # 也可以只用环境变量配一个音色（文件里没有同名音色时追加）
    gsv_voice_name: str = Field(default="default", min_length=1, max_length=80)
    gsv_ref_audio: str = ""
    gsv_prompt_text: str = ""
    gsv_prompt_lang: str = "zh"
    gsv_text_lang: str = "zh"
    gsv_speed: float = Field(default=1.0, ge=0.9, le=2.0)
    gsv_text_split_method: str = Field(default="cut0", pattern="^cut[0-5]$")
    gsv_media_type: Literal["wav", "ogg"] = "wav"
    gsv_timeout: float = Field(default=120, ge=5)
    # 单次发给 GPT-SoVITS 的最多字数，更长的按句切开、依次合成后拼接
    gsv_max_chars: int = Field(default=80, ge=10, le=300)
    # 排队等待合成的最多句数（单卡串行），超出的句子直接不读
    gsv_max_queue: int = Field(default=8, ge=1)
    # 启动后在后台先合成一句，免得第一句话等 20 秒
    gsv_warmup: bool = True
    # 令牌数据库（相对路径以 server/ 为基准）
    db_path: Path = Field(default=Path("data/deskmate.db"), validate_default=True)
    # 管理接口 /admin/* 的令牌；留空则关闭这些接口
    admin_token: str = ""
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: str = "INFO"
    log_format: str = Field(default="text", pattern="^(text|json)$")

    @field_validator("ollama_url", "gsv_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @field_validator("access_tokens")
    @classmethod
    def _no_example_token(cls, v: str) -> str:
        if any(t.strip() == EXAMPLE_TOKEN for t in v.split(",")):
            raise ValueError(
                "ACCESS_TOKENS 还是 .env.example 里的占位值，请换成自己的长随机串，"
                "或者清空后改用令牌库（python -m deskmate_server.tokens add <名字>）"
            )
        return v

    @field_validator("gsv_media_type", mode="before")
    @classmethod
    def _lower(cls, v):
        return v.strip().lower() if isinstance(v, str) else v

    @field_validator("db_path", "gsv_voices_file")
    @classmethod
    def _resolve_path(cls, v: Path) -> Path:
        return v if v.is_absolute() else SERVER_DIR / v

    @cached_property
    def env_tokens(self) -> list[str]:
        """ACCESS_TOKENS 去空白、去重，保持原顺序（顺序决定 token-1、token-2 这样的标签）。"""
        seen: dict[str, None] = {}
        for t in self.access_tokens.split(","):
            if t.strip():
                seen.setdefault(t.strip(), None)
        return list(seen)
