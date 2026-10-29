"""请求体大小限制：在 FastAPI 解析 JSON（以及鉴权）之前就拒绝超大的请求体。"""

import json

MAX_BODY_BYTES = 256 * 1024


class BodyLimitMiddleware:
    """纯 ASGI 中间件。有 Content-Length 的直接比对；没有的（chunked）边读边数，超了就 413。
    请求体最多 256 KB，先读完再交给应用，不影响 SSE 响应。"""

    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        length = dict(scope.get("headers") or []).get(b"content-length")
        if length is not None:
            try:
                too_big = int(length) > self.max_bytes
            except ValueError:
                return await self._reject(send, 400, "Content-Length 无效")
            if too_big:
                return await self._reject(send, 413, "请求体太大")

        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                # 客户端已断开：原样交给应用处理
                pending = [message]
                break
            body = message.get("body", b"")
            size += len(body)
            if size > self.max_bytes:
                return await self._reject(send, 413, "请求体太大")
            chunks.append(body)
            if not message.get("more_body", False):
                pending = [{"type": "http.request", "body": b"".join(chunks), "more_body": False}]
                break

        async def replay():
            return pending.pop(0) if pending else await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send, status: int, detail: str) -> None:
        body = json.dumps({"detail": detail}, ensure_ascii=False).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
