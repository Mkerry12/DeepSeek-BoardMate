"""本地 Ollama 的 HTTP 客户端。"""

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import HTTPException

EMBEDDING_HINTS = ("embed", "bge", "bert")
MODELS_TTL = 30


def is_embedding(model: dict) -> bool:
    details = model.get("details") or {}
    names = [model.get("name", ""), details.get("family") or "", *(details.get("families") or [])]
    text = " ".join(names).lower()
    return any(hint in text for hint in EMBEDDING_HINTS)


class OllamaClient:
    def __init__(self, base_url: str, default_model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model
        self._models_cache: tuple[float, list[str]] = (0.0, [])

    async def ping(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                r = await client.get(f"{self.base_url}/api/tags")
                r.raise_for_status()
            return True
        except httpx.HTTPError:
            return False

    async def chat_models(self) -> list[str]:
        """可聊天的模型（排除 bge-m3 等嵌入模型），缓存 MODELS_TTL 秒。"""
        if time.monotonic() - self._models_cache[0] < MODELS_TTL:
            return self._models_cache[1]
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{self.base_url}/api/tags")
            r.raise_for_status()
        names = [m["name"] for m in r.json().get("models", []) if not is_embedding(m)]
        self._models_cache = (time.monotonic(), names)
        return names

    async def pick_model(self, requested: str | None) -> str:
        model = requested or self.default_model
        if model != self.default_model:
            try:
                available = await self.chat_models()
            except httpx.HTTPError:
                raise HTTPException(status_code=502, detail="无法连接 Ollama") from None
            if model not in available:
                raise HTTPException(status_code=400, detail=f"服务器上没有模型 {model}")
        return model

    @asynccontextmanager
    async def stream_chat(self, payload: dict) -> AsyncIterator[httpx.Response]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=300)) as client:
            async with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as r:
                yield r

    async def chat(self, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=180)) as client:
            r = await client.post(f"{self.base_url}/api/chat", json=payload)
            r.raise_for_status()
        return r.json()
