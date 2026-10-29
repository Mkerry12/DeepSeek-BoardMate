"""Bearer 令牌鉴权 + 按令牌限流（FastAPI 依赖）。日志和限流只用令牌的标签 / id，从不记录令牌本身。"""

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from .config import Settings
from .token_store import TokenStore


@dataclass(frozen=True)
class Principal:
    key: str  # 限流用的稳定 id
    label: str  # 日志里显示的名字
    token_id: int | None = None  # 数据库里的令牌 id；ACCESS_TOKENS 里的为 None


ANONYMOUS = Principal("anonymous", "anonymous")


class TokenAuth:
    """先查数据库（server/data/deskmate.db），再查 ACCESS_TOKENS（旧方式，按顺序标为 token-1、token-2……）。

    数据库里已撤销的令牌即使还写在 ACCESS_TOKENS 里也会被拒绝。
    """

    def __init__(self, env_tokens: list[str], store: TokenStore | None = None) -> None:
        self._env = {t: Principal(f"env:{i}", f"token-{i}") for i, t in enumerate(env_tokens, 1)}
        self.store = store

    @property
    def enabled(self) -> bool:
        return bool(self._env) or (self.store is not None and self.store.has_any())

    def authenticate(self, token: str) -> Principal | None:
        if not token:
            return None
        if self.store is not None:
            record = self.store.lookup(token)
            if record is not None:
                return None if record.revoked else Principal(f"db:{record.id}", record.label, record.id)
        return self._env.get(token)

    def record_use(self, principal: Principal) -> None:
        if self.store is not None and principal.token_id is not None:
            self.store.record_use(principal.token_id)


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
        auth.record_use(principal)
        return principal

    return guard


def require_admin(request: Request, authorization: str = Header(default="")) -> None:
    """管理接口：未设置 ADMIN_TOKEN 时整组接口不存在（404）。"""
    expected = request.app.state.settings.admin_token
    if not expected:
        raise HTTPException(status_code=404, detail="Not Found")
    if not secrets.compare_digest(bearer_token(authorization).encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="令牌无效")
    request.state.token_label = "admin"


require_token = token_guard("chat", lambda s: s.rate_limit_per_min, "说太快啦，歇一会儿再聊吧")
require_tts_token = token_guard("tts", lambda s: s.tts_rate_per_min, "小鲸说累了，歇一会儿再读吧")

ChatAuth = Annotated[Principal, Depends(require_token)]
TTSAuth = Annotated[Principal, Depends(require_tts_token)]
