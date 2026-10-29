from fastapi import APIRouter, Request
from fastapi.responses import Response

from ..auth import TTSAuth
from ..schemas import TTSRequest
from ..tts import TTSService

router = APIRouter()


@router.post("/tts")
async def tts(req: TTSRequest, request: Request, _: TTSAuth):
    """朗读一句话，返回音频二进制：Edge 是 audio/mpeg，GPT-SoVITS 是 audio/wav 或 audio/ogg。"""
    service: TTSService = request.app.state.tts
    audio = await service.synthesize(req.text, req.voice, request.is_disconnected)
    return Response(
        audio.data,
        media_type=audio.media_type,
        headers={"Cache-Control": "no-store", "X-TTS-Provider": audio.provider},
    )


@router.get("/tts/voices")
async def voices(request: Request, _: TTSAuth):
    """当前语音提供方可选的音色，客户端设置里的音色下拉框用。"""
    return request.app.state.tts.voices()
