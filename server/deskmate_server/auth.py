"""Bearer 令牌鉴权 + 按令牌限流（FastAPI 依赖）。日志和限流只用令牌的标签 / id，从不记录令牌本身。"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from .config import Settings


@dataclass(frozen=True)
class Principal:
    key: str  # 限流用的稳定 id
    label: str  # 日志里显示的名字


ANONYMOUS = Principal("anonymous", "anonymous")


class TokenAuth:
    """ACCESS_TOKENS 里的令牌，按顺序标为 token-1、token-2……"""

    def __init__(self, env_tokens: list[str]) -> None:
        self._env = {t: Principal(f"env:{i}", f"token-{i}") for i, t in enumerate(env_tokens, 1)}

    @property
    def enabled(self) -> bool:
        return bool(self._env)

    def authenticate(self, token: str) -> Principal | None:
        return self._env.get(token) if token else None


def bearer_token(authorization: str) -> str:
    return authorization.removeprefix("Bearer ").strip()


def token_guard(bucket: str, limit: Callable[[Settings], int], message: str):
    """鉴权 + 按令牌分桶限流（朗读一句一请求，不占聊天的额度）。"""

    def guard(request: Request, authorization: str = Header(default="")) -> Principal:
        state = request.app.state
        auth: TokenAuth = state.auth
        if auth.enabled:
            principal = auth.authenticate(bearer_token(authorization))
            if principal is None:
                raise HTTPException(status_code=401, detail="令牌无效")
        else:
            principal = ANONYMOUS
        request.state.token_label = principal.label
        if not state.limiter.hit(bucket, principal.key, limit(state.settings)):
            raise HTTPException(status_code=429, detail=message)
        return principal

    return guard


require_token = token_guard("chat", lambda s: s.rate_limit_per_min, "说太快啦，歇一会儿再聊吧")
require_tts_token = token_guard("tts", lambda s: s.tts_rate_per_min, "小鲸说累了，歇一会儿再读吧")

ChatAuth = Annotated[Principal, Depends(require_token)]
TTSAuth = Annotated[Principal, Depends(require_tts_token)]
