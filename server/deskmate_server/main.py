"""应用工厂与启动入口。"""

import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import TokenAuth
from .config import Settings
from .logging_setup import AccessLogMiddleware, logger, setup_logging
from .ollama import OllamaClient
from .ratelimit import RateLimiter
from .routes import ROUTERS


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="DeepSeek DeskMate Server")
    app.state.settings = settings
    app.state.auth = TokenAuth(settings.env_tokens)
    app.state.limiter = RateLimiter()
    app.state.ollama = OllamaClient(settings.ollama_url, settings.ollama_model)
    app.state.chat_semaphore = asyncio.Semaphore(settings.max_concurrency)
    app.state.tts_semaphore = asyncio.Semaphore(4)

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
        logger.warning("未设置 ACCESS_TOKENS，任何人都能调用！仅限本机调试使用。")
    uvicorn.run(app, host=settings.host, port=settings.port, access_log=False)
