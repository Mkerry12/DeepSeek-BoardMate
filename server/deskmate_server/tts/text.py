"""朗读前的文本处理：去掉不该读出来的东西、按句切分。规则与客户端 services/voice.ts 的 cleanForSpeech 一致。"""

import re

_CLEAN_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"<think>.*?(</think>|$)", re.S), ""),
    (re.compile(r"```.*?(```|$)", re.S), ""),
    (re.compile(r"\[\s*[a-zA-Z_]+\s*\]"), ""),
    (re.compile(r"!?\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"https?://\S+"), ""),
    (re.compile(r"[*_`#>|~^=]+"), " "),
    # emoji、变体选择符、零宽连接符
    (re.compile("[\U0001f000-\U0001faff\u2600-\u27bf\ufe0f\u200d]"), ""),
    (re.compile(r"\s+"), " "),
]

_SENTENCE = re.compile(r".*?(?:[。！？!?…～~；;\n]+|$)", re.S)
_SOFT_BREAK = "，,、：:"


def clean_for_speech(text: str) -> str:
    for pattern, repl in _CLEAN_RULES:
        text = pattern.sub(repl, text)
    return text.strip()


def _hard_split(sentence: str, limit: int) -> list[str]:
    """单句超长：优先在逗号等处断开，实在没有就硬切。"""
    parts: list[str] = []
    while len(sentence) > limit:
        cut = max((sentence.rfind(ch, 0, limit) for ch in _SOFT_BREAK), default=-1)
        cut = cut + 1 if cut >= limit // 3 else limit
        parts.append(sentence[:cut])
        sentence = sentence[cut:]
    if sentence:
        parts.append(sentence)
    return parts


def split_text(text: str, limit: int) -> list[str]:
    """按句号等切开，再把相邻短句合并成不超过 limit 字的段，段数尽量少。"""
    pieces: list[str] = []
    for m in _SENTENCE.finditer(text):
        s = m.group(0).strip()
        if s:
            pieces += _hard_split(s, limit)
    chunks: list[str] = []
    for p in pieces:
        if chunks and len(chunks[-1]) + len(p) <= limit:
            chunks[-1] += p
        else:
            chunks.append(p)
    return chunks
