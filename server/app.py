"""DeepSeek 桌宠后端：鉴权 + 限流 + 人设，转发到本地 Ollama 并以 SSE 流式返回。

Ollama 本身不对外暴露，花生壳只映射本服务的端口。
"""

import asyncio
import json
import os
import re
import time
from collections import defaultdict, deque
from typing import Literal

import edge_tts
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from stream_filter import StreamFilter, strip_think

load_dotenv()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "deepseek-r1:8b")
ACCESS_TOKENS = {t.strip() for t in os.getenv("ACCESS_TOKENS", "").split(",") if t.strip()}
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "20"))
MAX_CONCURRENCY = int(os.getenv("MAX_CONCURRENCY", "2"))
MAX_HISTORY = int(os.getenv("MAX_HISTORY", "16"))
MAX_INPUT_CHARS = int(os.getenv("MAX_INPUT_CHARS", "1000"))
MAX_PERSONA_CHARS = int(os.getenv("MAX_PERSONA_CHARS", "1000"))
MEMORY_MAX_CHARS = int(os.getenv("MEMORY_MAX_CHARS", "500"))
TTS_VOICE = os.getenv("TTS_VOICE", "zh-CN-XiaoyiNeural")
TTS_MAX_CHARS = int(os.getenv("TTS_MAX_CHARS", "300"))
TTS_RATE_PER_MIN = int(os.getenv("TTS_RATE_PER_MIN", "90"))

# 客户端「自己的 API Key」模式在 client/src/renderer/persona.js 里有同样的一份，改人设时两边一起改
DEFAULT_PERSONA = """你是"小鲸"，一只住在用户电脑桌面上的 DeepSeek 鲸鱼桌宠，性格活泼、温柔、有点小调皮。"""
REPLY_RULES = """规则：
1. 每次回复的最开头必须输出一个情绪标签，只能是以下之一：[happy] [sad] [angry] [surprised] [relaxed] [thinking] [wave] [neutral] [shy] [love] [cry] [confused] [dizzy] [speechless] [proud] [sleepy]
2. 标签后直接写回复内容，用中文，口语化，一般不超过 80 字，除非用户明确需要详细解答。
3. 打招呼或道别时用 [wave]；被夸或害羞时用 [shy]；表达喜欢用 [love]；特别难过用 [cry]；听不懂、疑惑时用 [confused]；被绕晕时用 [dizzy]；无语时用 [speechless]；得意时用 [proud]；困了或道晚安时用 [sleepy]。
示例：[happy]好耶！今天也要一起加油呀～"""
MEMORY_INTRO = "你记得的关于用户的事（自然地参考，不要逐条复述）："
MEMORY_PROMPT = """你是记忆整理助手。根据"旧的记忆"和"新的对话"，整理出关于用户的长期记忆：称呼或名字、喜欢和讨厌的东西、正在做的事或计划、重要的约定。
要求：只写对话里明确出现过的、关于用户的事实，不写对话过程，不猜测；没有信息的类别直接省略，不要写"未提及""无"之类；用简短的中文条目，每条以"- "开头、不超过 30 字，最多 8 条；合并重复、删掉过时的内容；如果没有值得记的内容，只输出"（暂无）"。不要输出任何其他说明。"""

EMBEDDING_HINTS = ("embed", "bge", "bert")
MODELS_TTL = 30
VOICE_RE = re.compile(r"^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$")


def system_prompt(persona: str | None, memory: str | None = None) -> str:
    prompt = f"{(persona or '').strip() or DEFAULT_PERSONA}\n{REPLY_RULES}"
    memory = (memory or "").strip()[:MEMORY_MAX_CHARS]
    return f"{prompt}\n{MEMORY_INTRO}\n{memory}" if memory else prompt

app = FastAPI(title="DeepSeek DeskMate Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
_tts_semaphore = asyncio.Semaphore(4)
_requests: dict[tuple[str, str], deque] = defaultdict(deque)


def token_guard(bucket: str, limit: int, message: str):
    """鉴权 + 按令牌分桶限流（朗读一句一请求，不占聊天的额度）。"""

    def guard(authorization: str = Header(default="")) -> str:
        token = authorization.removeprefix("Bearer ").strip()
        if ACCESS_TOKENS and token not in ACCESS_TOKENS:
            raise HTTPException(status_code=401, detail="令牌无效")
        token = token if ACCESS_TOKENS else "anonymous"

        now = time.monotonic()
        window = _requests[(bucket, token)]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= limit:
            raise HTTPException(status_code=429, detail=message)
        window.append(now)
        return token

    return guard


require_token = token_guard("chat", RATE_LIMIT_PER_MIN, "说太快啦，歇一会儿再聊吧")
require_tts_token = token_guard("tts", TTS_RATE_PER_MIN, "小鲸说累了，歇一会儿再读吧")


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1)
    model: str | None = Field(default=None, max_length=200)
    persona: str | None = Field(default=None, max_length=20000)
    memory: str | None = Field(default=None, max_length=4000)


class MemoryRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=80)
    memory: str | None = Field(default=None, max_length=4000)
    model: str | None = Field(default=None, max_length=200)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice: str | None = Field(default=None, max_length=80)


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
    return {"ok": True, "ollama": ollama_ok, "model": OLLAMA_MODEL, "auth": bool(ACCESS_TOKENS), "tts": TTS_VOICE}


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


async def pick_model(requested: str | None) -> str:
    model = requested or OLLAMA_MODEL
    if model != OLLAMA_MODEL:
        try:
            available = await chat_models()
        except httpx.HTTPError:
            raise HTTPException(status_code=502, detail="无法连接 Ollama")
        if model not in available:
            raise HTTPException(status_code=400, detail=f"服务器上没有模型 {model}")
    return model


@app.post("/chat")
async def chat(req: ChatRequest, _: str = Depends(require_token)):
    history = req.messages[-MAX_HISTORY:]
    if history[-1].role != "user":
        raise HTTPException(status_code=400, detail="最后一条消息必须来自用户")
    if len(history[-1].content) > MAX_INPUT_CHARS:
        raise HTTPException(status_code=400, detail=f"消息太长啦（最多 {MAX_INPUT_CHARS} 字）")
    if req.persona and len(req.persona) > MAX_PERSONA_CHARS:
        raise HTTPException(status_code=400, detail=f"人设太长啦（最多 {MAX_PERSONA_CHARS} 字）")

    payload = {
        "model": await pick_model(req.model),
        "stream": True,
        # 新版 Ollama 支持关闭思考；旧版会忽略该字段，<think> 由 StreamFilter 兜底过滤
        "think": False,
        "messages": [{"role": "system", "content": system_prompt(req.persona, req.memory)}]
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


def clip_lines(text: str, limit: int) -> str:
    """超长时在整行处截断，不留半句话。"""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    return cut[: cut.rfind("\n")].rstrip() if "\n" in cut else cut


def transcript(messages: list[Message]) -> str:
    lines = [f"{'用户' if m.role == 'user' else '小鲸'}：{m.content.strip()[:300]}" for m in messages]
    return "\n".join(lines)[-8000:]


@app.post("/memory")
async def memory(req: MemoryRequest, _: str = Depends(require_token)):
    """把最近的对话和旧记忆整理成一段关于用户的长期记忆（非流式）。"""
    old = (req.memory or "").strip()[:MEMORY_MAX_CHARS] or "（暂无）"
    payload = {
        "model": await pick_model(req.model),
        "stream": False,
        "think": False,
        "messages": [
            {"role": "system", "content": MEMORY_PROMPT},
            {"role": "user", "content": f"旧的记忆：\n{old}\n\n新的对话：\n{transcript(req.messages)}"},
        ],
    }
    async with _semaphore:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=180)) as client:
                r = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
                r.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"连接 Ollama 失败: {e.__class__.__name__}")
    text = strip_think((r.json().get("message") or {}).get("content", ""))
    return {"memory": "" if "暂无" in text[:8] else clip_lines(text, MEMORY_MAX_CHARS)}


@app.post("/tts")
async def tts(req: TTSRequest, _: str = Depends(require_tts_token)):
    """微软 Edge 神经网络语音，返回 mp3。"""
    voice = req.voice or TTS_VOICE
    if not VOICE_RE.match(voice):
        raise HTTPException(status_code=400, detail="不支持的音色")
    audio = bytearray()
    async with _tts_semaphore:
        try:
            async for chunk in edge_tts.Communicate(req.text.strip()[:TTS_MAX_CHARS], voice).stream():
                if chunk["type"] == "audio":
                    audio += chunk["data"]
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"语音合成失败: {e.__class__.__name__}")
    if not audio:
        raise HTTPException(status_code=502, detail="语音合成失败")
    return Response(bytes(audio), media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    import uvicorn

    if not ACCESS_TOKENS:
        print("[警告] 未设置 ACCESS_TOKENS，任何人都能调用！仅限本机调试使用。")
    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8000")))
