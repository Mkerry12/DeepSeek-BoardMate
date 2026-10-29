#!/usr/bin/env bash
# 下载作者共享的满穗 GPT-SoVITS 音色（私有仓库 Release，需协作者权限）：
# 校验 sha256 → 权重放进 GPT-SoVITS → 参考音频放进 server/data/voices/ → 写 server/data/voices.json →
# GPT-SoVITS 正在运行就直接切换权重。
#
#   gh auth login
#   bash scripts/fetch-voice.sh --gsv-dir ~/GPT-SoVITS
#   GSV_DIR=~/GPT-SoVITS bash scripts/fetch-voice.sh --yes
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GSV_DIR="${GSV_DIR:-}"
REPO="Mkerry12/DeepSeek-BoardMate-voice"
TAG="manhui-v1"
GSV_URL="http://127.0.0.1:9880"
DATA_DIR="$ROOT/server/data"
YES=0
PATCH_CONFIG=0

usage() {
  cat <<'EOF'
用法：bash scripts/fetch-voice.sh [选项]
  --gsv-dir DIR     GPT-SoVITS 根目录（里面有 api_v2.py、GPT_weights_v2、SoVITS_weights_v2）；也可用环境变量 GSV_DIR
  --repo OWNER/NAME 音色私有仓库（默认 Mkerry12/DeepSeek-BoardMate-voice）
  --tag TAG         Release 标签（默认 manhui-v1）
  --gsv-url URL     正在运行的 GPT-SoVITS 地址（默认 http://127.0.0.1:9880，在线就直接切换权重）
  --data-dir DIR    DeskMate 后端数据目录（默认 server/data）
  --patch-config    顺便把 GPT-SoVITS 的 tts_infer.yaml（custom 段）改成默认加载这套权重（会先备份）
  -y, --yes         不提问
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gsv-dir) GSV_DIR="${2:?}"; shift ;;
    --repo) REPO="${2:?}"; shift ;;
    --tag) TAG="${2:?}"; shift ;;
    --gsv-url) GSV_URL="${2:?}"; shift ;;
    --data-dir) DATA_DIR="${2:?}"; shift ;;
    --patch-config) PATCH_CONFIG=1 ;;
    -y | --yes) YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数：$1"; usage; exit 2 ;;
  esac
  shift
done

c_cyan=$'\033[36m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$c_cyan" "$1" "$c_off"; }
ok() { printf '    %s[ok]%s %s\n' "$c_green" "$c_off" "$1"; }
warn() { printf '    %s[!]%s %s\n' "$c_yellow" "$c_off" "$1"; }
fail() { printf '\n%s[x] %s%s\n' "$c_red" "$1" "$c_off"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

ask() {
  local answer
  if [[ $YES -eq 1 ]]; then printf '%s' "$2"; return; fi
  read -r -p "    $1${2:+ [$2]}: " answer </dev/tty || true
  printf '%s' "${answer:-$2}"
}

confirm() { # confirm "问题" [默认 1=是 / 0=否]
  local answer default="${2:-1}"
  [[ $YES -eq 1 ]] && return $((1 - default))
  if [[ $default -eq 1 ]]; then read -r -p "    $1 (Y/n): " answer </dev/tty || true
  else read -r -p "    $1 (y/N): " answer </dev/tty || true; fi
  [[ -z "$answer" ]] && return $((1 - default))
  [[ "$answer" =~ ^[Yy] ]]
}

sha256() {
  [[ -f "$1" ]] || return 0
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

url_alive() { # 任何 HTTP 响应（包括 GPT-SoVITS /control 的 400）都算活着
  local code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null || true)"
  [[ -n "$code" && "$code" != "000" ]]
}

NO_ACCESS="你还没有音色仓库的访问权限，请联系仓库作者邀请你成为协作者"

echo "下载满穗音色（GPT-SoVITS）"
has curl || fail "需要 curl"
PYTHON=""
for candidate in python3 python; do has "$candidate" && { PYTHON="$candidate"; break; }; done
[[ -n "$PYTHON" ]] || fail "需要 Python 3（用来读写 JSON）"

# ---------------------------------------------------------------- 1. gh 与访问权限
step "检查 gh 登录和 $REPO 的访问权限"
has gh || fail "没找到 GitHub CLI（gh）：https://cli.github.com/ 安装后运行 gh auth login，再重新运行本脚本"
gh auth status >/dev/null 2>&1 || fail "gh 还没登录：先运行 gh auth login（用被邀请的那个 GitHub 账号），再重新运行本脚本"
ok "gh 已登录"
if ! out="$(gh api "repos/$REPO" --jq .full_name 2>&1)"; then
  [[ "$out" =~ 404|Not\ Found|Could\ not\ resolve ]] &&
    fail "$NO_ACCESS（$REPO）"$'\n'"    已接受邀请？确认 gh 登录的是被邀请的账号：gh auth status"
  fail "访问 GitHub 失败（网络问题？稍后重试）："$'\n'"$out"
fi
if ! out="$(gh release view "$TAG" -R "$REPO" --json tagName 2>&1)"; then
  [[ "$out" =~ 404|Not\ Found|release\ not\ found ]] && fail "$REPO 里没有 Release $TAG（标签写错了？）"
  fail "读取 Release $TAG 失败："$'\n'"$out"
fi
ok "可以访问 $REPO（Release $TAG）"

# ---------------------------------------------------------------- 2. GPT-SoVITS 目录
step "GPT-SoVITS 目录"
if [[ -z "$GSV_DIR" ]]; then
  [[ $YES -eq 1 ]] && fail "没给 GPT-SoVITS 目录：加 --gsv-dir <路径> 或设置环境变量 GSV_DIR"
  GSV_DIR="$(ask "GPT-SoVITS 根目录（里面有 api_v2.py 和 GPT_SoVITS 文件夹）" "")"
fi
GSV_DIR="${GSV_DIR/#\~/$HOME}"
[[ -n "$GSV_DIR" && -d "$GSV_DIR" ]] || fail "GPT-SoVITS 目录不存在：$GSV_DIR"
GSV_DIR="$(cd "$GSV_DIR" && pwd)"
if [[ ! -d "$GSV_DIR/GPT_SoVITS" ]]; then
  warn "$GSV_DIR 里没有 GPT_SoVITS 文件夹，看起来不像 GPT-SoVITS 根目录"
  confirm "仍然放到这里吗？" 0 || fail "已取消"
fi
GPT_DIR="$GSV_DIR/GPT_weights_v2"
SOVITS_DIR="$GSV_DIR/SoVITS_weights_v2"
mkdir -p "$GPT_DIR" "$SOVITS_DIR" "$DATA_DIR/voices"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"
VOICE_DIR="$DATA_DIR/voices"
ok "$GSV_DIR"

# ---------------------------------------------------------------- 3. 下载并校验
step "下载 $TAG 并校验 sha256"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/deskmate-voice-XXXXXX")"
trap 'rm -f "$TMP"/* 2>/dev/null; rmdir "$TMP" 2>/dev/null || true' EXIT

get_asset() { # get_asset 文件名 → 下载到 $TMP（最多重试 3 次）
  local i out
  for i in 1 2 3; do
    if out="$(gh release download "$TAG" -R "$REPO" -p "$1" -D "$TMP" --clobber 2>&1)" && [[ -f "$TMP/$1" ]]; then return 0; fi
    [[ "$out" =~ 404|Not\ Found ]] && fail "$NO_ACCESS（下载 $1 时 404）"
    if [[ $i -lt 3 ]]; then warn "下载 $1 失败，20 秒后重试（$i/3）"; sleep 20; fi
  done
  fail "下载 $1 失败："$'\n'"$out"
}

get_asset voice-manifest.json
MANIFEST="$TMP/voice-manifest.json"
mf() { "$PYTHON" -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8"))
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$MANIFEST" "$1"; }
NAME="$(mf name)"
ok "清单：$NAME（GPT-SoVITS $(mf gsv_version)）"

install_asset() { # install_asset 清单键 目标目录
  local file sum size dest
  file="$(mf "$1.file")"; sum="$(mf "$1.sha256")"; size="$(mf "$1.size")"; dest="$2/$file"
  if [[ "$(sha256 "$dest")" == "$sum" ]]; then ok "$file 已存在且一致，跳过"; return; fi
  echo "    下载 $file（$((size / 1048576)) MB）..."
  get_asset "$file"
  local got
  got="$(sha256 "$TMP/$file")"
  [[ "$got" == "$sum" ]] || fail "$file 校验失败：期望 $sum，实际 $got（下载不完整？重新运行试试）"
  cp -f "$TMP/$file" "$dest"
  ok "$file → $dest"
}
install_asset gpt_weights "$GPT_DIR"
install_asset sovits_weights "$SOVITS_DIR"
install_asset ref_audio "$VOICE_DIR"
GPT_PATH="$GPT_DIR/$(mf gpt_weights.file)"
SOVITS_PATH="$SOVITS_DIR/$(mf sovits_weights.file)"
REF_PATH="$VOICE_DIR/$(mf ref_audio.file)"

# ---------------------------------------------------------------- 4. voices.json
step "DeskMate 音色预设（voices.json）"
VOICES_FILE="$DATA_DIR/voices.json"
CUR_DEFAULT=""
if [[ -f "$VOICES_FILE" ]]; then
  CUR_DEFAULT="$("$PYTHON" -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8-sig")); print(d.get("default") or "" if isinstance(d,dict) else "")' "$VOICES_FILE")" ||
    fail "$VOICES_FILE 不是合法 JSON，先修好或挪走再运行"
  cp -f "$VOICES_FILE" "$VOICES_FILE.bak"
  ok "旧文件备份为 voices.json.bak，其他音色会保留"
fi
SET_DEFAULT=1
if [[ -n "$CUR_DEFAULT" && "$CUR_DEFAULT" != "$NAME" ]]; then
  confirm "把「$NAME」设为默认音色吗？（当前默认：$CUR_DEFAULT）" 1 || SET_DEFAULT=0
fi
NEW_DEFAULT="$("$PYTHON" - "$MANIFEST" "$VOICES_FILE" "$REF_PATH" "$SET_DEFAULT" <<'PY'
import json, os, sys
manifest, voices_file, ref_path, set_default = sys.argv[1:5]
m = json.load(open(manifest, encoding="utf-8"))
data = {"default": None, "voices": []}
if os.path.isfile(voices_file):
    old = json.load(open(voices_file, encoding="utf-8-sig"))
    data = {"default": None, "voices": old} if isinstance(old, list) else {"default": old.get("default"), "voices": old.get("voices", [])}
data["voices"] = [v for v in data["voices"] if v.get("name") != m["name"]]
data["voices"].append({
    "name": m["name"],
    "label": m.get("label") or m["name"],
    "ref_audio_path": ref_path,
    "prompt_text": m["prompt_text"],
    "prompt_lang": m["prompt_lang"],
    "text_lang": m["text_lang"],
    "speed": m["speed_factor"],
    "text_split_method": m["text_split_method"],
})
if set_default == "1" or not data["default"]:
    data["default"] = m["name"]
with open(voices_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(data["default"])
PY
)"
ok "$VOICES_FILE（默认音色：$NEW_DEFAULT）"

# ---------------------------------------------------------------- 5. 切换 GPT-SoVITS 权重
step "GPT-SoVITS 权重"
urlenc() { "$PYTHON" -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
if url_alive "$GSV_URL/control"; then
  for pair in "set_gpt_weights|$GPT_PATH" "set_sovits_weights|$SOVITS_PATH"; do
    api="${pair%%|*}"; path="${pair#*|}"
    if curl -fsS -o /dev/null -m 180 "$GSV_URL/$api?weights_path=$(urlenc "$path")"; then ok "$api 成功"
    else warn "$api 失败（需要 api_v2.py；老的 api.py 不支持这个接口）"; fi
  done
  ok "GPT-SoVITS 重启后会回到配置文件里的默认权重"
else
  warn "连不上 $GSV_URL（GPT-SoVITS 没启动），没法在线切换权重"
fi

GPT_FILE="$(mf gpt_weights.file)"; SOVITS_FILE="$(mf sovits_weights.file)"; GSV_VER="$(mf gsv_version)"
CFG="$GSV_DIR/GPT_SoVITS/configs/tts_infer.yaml"
echo "    想让 GPT-SoVITS 启动就加载这套权重：把 GPT_SoVITS/configs/tts_infer.yaml 里 custom 段改成"
echo "      t2s_weights_path: GPT_weights_v2/$GPT_FILE"
echo "      vits_weights_path: SoVITS_weights_v2/$SOVITS_FILE"
echo "      version: $GSV_VER"
echo "    （或者启动后照上面在线切换：/set_gpt_weights 和 /set_sovits_weights 的 weights_path 参数）"
if [[ -f "$CFG" ]]; then
  if [[ $PATCH_CONFIG -eq 1 ]] || confirm "现在帮你改 tts_infer.yaml 吗？（会先备份）" 0; then
    BAK="$CFG.bak-$(date +%Y%m%d%H%M%S)"
    if "$PYTHON" - "$CFG" "$BAK" "GPT_weights_v2/$GPT_FILE" "SoVITS_weights_v2/$SOVITS_FILE" "$GSV_VER" <<'PY'
import re, shutil, sys
cfg, bak, t2s, vits, ver = sys.argv[1:6]
lines = open(cfg, encoding="utf-8").read().splitlines()
in_custom, hit = False, 0
for i, line in enumerate(lines):
    if re.match(r"\S", line):
        in_custom = re.match(r"custom:\s*$", line) is not None
        continue
    if not in_custom:
        continue
    for key, val in (("t2s_weights_path", t2s), ("vits_weights_path", vits), ("version", ver)):
        mt = re.match(r"(\s+)" + key + ":", line)
        if mt:
            lines[i] = f"{mt.group(1)}{key}: {val}"
            hit += key != "version"
if hit < 2:
    sys.exit(1)
shutil.copy2(cfg, bak)
open(cfg, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
    then ok "已改 tts_infer.yaml（备份：$BAK）；用 api_v2.py -c 指定了别的配置文件的话要改那个文件"
    else warn "tts_infer.yaml 的 custom 段里没找到 t2s_weights_path / vits_weights_path，没改，请手动改"; fi
  fi
fi

# ---------------------------------------------------------------- 6. 收尾
step "完成"
echo "    DeskMate 后端只在启动时读 voices.json：重启后端才会用上新音色"
echo "      （本机：停掉后端再 cd server && .venv/bin/python app.py，或重新运行 scripts/deploy.sh；Docker：docker compose restart server）"
echo "    音色仅限受邀协作者个人使用，禁止二次分发；对外发布合成内容请标注 AI 合成"
