from fastapi import APIRouter, Request

from ..auth import ChatAuth

router = APIRouter()


@router.get("/health")
async def health(request: Request):
    state = request.app.state
    return {
        "ok": True,
        "ollama": await state.ollama.ping(),
        "model": state.settings.ollama_model,
        "auth": state.auth.enabled,
        "tts": state.settings.tts_voice,
    }


@router.get("/auth-check")
async def auth_check(_: ChatAuth):
    return {"ok": True}
