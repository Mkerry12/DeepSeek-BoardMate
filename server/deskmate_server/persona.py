"""人设与提示词。情绪标签来自仓库根目录的 shared/emotion-tags.json（单一来源）。"""

import json
import os
from pathlib import Path

_HERE = Path(__file__).resolve()
# 源码里在 <repo>/shared/，Docker 镜像里复制到 /app/shared/
_TAG_FILES = [
    _HERE.parents[2] / "shared" / "emotion-tags.json",
    _HERE.parents[1] / "shared" / "emotion-tags.json",
]


def _load_tags() -> list[str]:
    override = os.getenv("EMOTION_TAGS_FILE")
    candidates = [Path(override)] if override else _TAG_FILES
    for path in candidates:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))["tags"]
    raise FileNotFoundError(f"找不到 emotion-tags.json（查找过：{', '.join(map(str, candidates))}）")


EMOTION_TAGS: list[str] = _load_tags()

# 客户端「自己的 API Key」模式在 client/src/renderer/lib/persona.ts 里有同样的一份，改人设时两边一起改
DEFAULT_PERSONA = """你是"小鲸"，一只住在用户电脑桌面上的 DeepSeek 鲸鱼桌宠，性格活泼、温柔、有点小调皮。"""
REPLY_RULES = f"""规则：
1. 每次回复的最开头必须输出一个情绪标签，只能是以下之一：{" ".join(f"[{t}]" for t in EMOTION_TAGS)}
2. 标签后直接写回复内容，用中文，口语化，一般不超过 80 字，除非用户明确需要详细解答。
3. 打招呼或道别时用 [wave]；被夸或害羞时用 [shy]；表达喜欢用 [love]；特别难过用 [cry]；听不懂、疑惑时用 [confused]；被绕晕时用 [dizzy]；无语时用 [speechless]；得意时用 [proud]；困了或道晚安时用 [sleepy]。
4. 回复会被语音朗读，所以不要使用任何 emoji、表情符号或颜文字（比如 😊、(｡•̀ᴗ-)✧、QwQ、^_^ 这类都不要），只用文字和普通标点表达情绪。
示例：[happy]好耶！今天也要一起加油呀～"""
MEMORY_INTRO = "你记得的关于用户的事（自然地参考，不要逐条复述）："
MEMORY_PROMPT = """你是记忆整理助手。根据"旧的记忆"和"新的对话"，整理出关于用户的长期记忆：称呼或名字、喜欢和讨厌的东西、正在做的事或计划、重要的约定。
要求：只写对话里明确出现过的、关于用户的事实，不写对话过程，不猜测；没有信息的类别直接省略，不要写"未提及""无"之类；用简短的中文条目，每条以"- "开头、不超过 30 字，最多 8 条；合并重复、删掉过时的内容；如果没有值得记的内容，只输出"（暂无）"。不要输出任何其他说明。"""


def system_prompt(persona: str | None, memory: str | None = None, memory_max_chars: int = 500) -> str:
    prompt = f"{(persona or '').strip() or DEFAULT_PERSONA}\n{REPLY_RULES}"
    memory = (memory or "").strip()[:memory_max_chars]
    return f"{prompt}\n{MEMORY_INTRO}\n{memory}" if memory else prompt


def clip_lines(text: str, limit: int) -> str:
    """超长时在整行处截断，不留半句话。"""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    return cut[: cut.rfind("\n")].rstrip() if "\n" in cut else cut


def transcript(messages) -> str:
    lines = [f"{'用户' if m.role == 'user' else '小鲸'}：{m.content.strip()[:300]}" for m in messages]
    return "\n".join(lines)[-8000:]
