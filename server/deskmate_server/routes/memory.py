import httpx
from fastapi import APIRouter, HTTPException, Request

from ..auth import ChatAuth
from ..persona import MEMORY_PROMPT, clip_lines, transcript
from ..schemas import MemoryRequest
from ..stream_filter import strip_think

router = APIRouter()


@router.post("/memory")
async def memory(req: MemoryRequest, request: Request, _: ChatAuth):
    """把最近的对话和旧记忆整理成一段关于用户的长期记忆（非流式）。"""
    state = request.app.state
    limit = state.settings.memory_max_chars
    old = (req.memory or "").strip()[:limit] or "（暂无）"
    payload = {
        "model": await state.ollama.pick_model(req.model),
        "stream": False,
        "think": False,
        "messages": [
            {"role": "system", "content": MEMORY_PROMPT},
            {"role": "user", "content": f"旧的记忆：\n{old}\n\n新的对话：\n{transcript(req.messages)}"},
        ],
    }
    async with state.chat_semaphore:
        try:
            data = await state.ollama.chat(payload)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"连接 Ollama 失败: {e.__class__.__name__}") from e
    text = strip_think((data.get("message") or {}).get("content", ""))
    return {"memory": "" if "暂无" in text[:8] else clip_lines(text, limit)}
