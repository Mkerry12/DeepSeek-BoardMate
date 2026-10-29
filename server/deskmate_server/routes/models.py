import httpx
from fastapi import APIRouter, HTTPException, Request

from ..auth import ChatAuth

router = APIRouter()


@router.get("/models")
async def models(request: Request, _: ChatAuth):
    ollama = request.app.state.ollama
    try:
        names = await ollama.chat_models()
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="无法连接 Ollama") from None
    return {"models": names, "default": ollama.default_model}
