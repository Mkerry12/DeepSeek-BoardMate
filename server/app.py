"""兼容入口：`python app.py` 与 `python -m deskmate_server` 等价。代码在 deskmate_server/ 包里。"""

from deskmate_server.main import run

if __name__ == "__main__":
    run()
