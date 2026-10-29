from typing import Literal

from pydantic import BaseModel, Field


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=100)
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
