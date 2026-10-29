"""令牌管理命令行（在 server/ 目录下运行）：

python -m deskmate_server.tokens add 小明          # 新建令牌，只显示这一次
python -m deskmate_server.tokens list              # 标签、创建时间、最后使用、今日 / 累计请求、状态
python -m deskmate_server.tokens revoke 小明       # 按标签或 id 撤销
python -m deskmate_server.tokens rename 3 小红     # 改标签
python -m deskmate_server.tokens import-env        # 把 .env 里的 ACCESS_TOKENS 导入为 token-1、token-2……
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

from .config import Settings
from .token_store import TokenError, TokenInfo, TokenStore


def _local(ts: str | None) -> str:
    return datetime.fromisoformat(ts).astimezone().strftime("%Y-%m-%d %H:%M") if ts else "-"


def _width(text: str) -> int:
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in text)


def format_table(tokens: list[TokenInfo]) -> str:
    header = ["id", "标签", "创建时间", "最后使用", "今日", "累计", "状态"]
    rows = [
        [
            str(t.id),
            t.label,
            _local(t.created_at),
            _local(t.last_used_at),
            str(t.today),
            str(t.total),
            f"已撤销 {_local(t.revoked_at)}" if t.revoked_at else "有效",
        ]
        for t in tokens
    ]
    widths = [max(_width(r[i]) for r in [header, *rows]) for i in range(len(header))]
    lines = [
        "  ".join(cell + " " * (w - _width(cell)) for cell, w in zip(r, widths, strict=True)).rstrip()
        for r in [header, *rows]
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(prog="python -m deskmate_server.tokens", description="管理访问令牌")
    parser.add_argument(
        "--db", type=Path, help="令牌数据库路径（默认取 DB_PATH，即 server/data/deskmate.db）"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add", help="新建令牌（只显示一次）")
    p.add_argument("label", help="标签，比如朋友的名字")
    p = sub.add_parser("list", help="列出令牌和用量")
    p.add_argument("--active", action="store_true", help="只显示未撤销的")
    p = sub.add_parser("revoke", help="撤销令牌")
    p.add_argument("ref", help="标签或 id")
    p = sub.add_parser("rename", help="修改标签")
    p.add_argument("ref", help="标签或 id")
    p.add_argument("new_label")
    sub.add_parser("import-env", help="把 ACCESS_TOKENS 里的令牌导入数据库（已导入的跳过）")
    args = parser.parse_args(argv)

    settings = Settings()
    store = TokenStore(args.db or settings.db_path)
    try:
        if args.cmd == "add":
            record, token = store.add(args.label)
            print(f"已为「{record.label}」创建令牌（id {record.id}）。令牌只显示这一次，请复制发给对方：\n")
            print(f"    {token}\n")
            print("对方在桌宠右键「设置」→ 官方服务器 →「访问令牌」里填入即可。")
        elif args.cmd == "list":
            tokens = store.list_tokens(include_revoked=not args.active)
            print(
                format_table(tokens)
                if tokens
                else "还没有令牌。用 add <标签> 新建，或 import-env 导入 .env 里的。"
            )
            if settings.env_tokens:
                imported = sum(store.lookup(t) is not None for t in settings.env_tokens)
                print(
                    f"\n.env 的 ACCESS_TOKENS 里有 {len(settings.env_tokens)} 个令牌，其中 {imported} 个已导入数据库。"
                )
        elif args.cmd == "revoke":
            record = store.revoke(args.ref)
            print(f"已撤销 #{record.id}「{record.label}」，立即生效（无需重启）。")
            print("如果它也写在 .env 的 ACCESS_TOKENS 里，也会被拒绝；可以顺手从 .env 删掉。")
        elif args.cmd == "rename":
            record = store.rename(args.ref, args.new_label)
            print(f"#{record.id} 的标签改为「{record.label}」。")
        elif args.cmd == "import-env":
            if not settings.env_tokens:
                print("ACCESS_TOKENS 是空的，没有可导入的令牌。")
                return 0
            added, skipped = store.import_tokens(settings.env_tokens)
            for record in added:
                print(f"导入 #{record.id}「{record.label}」")
            print(f"导入 {len(added)} 个，跳过已存在的 {skipped} 个。可以用 rename 改成朋友的名字。")
    except TokenError as e:
        print(f"出错：{e}", file=sys.stderr)
        return 1
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
