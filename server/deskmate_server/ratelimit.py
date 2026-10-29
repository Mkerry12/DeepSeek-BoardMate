"""按 (桶, 调用方) 的 60 秒滑动窗口限流。"""

import time
from collections import defaultdict, deque
from collections.abc import Callable

WINDOW_SECONDS = 60


class RateLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.windows: dict[tuple[str, str], deque[float]] = defaultdict(deque)

    def hit(self, bucket: str, key: str, limit: int) -> bool:
        """记一次请求；超过每分钟 limit 次返回 False（不记入）。"""
        now = self.clock()
        window = self.windows[(bucket, key)]
        while window and now - window[0] > WINDOW_SECONDS:
            window.popleft()
        if len(window) >= limit:
            return False
        window.append(now)
        return True

    def clear(self) -> None:
        self.windows.clear()
