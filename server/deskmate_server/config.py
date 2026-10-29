"""配置：从环境变量 / server/.env 读取（变量名与 .env.example 一致），启动时校验。"""

from functools import cached_property
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_DIR = Path(__file__).resolve().parents[1]


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
    tts_voice: str = "zh-CN-XiaoyiNeural"
    tts_max_chars: int = Field(default=300, ge=1)
    tts_rate_per_min: int = Field(default=90, ge=1)
    # 令牌数据库（相对路径以 server/ 为基准）
    db_path: Path = Field(default=Path("data/deskmate.db"), validate_default=True)
    # 管理接口 /admin/* 的令牌；留空则关闭这些接口
    admin_token: str = ""
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: str = "INFO"
    log_format: str = Field(default="text", pattern="^(text|json)$")

    @field_validator("ollama_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @field_validator("db_path")
    @classmethod
    def _resolve_db(cls, v: Path) -> Path:
        return v if v.is_absolute() else SERVER_DIR / v

    @cached_property
    def env_tokens(self) -> list[str]:
        """ACCESS_TOKENS 去空白、去重，保持原顺序（顺序决定 token-1、token-2 这样的标签）。"""
        seen: dict[str, None] = {}
        for t in self.access_tokens.split(","):
            if t.strip():
                seen.setdefault(t.strip(), None)
        return list(seen)
