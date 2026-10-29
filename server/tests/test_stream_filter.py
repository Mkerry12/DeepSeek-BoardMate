import pytest

from deskmate_server.stream_filter import StreamFilter, strip_think


def run(chunks: list[str]) -> list[dict]:
    flt = StreamFilter()
    events = [ev for chunk in chunks for ev in flt.feed(chunk)]
    return events + flt.flush()


def text(events: list[dict]) -> str:
    return "".join(e["text"] for e in events if e["type"] == "delta")


def emotions(events: list[dict]) -> list[str]:
    return [e["value"] for e in events if e["type"] == "emotion"]


def test_leading_emotion_tag():
    events = run(["[happy]好耶！"])
    assert events[0] == {"type": "emotion", "value": "happy"}
    assert text(events) == "好耶！"


@pytest.mark.parametrize(
    "chunks",
    [
        ["[ha", "ppy]你好"],
        ["[", "h", "a", "p", "p", "y", "]", "你", "好"],
        ["  [ HAPPY ] ", "你好"],
    ],
)
def test_emotion_tag_split_or_spaced(chunks):
    events = run(chunks)
    assert emotions(events) == ["happy"]
    assert text(events) == "你好"


def test_unknown_emotion_is_dropped_but_text_kept():
    events = run(["[bogus]你好"])
    assert emotions(events) == []
    assert text(events) == "你好"


def test_no_tag_passes_text_through():
    events = run(["你好", "呀"])
    assert emotions(events) == []
    assert text(events) == "你好呀"


def test_only_first_tag_is_parsed():
    events = run(["[happy]好", "[sad]的"])
    assert emotions(events) == ["happy"]
    assert text(events) == "好[sad]的"


def test_long_bracket_head_gives_up():
    head = "[这不是一个情绪标签而是一段很长很长很长的文字"
    events = run([head, "后面"])
    assert emotions(events) == []
    assert text(events) == head + "后面"


def test_think_block_removed():
    events = run(["<think>想一想</think>[happy]答案"])
    assert events[0] == {"type": "thinking"}
    assert emotions(events) == ["happy"]
    assert text(events) == "答案"


def test_think_tags_split_across_chunks():
    events = run(["<th", "ink>推理", "中…</th", "in", "k>[sad]", "呜呜"])
    assert [e for e in events if e["type"] == "thinking"] == [{"type": "thinking"}]
    assert emotions(events) == ["sad"]
    assert text(events) == "呜呜"


def test_unclosed_think_is_dropped():
    assert text(run(["<think>还没想完"])) == ""


def test_lone_less_than_is_kept():
    assert text(run(["1 <", " 2"])) == "1 < 2"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("<think>abc</think> 结果 ", "结果"),
        ("前面<think>没闭合", "前面"),
        ("推理过程</think>- 喜欢猫", "- 喜欢猫"),
        ("没有思考", "没有思考"),
    ],
)
def test_strip_think(raw, expected):
    assert strip_think(raw) == expected
