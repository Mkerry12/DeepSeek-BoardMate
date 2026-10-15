"""把模型的流式输出拆成桌宠能用的事件：

- 去掉 <think>...</think> 思考过程（标签可能被切在两个 chunk 之间）
- 解析回复开头的情绪标签，如 "[happy]"
"""

import re

# 客户端 client/src/renderer/stream-filter.js 里有同样的一份
EMOTIONS = {
    "neutral", "happy", "sad", "angry", "surprised", "relaxed", "thinking", "wave",
    "shy", "love", "cry", "confused", "dizzy", "speechless", "proud", "sleepy",
}

_OPEN = "<think>"
_CLOSE = "</think>"
_EMOTION_RE = re.compile(r"^\[\s*([a-zA-Z_]+)\s*\]")
_THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.S)
_MAX_TAG_LEN = 24


def strip_think(text: str) -> str:
    """非流式结果：去掉 <think> 段（没闭合就去到结尾；只有 </think> 就取它后面）。"""
    return _THINK_RE.sub("", text.rsplit(_CLOSE, 1)[-1]).strip()


def _partial_suffix(text: str, tag: str) -> int:
    """text 末尾有多少字符可能是 tag 的开头。"""
    for k in range(min(len(tag) - 1, len(text)), 0, -1):
        if tag.startswith(text[-k:]):
            return k
    return 0


class StreamFilter:
    def __init__(self) -> None:
        self._buf = ""
        self._in_think = False
        self._head = ""
        self._head_done = False

    def feed(self, text: str) -> list[dict]:
        events: list[dict] = []
        self._buf += text
        while True:
            if self._in_think:
                idx = self._buf.find(_CLOSE)
                if idx == -1:
                    keep = _partial_suffix(self._buf, _CLOSE)
                    self._buf = self._buf[len(self._buf) - keep:] if keep else ""
                    break
                self._buf = self._buf[idx + len(_CLOSE):]
                self._in_think = False
                continue

            idx = self._buf.find(_OPEN)
            if idx != -1:
                events += self._visible(self._buf[:idx])
                self._buf = self._buf[idx + len(_OPEN):]
                self._in_think = True
                events.append({"type": "thinking"})
                continue

            keep = _partial_suffix(self._buf, _OPEN)
            cut = len(self._buf) - keep
            events += self._visible(self._buf[:cut])
            self._buf = self._buf[cut:]
            break
        return events

    def flush(self) -> list[dict]:
        events: list[dict] = []
        if not self._in_think and self._buf:
            events += self._visible(self._buf)
        self._buf = ""
        if not self._head_done:
            self._head_done = True
            rest = self._head.strip()
            if rest:
                events.append({"type": "delta", "text": rest})
        return events

    def _visible(self, text: str) -> list[dict]:
        if not text:
            return []
        if self._head_done:
            return [{"type": "delta", "text": text}]

        self._head += text
        head = self._head.lstrip()
        if not head:
            return []
        if head[0] != "[":
            return self._finish_head(head)

        m = _EMOTION_RE.match(head)
        if m:
            events = []
            emotion = m.group(1).lower()
            if emotion in EMOTIONS:
                events.append({"type": "emotion", "value": emotion})
            return events + self._finish_head(head[m.end():].lstrip())
        if "]" in head or len(head) > _MAX_TAG_LEN:
            return self._finish_head(head)
        return []

    def _finish_head(self, rest: str) -> list[dict]:
        self._head_done = True
        self._head = ""
        return [{"type": "delta", "text": rest}] if rest else []
