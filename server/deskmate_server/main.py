"""应用工厂与启动入口。"""

import asyncio
import contextlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import TokenAuth
from .bodylimit import BodyLimitMiddleware
from .config import OLD_EXAMPLE_TOKENS, Settings
from .logging_setup import AccessLogMiddleware, logger, setup_logging
from .ollama import OllamaClient
from .ratelimit import RateLimiter
from .routes import ROUTERS
from .token_store import TokenStore
from .tts import TTSService


@asynccontextmanager
async def lifespan(app: FastAPI):
    tts: TTSService = app.state.tts
    logger.info("语音合成：%s", tts.describe())
    warmup = asyncio.create_task(tts.warmup())
    try:
        yield
    finally:
        warmup.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await warmup


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="DeepSeek DeskMate Server", lifespan=lifespan)
    app.state.settings = settings
    app.state.auth = TokenAuth(settings.env_tokens, TokenStore(settings.db_path))
    app.state.limiter = RateLimiter()
    app.state.ollama = OllamaClient(settings.ollama_url, settings.ollama_model)
    app.state.chat_semaphore = asyncio.Semaphore(settings.max_concurrency)
    app.state.tts = TTSService(settings)

    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.add_middleware(AccessLogMiddleware)
    for router in ROUTERS:
        app.include_router(router)
    return app


def run() -> None:
    import sys

    import uvicorn
    from pydantic import ValidationError

    try:
        settings = Settings()
    except ValidationError as e:
        sys.exit(f"配置有误（检查 server/.env 或环境变量）：\n{e}")
    setup_logging(settings.log_level, settings.log_format)
    app = create_app(settings)
    if not app.state.auth.enabled:
        logger.warning(
            "没有任何令牌（ACCESS_TOKENS 为空，令牌库也是空的），任何人都能调用！仅限本机调试使用。"
        )
    if any(t in OLD_EXAMPLE_TOKENS for t in settings.env_tokens):
        logger.warning(
            "ACCESS_TOKENS 里有旧版 .env.example 的示例令牌（公开仓库里谁都看得到），请尽快删掉，改用令牌库发令牌！"
        )
    uvicorn.run(app, host=settings.host, port=settings.port, access_log=False)
