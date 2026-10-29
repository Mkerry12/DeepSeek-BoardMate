import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from deskmate_server import tokens as cli
from deskmate_server.main import create_app
from deskmate_server.token_store import TokenError, TokenStore, hash_token
from tests.conftest import AUTH, make_settings


class Clock:
    def __init__(self) -> None:
        self.t = datetime(2026, 1, 1, 4, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.t


@pytest.fixture
def store(tmp_path):
    s = TokenStore(tmp_path / "data" / "t.db", now=Clock())
    yield s
    s.close()


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------- 存储 ----------


def test_add_stores_only_hash(store):
    record, token = store.add("小明")
    assert token.startswith("dsk_") and len(token) > 30
    rows = store._db.execute("SELECT * FROM tokens").fetchall()
    assert len(rows) == 1
    assert rows[0]["token_hash"] == hash_token(token)
    assert token not in [str(v) for v in tuple(rows[0])]
    assert store.lookup(token) == record
    assert store.lookup("nope") is None


def test_db_file_and_parent_dir_created(tmp_path):
    TokenStore(tmp_path / "a" / "b" / "x.db").close()
    assert (tmp_path / "a" / "b" / "x.db").is_file()


@pytest.mark.parametrize("label", ["", "   ", "x" * 65, "123"])
def test_bad_labels(store, label):
    with pytest.raises(TokenError):
        store.add(label)


def test_duplicate_active_label_rejected_but_reusable_after_revoke(store):
    store.add("小明")
    with pytest.raises(TokenError, match="已被使用"):
        store.add("小明")
    store.revoke("小明")
    record, _ = store.add("小明")
    assert record.id == 2


def test_revoke_by_id_and_label(store):
    a, _ = store.add("a")
    store.add("b")
    assert store.revoke(str(a.id)).label == "a"
    assert store.revoke("b").revoked
    with pytest.raises(TokenError, match="早就撤销"):
        store.revoke(str(a.id))
    with pytest.raises(TokenError, match="找不到"):
        store.revoke("b")  # 按标签只找未撤销的
    with pytest.raises(TokenError, match="找不到"):
        store.revoke("99")


def test_rename(store):
    store.add("token-1")
    store.add("b")
    assert store.rename("token-1", "小红").label == "小红"
    with pytest.raises(TokenError):
        store.rename("小红", "b")


def test_usage_counters_per_day(store):
    record, _ = store.add("a")
    for _ in range(3):
        store.record_use(record.id)
    store._now.t += timedelta(days=1)
    store.record_use(record.id)
    [info] = store.list_tokens()
    assert (info.today, info.total) == (1, 4)
    assert info.last_used_at == store._now.t.isoformat(timespec="seconds")
    assert store._db.execute("SELECT COUNT(*) FROM token_usage").fetchone()[0] == 2


def test_list_active_only(store):
    store.add("a")
    store.add("b")
    store.revoke("a")
    assert [t.label for t in store.list_tokens(include_revoked=False)] == ["b"]
    assert [t.revoked_at is not None for t in store.list_tokens()] == [True, False]


def test_import_tokens_labels_and_skips(store):
    store.add("token-2")  # 占用了 token-2
    added, skipped = store.import_tokens(["alpha", "beta"])
    assert [r.label for r in added] == ["token-1", "token-2-2"]
    added, skipped = store.import_tokens(["alpha", "beta", "gamma"])
    assert ([r.label for r in added], skipped) == (["token-3"], 2)


def test_concurrent_connections_see_changes(tmp_path):
    path = tmp_path / "t.db"
    server, other = TokenStore(path), TokenStore(path)
    _, token = other.add("a")
    assert server.lookup(token) is not None
    other.revoke("a")
    assert server.lookup(token).revoked
    server.close()
    other.close()


# ---------- 鉴权集成 ----------


@pytest.fixture
def db_client(tmp_path):
    app = create_app(make_settings(db_path=tmp_path / "d.db"))
    with TestClient(app) as c:
        yield c, app.state.auth.store
    app.state.auth.store.close()


def test_db_token_accepted_and_counted(db_client):
    client, store = db_client
    record, token = store.add("小明")
    assert client.get("/auth-check", headers=bearer(token)).status_code == 200
    assert client.post("/tts", headers=bearer(token), json={"text": ""}).status_code == 422
    [info] = store.list_tokens()
    assert info.today == 2 and info.last_used_at is not None
    assert ("chat", f"db:{record.id}") in client.app.state.limiter.windows


def test_env_tokens_still_work_alongside_db(db_client):
    client, store = db_client
    store.add("小明")
    assert client.get("/auth-check", headers=AUTH).status_code == 200


def test_revoked_db_token_rejected_even_if_in_env(db_client):
    client, store = db_client
    store.import_tokens(["good-token"])
    assert client.get("/auth-check", headers=AUTH).status_code == 200
    store.revoke("token-1")
    assert client.get("/auth-check", headers=AUTH).status_code == 401
    # other-token 只在 .env 里，不受影响
    assert client.get("/auth-check", headers=bearer("other-token")).status_code == 200


def test_rate_limit_keyed_per_db_token(db_client):
    client, store = db_client
    _, a = store.add("a")
    _, b = store.add("b")
    for _ in range(5):
        assert client.get("/auth-check", headers=bearer(a)).status_code == 200
    assert client.get("/auth-check", headers=bearer(a)).status_code == 429
    assert client.get("/auth-check", headers=bearer(b)).status_code == 200
    assert {t.label: t.today for t in store.list_tokens()} == {"a": 5, "b": 1}  # 429 不计数


def test_auth_enabled_by_db_alone(tmp_path):
    app = create_app(make_settings(access_tokens="", db_path=tmp_path / "x.db"))
    with TestClient(app) as client:
        assert client.get("/auth-check").status_code == 200
        _, token = app.state.auth.store.add("a")
        assert client.get("/health").json()["auth"] is True
        assert client.get("/auth-check").status_code == 401
        assert client.get("/auth-check", headers=bearer(token)).status_code == 200
    app.state.auth.store.close()


# ---------- 管理接口 ----------


def test_admin_disabled_without_admin_token(client):
    assert client.get("/admin/tokens").status_code == 404
    assert client.get("/admin/tokens", headers=AUTH).status_code == 404


def test_admin_endpoints(tmp_path):
    app = create_app(make_settings(admin_token="adm-secret", db_path=tmp_path / "a.db"))
    admin = bearer("adm-secret")
    with TestClient(app) as client:
        assert client.get("/admin/tokens").status_code == 401
        assert client.get("/admin/tokens", headers=AUTH).status_code == 401
        r = client.post("/admin/tokens", headers=admin, json={"label": "小明"})
        assert r.status_code == 200
        token = r.json()["token"]
        assert client.post("/admin/tokens", headers=admin, json={"label": "小明"}).status_code == 400
        assert client.get("/auth-check", headers=bearer(token)).status_code == 200
        listed = client.get("/admin/tokens", headers=admin).json()["tokens"]
        assert listed[0]["label"] == "小明" and listed[0]["today"] == 1
        assert "token" not in listed[0] and "token_hash" not in listed[0]
        assert client.post("/admin/tokens/小明/revoke", headers=admin).json()["revoked"] is True
        assert client.post("/admin/tokens/小明/revoke", headers=admin).status_code == 404
        assert client.get("/auth-check", headers=bearer(token)).status_code == 401
    app.state.auth.store.close()


# ---------- 命令行 ----------


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    from deskmate_server.config import Settings

    # 不读本机 server/.env
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    monkeypatch.setenv("ACCESS_TOKENS", "env-secret-a,env-secret-b")
    return tmp_path / "cli.db"


def run(db, *args) -> int:
    return cli.main(["--db", str(db), *args])


def test_cli_add_list_revoke(cli_env, capsys):
    assert run(cli_env, "add", "小明") == 0
    out = capsys.readouterr().out
    token = next(line.strip() for line in out.splitlines() if line.strip().startswith("dsk_"))
    assert run(cli_env, "list") == 0
    out = capsys.readouterr().out
    assert "小明" in out and "有效" in out and token not in out
    assert "其中 0 个已导入" in out
    assert run(cli_env, "revoke", "小明") == 0
    assert run(cli_env, "revoke", "小明") == 1
    assert "找不到" in capsys.readouterr().err
    run(cli_env, "list")
    assert "已撤销" in capsys.readouterr().out


def test_cli_import_env_never_prints_tokens(cli_env, capsys):
    assert run(cli_env, "import-env") == 0
    out = capsys.readouterr().out
    assert "token-1" in out and "token-2" in out and "导入 2 个" in out
    assert "env-secret" not in out
    assert run(cli_env, "import-env") == 0
    assert "跳过已存在的 2 个" in capsys.readouterr().out
    assert run(cli_env, "rename", "token-1", "小红") == 0
    run(cli_env, "list")
    out = capsys.readouterr().out
    assert "小红" in out and "其中 2 个已导入" in out and "env-secret" not in out
    db = sqlite3.connect(cli_env)
    assert db.execute(
        "SELECT COUNT(*) FROM tokens WHERE token_hash = ?", (hash_token("env-secret-a"),)
    ).fetchone()[0]
    db.close()


def test_cli_list_empty(cli_env, capsys):
    assert run(cli_env, "list") == 0
    assert "还没有令牌" in capsys.readouterr().out


def test_format_table_aligns_wide_chars():
    from deskmate_server.token_store import TokenInfo

    table = cli.format_table(
        [
            TokenInfo(1, "小明", "2026-01-01T00:00:00+00:00", None, None, 0, 0),
            TokenInfo(2, "bob", "2026-01-01T00:00:00+00:00", None, None, 3, 10),
        ]
    )
    lines = table.splitlines()
    assert len(lines) == 3
    assert cli._width(lines[1][: lines[1].index("2026")]) == cli._width(lines[2][: lines[2].index("2026")])
