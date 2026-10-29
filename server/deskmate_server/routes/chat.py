import json

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..auth import ChatAuth
from ..logging_setup import logger
from ..persona import system_prompt
from ..schemas import ChatRequest
from ..stream_filter import StreamFilter

router = APIRouter()


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(req: ChatRequest, request: Request, _: ChatAuth):
    state = request.app.state
    settings = state.settings
    history = req.messages[-settings.max_history :]
    if history[-1].role != "user":
        raise HTTPException(status_code=400, detail="最后一条消息必须来自用户")
    if len(history[-1].content) > settings.max_input_chars:
        raise HTTPException(status_code=400, detail=f"消息太长啦（最多 {settings.max_input_chars} 字）")
    if req.persona and len(req.persona) > settings.max_persona_chars:
        raise HTTPException(status_code=400, detail=f"人设太长啦（最多 {settings.max_persona_chars} 字）")

    system = system_prompt(req.persona, req.memory, settings.memory_max_chars)
    payload = {
        "model": await state.ollama.pick_model(req.model),
        "stream": True,
        # 新版 Ollama 支持关闭思考；旧版会忽略该字段，<think> 由 StreamFilter 兜底过滤
        "think": False,
        "messages": [{"role": "system", "content": system}] + [m.model_dump() for m in history],
    }
    semaphore = state.chat_semaphore

    async def generate():
        if semaphore.locked():
            yield sse({"type": "queued"})
        async with semaphore:
            flt = StreamFilter()
            thinking_sent = False
            try:
                async with state.ollama.stream_chat(payload) as r:
                    if r.status_code != 200:
                        # 错误内容可能带本机路径，只写日志
                        body = (await r.aread()).decode(errors="ignore")[:500]
                        logger.warning("Ollama 返回 %s：%s", r.status_code, body)
                        yield sse({"type": "error", "message": f"模型服务出错（{r.status_code}），稍后再试"})
                        return
                    async for line in r.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except ValueError:
                            logger.warning("Ollama 返回了无法解析的数据：%s", line[:200])
                            yield sse({"type": "error", "message": "模型服务返回了无法解析的数据"})
                            return
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
