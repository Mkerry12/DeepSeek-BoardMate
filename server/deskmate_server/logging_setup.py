"""结构化访问日志：每个请求一行，带 request id、路径、状态码、耗时和令牌标签（不含令牌本身）。"""

import json
import logging
import re
import time
import uuid

logger = logging.getLogger("deskmate")

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_FIELDS = ("request_id", "method", "path", "status", "ms", "token")


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line = f"{self.formatTime(record, '%Y-%m-%d %H:%M:%S')} {record.levelname} {record.getMessage()}"
        extras = " ".join(f"{k}={getattr(record, k)}" for k in _FIELDS if hasattr(record, k))
        return f"{line} {extras}" if extras else line


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "msg": record.getMessage(),
        }
        data.update({k: getattr(record, k) for k in _FIELDS if hasattr(record, k)})
        return json.dumps(data, ensure_ascii=False)


def setup_logging(level: str = "INFO", fmt: str = "text") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter() if fmt == "json" else TextFormatter())
    logger.handlers[:] = [handler]
    logger.setLevel(level.upper())
    logger.propagate = False


class AccessLogMiddleware:
    """纯 ASGI 中间件（不缓冲 SSE）：耗时算到响应结束，回写 X-Request-ID。"""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode("latin-1")
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex[:12]
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        start = time.perf_counter()
        status = 500

        async def send_wrapper(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", [])
                message["headers"] = [*message["headers"], (b"x-request-id", request_id.encode())]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            logger.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": scope.get("method", ""),
                    "path": scope.get("path", ""),
                    "status": status,
                    "ms": round((time.perf_counter() - start) * 1000, 1),
                    "token": state.get("token_label", "-"),
                },
            )
