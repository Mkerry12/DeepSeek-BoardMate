import re

import edge_tts
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from ..auth import TTSAuth
from ..schemas import TTSRequest

router = APIRouter()

VOICE_RE = re.compile(r"^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$")


@router.post("/tts")
async def tts(req: TTSRequest, request: Request, _: TTSAuth):
    """微软 Edge 神经网络语音，返回 mp3。"""
    state = request.app.state
    voice = req.voice or state.settings.tts_voice
    if not VOICE_RE.match(voice):
        raise HTTPException(status_code=400, detail="不支持的音色")
    audio = bytearray()
    async with state.tts_semaphore:
        try:
            text = req.text.strip()[: state.settings.tts_max_chars]
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if chunk["type"] == "audio":
                    audio += chunk["data"]
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"语音合成失败: {e.__class__.__name__}") from e
    if not audio:
        raise HTTPException(status_code=502, detail="语音合成失败")
    return Response(bytes(audio), media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
