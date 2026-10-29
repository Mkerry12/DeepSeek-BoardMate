from . import chat, health, memory, models, tts

ROUTERS = [health.router, models.router, chat.router, memory.router, tts.router]
