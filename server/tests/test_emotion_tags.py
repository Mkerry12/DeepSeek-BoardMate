import json
import re
from pathlib import Path

from deskmate_server import persona, stream_filter

SHARED = Path(__file__).resolve().parents[2] / "shared" / "emotion-tags.json"


def shared_tags() -> list[str]:
    return json.loads(SHARED.read_text(encoding="utf-8"))["tags"]


def test_stream_filter_accepts_exactly_the_shared_tags():
    assert stream_filter.EMOTIONS == set(shared_tags())


def test_reply_rules_list_the_shared_tags_in_order():
    line = next(line for line in persona.REPLY_RULES.splitlines() if "只能是以下之一" in line)
    assert re.findall(r"\[([a-z_]+)\]", line) == shared_tags()


def test_tags_file_override(monkeypatch, tmp_path):
    custom = tmp_path / "tags.json"
    custom.write_text(json.dumps({"tags": ["happy", "sad"]}), encoding="utf-8")
    monkeypatch.setenv("EMOTION_TAGS_FILE", str(custom))
    assert persona._load_tags() == ["happy", "sad"]
