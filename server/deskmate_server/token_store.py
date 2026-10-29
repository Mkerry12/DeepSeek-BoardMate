"""令牌存储（SQLite）：只存 sha256，不存明文；记录最后使用时间和每天的请求数。"""

import hashlib
import secrets
import sqlite3
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tokens_active_label ON tokens(label) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS token_usage (
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (token_id, day)
);
"""

MAX_LABEL = 64


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_token() -> str:
    return "dsk_" + secrets.token_urlsafe(24)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TokenError(ValueError):
    pass


@dataclass(frozen=True)
class TokenRecord:
    id: int
    label: str
    revoked: bool


@dataclass(frozen=True)
class TokenInfo:
    id: int
    label: str
    created_at: str
    revoked_at: str | None
    last_used_at: str | None
    today: int
    total: int


class TokenStore:
    def __init__(self, path: Path | str, now: Callable[[], datetime] = _utcnow) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._now = now
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False, timeout=5, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    def _stamp(self) -> str:
        return self._now().isoformat(timespec="seconds")

    def _today(self) -> str:
        # 按本机时区算「今天」
        return self._now().astimezone().date().isoformat()

    @staticmethod
    def _check_label(label: str) -> str:
        label = label.strip()
        if not label or len(label) > MAX_LABEL:
            raise TokenError(f"标签不能为空，最多 {MAX_LABEL} 个字符")
        if label.isdigit():
            raise TokenError("标签不能是纯数字（会和 id 混淆）")
        return label

    def _insert(self, label: str, token: str) -> TokenRecord:
        label = self._check_label(label)
        try:
            cur = self._db.execute(
                "INSERT INTO tokens (label, token_hash, created_at) VALUES (?, ?, ?)",
                (label, hash_token(token), self._stamp()),
            )
        except sqlite3.IntegrityError as e:
            if "token_hash" in str(e):
                raise TokenError("这个令牌已经存在") from None
            raise TokenError(f"标签「{label}」已被使用（先撤销旧的或换个名字）") from None
        return TokenRecord(cur.lastrowid, label, False)

    def add(self, label: str) -> tuple[TokenRecord, str]:
        """新建令牌，返回 (记录, 明文)。明文只在这里出现一次。"""
        token = generate_token()
        with self._lock:
            return self._insert(label, token), token

    def add_existing(self, label: str, token: str) -> TokenRecord:
        with self._lock:
            return self._insert(label, token)

    def lookup(self, token: str) -> TokenRecord | None:
        with self._lock:
            row = self._db.execute(
                "SELECT id, label, revoked_at FROM tokens WHERE token_hash = ?", (hash_token(token),)
            ).fetchone()
        return TokenRecord(row["id"], row["label"], row["revoked_at"] is not None) if row else None

    def has_any(self) -> bool:
        with self._lock:
            return self._db.execute("SELECT 1 FROM tokens LIMIT 1").fetchone() is not None

    def label_in_use(self, label: str) -> bool:
        with self._lock:
            row = self._db.execute(
                "SELECT 1 FROM tokens WHERE label = ? AND revoked_at IS NULL", (label,)
            ).fetchone()
        return row is not None

    def record_use(self, token_id: int) -> None:
        with self._lock:
            self._db.execute("UPDATE tokens SET last_used_at = ? WHERE id = ?", (self._stamp(), token_id))
            self._db.execute(
                "INSERT INTO token_usage (token_id, day, requests) VALUES (?, ?, 1) "
                "ON CONFLICT(token_id, day) DO UPDATE SET requests = requests + 1",
                (token_id, self._today()),
            )

    def _resolve(self, ref: str) -> sqlite3.Row:
        ref = ref.strip()
        if ref.isdigit():
            row = self._db.execute("SELECT * FROM tokens WHERE id = ?", (int(ref),)).fetchone()
        else:
            row = self._db.execute(
                "SELECT * FROM tokens WHERE label = ? AND revoked_at IS NULL", (ref,)
            ).fetchone()
        if row is None:
            raise TokenError(f"找不到令牌「{ref}」（用 id 或未撤销的标签）")
        return row

    def revoke(self, ref: str) -> TokenRecord:
        with self._lock:
            row = self._resolve(ref)
            if row["revoked_at"]:
                raise TokenError(f"令牌 #{row['id']}「{row['label']}」早就撤销了")
            self._db.execute("UPDATE tokens SET revoked_at = ? WHERE id = ?", (self._stamp(), row["id"]))
        return TokenRecord(row["id"], row["label"], True)

    def rename(self, ref: str, new_label: str) -> TokenRecord:
        new_label = self._check_label(new_label)
        with self._lock:
            row = self._resolve(ref)
            try:
                self._db.execute("UPDATE tokens SET label = ? WHERE id = ?", (new_label, row["id"]))
            except sqlite3.IntegrityError:
                raise TokenError(f"标签「{new_label}」已被使用") from None
        return TokenRecord(row["id"], new_label, row["revoked_at"] is not None)

    def list_tokens(self, include_revoked: bool = True) -> list[TokenInfo]:
        sql = """
            SELECT t.*,
                   COALESCE((SELECT requests FROM token_usage WHERE token_id = t.id AND day = ?), 0) AS today,
                   COALESCE((SELECT SUM(requests) FROM token_usage WHERE token_id = t.id), 0) AS total
            FROM tokens t
        """
        if not include_revoked:
            sql += " WHERE t.revoked_at IS NULL"
        with self._lock:
            rows = self._db.execute(sql + " ORDER BY t.id", (self._today(),)).fetchall()
        return [
            TokenInfo(
                r["id"],
                r["label"],
                r["created_at"],
                r["revoked_at"],
                r["last_used_at"],
                r["today"],
                r["total"],
            )
            for r in rows
        ]

    def import_tokens(self, tokens: list[str], prefix: str = "token") -> tuple[list[TokenRecord], int]:
        """导入明文令牌（如 ACCESS_TOKENS），按顺序标为 token-1、token-2……；已存在的跳过。"""
        added: list[TokenRecord] = []
        skipped = 0
        for i, token in enumerate(tokens, 1):
            if self.lookup(token) is not None:
                skipped += 1
                continue
            label, n = f"{prefix}-{i}", 1
            while self.label_in_use(label):
                n += 1
                label = f"{prefix}-{i}-{n}"
            added.append(self.add_existing(label, token))
        return added, skipped
