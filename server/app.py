"""DeepSeek 桌宠后端：鉴权 + 限流 + 人设，转发到本地 Ollama 并以 SSE 流式返回。

Ollama 本身不对外暴露，花生壳只映射本服务的端口。
"""

import asyncio
import json
import os
import time
from collections import defaultdict, deque
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from stream_filter import StreamFilter

load_dotenv()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "deepseek-r1:8b")
ACCESS_TOKENS = {t.strip() for t in os.getenv("ACCESS_TOKENS", "").split(",") if t.strip()}
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "20"))
MAX_CONCURRENCY = int(os.getenv("MAX_CONCURRENCY", "2"))
MAX_HISTORY = int(os.getenv("MAX_HISTORY", "16"))
MAX_INPUT_CHARS = int(os.getenv("MAX_INPUT_CHARS", "1000"))
MAX_PERSONA_CHARS = int(os.getenv("MAX_PERSONA_CHARS", "1000"))

# 客户端「自己的 API Key」模式在 client/src/renderer/persona.js 里有同样的一份，改人设时两边一起改
DEFAULT_PERSONA = """你是"小鲸"，一只住在用户电脑桌面上的 DeepSeek 鲸鱼桌宠，性格活泼、温柔、有点小调皮。"""
REPLY_RULES = """规则：
1. 每次回复的最开头必须输出一个情绪标签，只能是以下之一：[happy] [sad] [angry] [surprised] [relaxed] [thinking] [wave] [neutral]
2. 标签后直接写回复内容，用中文，口语化，一般不超过 80 字，除非用户明确需要详细解答。
3. 打招呼或道别时用 [wave]。
示例：[happy]好耶！今天也要一起加油呀～"""

EMBEDDING_HINTS = ("embed", "bge", "bert")
MODELS_TTL = 30


def system_prompt(persona: str | None) -> str:
    return f"{(persona or '').strip() or DEFAULT_PERSONA}\n{REPLY_RULES}"

app = FastAPI(title="DeepSeek DeskMate Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
_requests: dict[str, deque] = defaultdict(deque)


def require_token(authorization: str = Header(default="")) -> str:
    if not ACCESS_TOKENS:
        return "anonymous"
    token = authorization.removeprefix("Bearer ").strip()
    if token not in ACCESS_TOKENS:
        raise HTTPException(status_code=401, detail="令牌无效")

    now = time.monotonic()
    window = _requests[token]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(status_code=429, detail="说太快啦，歇一会儿再聊吧")
    window.append(now)
    return token


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1)
    model: str | None = Field(default=None, max_length=200)
    persona: str | None = Field(default=None, max_length=20000)


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


_models_cache: tuple[float, list[str]] = (0.0, [])


def _is_embedding(model: dict) -> bool:
    details = model.get("details") or {}
    names = [model.get("name", ""), details.get("family") or "", *(details.get("families") or [])]
    text = " ".join(names).lower()
    return any(hint in text for hint in EMBEDDING_HINTS)


async def chat_models() -> list[str]:
    global _models_cache
    if time.monotonic() - _models_cache[0] < MODELS_TTL:
        return _models_cache[1]
    async with httpx.AsyncClient(timeout=5) as client:
        r = await client.get(f"{OLLAMA_URL}/api/tags")
        r.raise_for_status()
    names = [m["name"] for m in r.json().get("models", []) if not _is_embedding(m)]
    _models_cache = (time.monotonic(), names)
    return names


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            r.raise_for_status()
        ollama_ok = True
    except httpx.HTTPError:
        ollama_ok = False
    return {"ok": True, "ollama": ollama_ok, "model": OLLAMA_MODEL, "auth": bool(ACCESS_TOKENS)}


@app.get("/auth-check")
async def auth_check(_: str = Depends(require_token)):
    return {"ok": True}


@app.get("/models")
async def models(_: str = Depends(require_token)):
    try:
        names = await chat_models()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="无法连接 Ollama")
    return {"models": names, "default": OLLAMA_MODEL}


@app.post("/chat")
async def chat(req: ChatRequest, _: str = Depends(require_token)):
    history = req.messages[-MAX_HISTORY:]
    if history[-1].role != "user":
        raise HTTPException(status_code=400, detail="最后一条消息必须来自用户")
    if len(history[-1].content) > MAX_INPUT_CHARS:
        raise HTTPException(status_code=400, detail=f"消息太长啦（最多 {MAX_INPUT_CHARS} 字）")
    if req.persona and len(req.persona) > MAX_PERSONA_CHARS:
        raise HTTPException(status_code=400, detail=f"人设太长啦（最多 {MAX_PERSONA_CHARS} 字）")

    model = req.model or OLLAMA_MODEL
    if model != OLLAMA_MODEL:
        try:
            available = await chat_models()
        except httpx.HTTPError:
            raise HTTPException(status_code=502, detail="无法连接 Ollama")
        if model not in available:
            raise HTTPException(status_code=400, detail=f"服务器上没有模型 {model}")

    payload = {
        "model": model,
        "stream": True,
        # 新版 Ollama 支持关闭思考；旧版会忽略该字段，<think> 由 StreamFilter 兜底过滤
        "think": False,
        "messages": [{"role": "system", "content": system_prompt(req.persona)}]
        + [m.model_dump() for m in history],
    }

    async def generate():
        if _semaphore.locked():
            yield sse({"type": "queued"})
        async with _semaphore:
            flt = StreamFilter()
            thinking_sent = False
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=300)) as client:
                    async with client.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload) as r:
                        if r.status_code != 200:
                            body = (await r.aread()).decode(errors="ignore")[:200]
                            yield sse({"type": "error", "message": f"Ollama 错误 {r.status_code}: {body}"})
                            return
                        async for line in r.aiter_lines():
                            if not line:
                                continue
                            chunk = json.loads(line)
                            msg = chunk.get("message") or {}
                            if msg.get("thinking") and not thinking_sent:
                                thinking_sent = True
                                yield sse({"type": "thinking"})
                            for ev in flt.feed(msg.get("content", "")):
                                yield sse(ev)
                            if chunk.get("done"):
                                break
                for ev in flt.flush():
                    yield sse(ev)
                yield sse({"type": "done"})
            except httpx.HTTPError as e:
                yield sse({"type": "error", "message": f"连接 Ollama 失败: {e.__class__.__name__}"})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    if not ACCESS_TOKENS:
        print("[警告] 未设置 ACCESS_TOKENS，任何人都能调用！仅限本机调试使用。")
    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8000")))
