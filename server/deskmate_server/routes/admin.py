"""可选的令牌管理接口（设置了 ADMIN_TOKEN 才启用）。日常用命令行 python -m deskmate_server.tokens 即可。"""

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import require_admin
from ..token_store import TokenError, TokenStore

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])


class NewToken(BaseModel):
    label: str = Field(min_length=1, max_length=64)


def _store(request: Request) -> TokenStore:
    return request.app.state.auth.store


@router.get("/tokens")
def list_tokens(request: Request):
    return {"tokens": [asdict(t) for t in _store(request).list_tokens()]}


@router.post("/tokens")
def add_token(body: NewToken, request: Request):
    try:
        record, token = _store(request).add(body.label)
    except TokenError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return {"id": record.id, "label": record.label, "token": token}


@router.post("/tokens/{ref}/revoke")
def revoke_token(ref: str, request: Request):
    try:
        record = _store(request).revoke(ref)
    except TokenError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None
    return {"id": record.id, "label": record.label, "revoked": True}
