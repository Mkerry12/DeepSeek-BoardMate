#!/usr/bin/env bash
# DeepSeek DeskMate 一键部署（macOS / Linux）：检查环境 → 拉模型 → 装后端 → 生成令牌 → 可选配置 GPT-SoVITS → 构建客户端 → 启动。
#
#   bash scripts/deploy.sh                       # 交互式
#   bash scripts/deploy.sh --yes                 # 全自动，Edge 语音
#   bash scripts/deploy.sh --yes --docker --tts gpt_sovits \
#        --gsv-ref-audio /data/refs/voice.wav --gsv-prompt-text '参考音频里说的那句话'
#
# 客户端（桌宠）主要面向 Windows；在 macOS / Linux 上默认只部署后端，加 --client 才构建客户端。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/server"
CLIENT="$ROOT/client"
ENV_FILE="$SERVER/.env"

YES=0
TTS=""
DOCKER=0
MODEL=""
GSV_URL="http://127.0.0.1:9880"
GSV_REF_AUDIO=""
GSV_PROMPT_TEXT=""
GSV_PROMPT_LANG="zh"
SKIP_OLLAMA=0
BUILD_CLIENT=0
NO_START=0
START_CLIENT=0
SERVER_URL=""

usage() {
  cat <<'EOF'
用法：bash scripts/deploy.sh [选项]
  -y, --yes                不提问，全部用默认值 / 命令行参数
  --tts edge|gpt_sovits    语音合成方式（默认交互询问；--yes 时为 edge）
  --docker                 用 docker compose 运行后端，而不是本机 Python venv
  --model NAME             Ollama 模型（默认取 server/.env 的 OLLAMA_MODEL，即 deepseek-r1:8b）
  --gsv-url URL            GPT-SoVITS 地址（默认 http://127.0.0.1:9880）
  --gsv-ref-audio PATH     参考音频（GPT-SoVITS 那台机器上的 3~10 秒 wav）
  --gsv-prompt-text TEXT   参考音频里说的那句话
  --gsv-prompt-lang LANG   参考音频语言（默认 zh）
  --skip-ollama            跳过 Ollama 检查和拉模型
  --client                 同时构建客户端（需要 Node.js 20+）
  --start-client           构建完启动客户端（隐含 --client）
  --server-url URL         构建进客户端的默认服务器地址（默认本机后端）
  --no-start               部署完不启动后端
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y | --yes) YES=1 ;;
    --tts) TTS="${2:?}"; shift ;;
    --docker) DOCKER=1 ;;
    --model) MODEL="${2:?}"; shift ;;
    --gsv-url) GSV_URL="${2:?}"; shift ;;
    --gsv-ref-audio) GSV_REF_AUDIO="${2:?}"; shift ;;
    --gsv-prompt-text) GSV_PROMPT_TEXT="${2:?}"; shift ;;
    --gsv-prompt-lang) GSV_PROMPT_LANG="${2:?}"; shift ;;
    --skip-ollama) SKIP_OLLAMA=1 ;;
    --client) BUILD_CLIENT=1 ;;
    --start-client) BUILD_CLIENT=1; START_CLIENT=1 ;;
    --server-url) SERVER_URL="${2:?}"; shift ;;
    --no-start) NO_START=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数：$1"; usage; exit 2 ;;
  esac
  shift
done

case "$TTS" in "" | edge | gpt_sovits) ;; *) echo "--tts 只能是 edge 或 gpt_sovits"; exit 2 ;; esac

c_cyan=$'\033[36m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$c_cyan" "$1" "$c_off"; }
ok() { printf '    %s[ok]%s %s\n' "$c_green" "$c_off" "$1"; }
warn() { printf '    %s[!]%s %s\n' "$c_yellow" "$c_off" "$1"; }
fail() { printf '\n%s[x] %s%s\n' "$c_red" "$1" "$c_off"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

ask() { # ask "问题" "默认值" → 输出答案
  local answer
  if [[ $YES -eq 1 ]]; then printf '%s' "$2"; return; fi
  read -r -p "    $1${2:+ [$2]}: " answer </dev/tty || true
  printf '%s' "${answer:-$2}"
}

confirm() { # confirm "问题" → 默认是
  local answer
  [[ $YES -eq 1 ]] && return 0
  read -r -p "    $1 (Y/n): " answer </dev/tty || true
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

get_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

set_env() { # 改 / 追加 server/.env 里的一项（不依赖 GNU sed -i，macOS 也能用）
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]]; then
    KEY="$key" VALUE="$value" awk '
      BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' "$ENV_FILE" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

url_alive() { # 任何 HTTP 响应（包括 GPT-SoVITS /control 的 400）都算活着
  local code
  code="$(curl -s -o /dev/null -m "${2:-3}" -w '%{http_code}' "$1" 2>/dev/null || true)"
  [[ -n "$code" && "$code" != "000" ]]
}

wait_health() {
  local i
  for ((i = 0; i < ${2:-60}; i++)); do
    if curl -fsS -m 3 "$1" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

echo "DeepSeek DeskMate 一键部署"
echo "仓库：$ROOT"
has curl || fail "需要 curl"

# ---------------------------------------------------------------- 1. 环境检查
step "检查环境"
PYTHON=""
if [[ $DOCKER -eq 0 ]]; then
  for candidate in python3 python; do
    if has "$candidate" && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      PYTHON="$candidate"
      break
    fi
  done
  [[ -n "$PYTHON" ]] || fail "需要 Python 3.10 或以上（以及 venv 模块，Debian/Ubuntu：apt install python3-venv），或加 --docker 用容器运行后端"
  ok "Python：$("$PYTHON" --version 2>&1)"
else
  has docker || fail "用了 --docker，但没找到 docker"
  docker compose version >/dev/null 2>&1 || fail "docker compose 不可用，请安装 Docker Compose v2"
  ok "Docker 和 docker compose"
fi

if [[ $BUILD_CLIENT -eq 1 ]]; then
  if ! has node; then
    warn "没找到 Node.js（需要 20 以上）—— 跳过客户端"
    BUILD_CLIENT=0
  elif [[ "$(node --version | sed 's/^v//' | cut -d. -f1)" -lt 20 ]]; then
    warn "Node.js 版本太旧（$(node --version)），需要 20 以上 —— 跳过客户端"
    BUILD_CLIENT=0
  else
    ok "Node.js $(node --version)"
  fi
fi

# ---------------------------------------------------------------- 2. server/.env
step "准备 server/.env"
NEW_ENV=0
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SERVER/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # 示例里的 change-me-123 不能留；令牌改用令牌库（下面生成）
  set_env ACCESS_TOKENS ""
  NEW_ENV=1
  ok "已从 .env.example 创建 server/.env"
else
  ok "server/.env 已存在，保留原有配置"
  [[ "$(get_env ACCESS_TOKENS)" == *change-me* ]] && warn "ACCESS_TOKENS 还是示例值 change-me-123，建议清空并用令牌库"
fi
[[ -n "$MODEL" ]] && set_env OLLAMA_MODEL "$MODEL"
MODEL="$(get_env OLLAMA_MODEL)"
MODEL="${MODEL:-deepseek-r1:8b}"

# ---------------------------------------------------------------- 3. Ollama
if [[ $SKIP_OLLAMA -eq 0 ]]; then
  step "Ollama 与模型 $MODEL"
  if ! has ollama; then
    warn "没找到 Ollama：请从 https://ollama.com/download 安装后重新运行（或加 --skip-ollama 跳过）"
  else
    if ! url_alive "http://127.0.0.1:11434/api/tags"; then
      warn "Ollama 没在运行，尝试后台启动 ollama serve"
      nohup ollama serve >/dev/null 2>&1 &
      sleep 3
    fi
    if ollama list 2>/dev/null | grep -qF "$MODEL"; then
      ok "模型 $MODEL 已存在"
    else
      echo "    拉取 $MODEL（几个 GB，第一次会比较久）..."
      if ollama pull "$MODEL"; then ok "已拉取 $MODEL"; else warn "ollama pull $MODEL 失败，稍后可以手动重试"; fi
    fi
    [[ $DOCKER -eq 1 && "$(uname -s)" == "Linux" ]] &&
      warn "Linux 上容器要连宿主机的 Ollama，需让 Ollama 监听 0.0.0.0（OLLAMA_HOST=0.0.0.0）后重启它"
  fi
fi

# ---------------------------------------------------------------- 4. 语音合成
step "语音合成"
if [[ -z "$TTS" ]]; then
  current="$(get_env TTS_PROVIDER)"
  if [[ $YES -eq 1 || ( -n "$current" && $NEW_ENV -eq 0 ) ]]; then
    TTS="${current:-edge}"
  else
    echo "    edge       = 微软 Edge 在线语音（默认，不占显卡）"
    echo "    gpt_sovits = 本机 GPT-SoVITS 自定义音色（需要先装好并启动，见 doc/gpt-sovits.md）"
    TTS="$(ask "选择语音合成方式 edge / gpt_sovits" edge)"
  fi
fi
if [[ "$TTS" == "gpt_sovits" ]]; then
  GSV_URL="$(ask "GPT-SoVITS 地址" "$GSV_URL")"
  [[ -z "$GSV_REF_AUDIO" ]] && GSV_REF_AUDIO="$(ask "参考音频路径（已有 server/data/voices.json 可留空）" "$(get_env GSV_REF_AUDIO)")"
  [[ -n "$GSV_REF_AUDIO" && -z "$GSV_PROMPT_TEXT" ]] && GSV_PROMPT_TEXT="$(ask "参考音频里说的那句话（强烈建议填）" "$(get_env GSV_PROMPT_TEXT)")"
  [[ -n "$GSV_REF_AUDIO" ]] && GSV_PROMPT_LANG="$(ask "参考音频语言 zh/en/ja/ko/yue" "$GSV_PROMPT_LANG")"
  set_env TTS_PROVIDER gpt_sovits
  set_env TTS_FALLBACK edge
  set_env GSV_URL "$GSV_URL"
  if [[ -n "$GSV_REF_AUDIO" ]]; then
    set_env GSV_REF_AUDIO "$GSV_REF_AUDIO"
    set_env GSV_PROMPT_TEXT "$GSV_PROMPT_TEXT"
    set_env GSV_PROMPT_LANG "$GSV_PROMPT_LANG"
  elif [[ ! -f "$SERVER/data/voices.json" ]]; then
    warn "既没填参考音频，也没有 server/data/voices.json：GPT-SoVITS 没有可用音色，会一直用 Edge 兜底"
    warn "照 server/voices.example.json 写一份 server/data/voices.json 后重启后端即可"
  fi
  if url_alive "$GSV_URL/control"; then ok "GPT-SoVITS 在线：$GSV_URL"; else
    warn "连不上 $GSV_URL（还没启动？）。后端照样能用，GPT-SoVITS 起来之前用 Edge 语音兜底"
  fi
  if [[ $DOCKER -eq 1 ]]; then
    if [[ "$GSV_URL" =~ 127\.0\.0\.1|localhost ]]; then
      ok "容器里会自动改用 http://host.docker.internal:9880 访问宿主机上的 GPT-SoVITS"
      [[ "$(uname -s)" == "Linux" ]] && warn "Linux 上 GPT-SoVITS 需要用 -a 0.0.0.0 启动，容器才连得上"
    else
      export DESKMATE_GSV_URL="$GSV_URL"
    fi
  fi
else
  set_env TTS_PROVIDER edge
  ok "使用 Edge 语音"
fi

PORT="$(get_env PORT)"
HEALTH_URL="http://127.0.0.1:${PORT:-8000}/health"

# ---------------------------------------------------------------- 5. 后端
if [[ $DOCKER -eq 0 ]]; then
  step "安装后端依赖（server/.venv）"
  VENV_PY="$SERVER/.venv/bin/python"
  [[ -x "$VENV_PY" ]] || "$PYTHON" -m venv "$SERVER/.venv" || fail "创建虚拟环境失败"
  "$VENV_PY" -m pip install --disable-pip-version-check -q -r "$SERVER/requirements.txt" ||
    fail "pip install 失败（国内网络可以先 export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple 再重试）"
  ok "依赖已安装（锁定版本）"

  if [[ $NEW_ENV -eq 1 ]]; then
    step "生成访问令牌"
    (cd "$SERVER" && "$VENV_PY" -m deskmate_server.tokens add 主人)
    warn "上面的令牌只显示这一次：桌宠右键「设置」→ 官方服务器 →「访问令牌」里填它。给朋友再发：tokens add <名字>"
  fi

  if [[ $NO_START -eq 0 ]]; then
    step "启动后端"
    if pgrep -f "deskmate_server|app.py" >/dev/null 2>&1; then
      warn "后端已经在运行，先停掉旧进程再用新配置启动"
      pkill -f "$SERVER/.venv/bin/python app.py" 2>/dev/null || true
      sleep 1
    fi
    (cd "$SERVER" && nohup "$VENV_PY" app.py >"$SERVER/server.log" 2>&1 &)
    ok "日志：server/server.log"
  fi
else
  HEALTH_URL="http://127.0.0.1:${DESKMATE_PORT:-8000}/health"
  step "构建并启动后端容器（docker compose）"
  (cd "$ROOT" && docker compose up -d --build) || fail "docker compose up 失败"
  if [[ $NEW_ENV -eq 1 ]]; then
    if wait_health "$HEALTH_URL" 60 >/dev/null; then
      step "生成访问令牌"
      (cd "$ROOT" && docker compose exec server python -m deskmate_server.tokens add 主人)
      warn "上面的令牌只显示这一次：桌宠右键「设置」→ 官方服务器 →「访问令牌」里填它"
    else
      warn "后端还没就绪，稍后手动运行：docker compose exec server python -m deskmate_server.tokens add 主人"
    fi
  fi
fi

if [[ $DOCKER -eq 1 || $NO_START -eq 0 ]]; then
  if body="$(wait_health "$HEALTH_URL" 30)"; then
    ok "后端已启动：$HEALTH_URL"
    echo "    $body"
  else
    warn "后端 30 秒内没响应，看看 server/server.log（或 docker compose logs server）"
  fi
fi

# ---------------------------------------------------------------- 6. 客户端
if [[ $BUILD_CLIENT -eq 1 ]]; then
  step "构建客户端（client/）"
  cd "$CLIENT"
  if [[ ! -f vendor/live2dcubismcore.min.js ]]; then
    mkdir -p vendor
    echo "    下载 Live2D Cubism Core（Live2D Inc. 专有运行时，不随仓库分发）"
    curl -fsSL -o vendor/live2dcubismcore.min.js https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
  fi
  ok "Cubism Core 就绪"
  npm install --no-audit --no-fund || fail "npm install 失败（国内网络可以先 npm config set registry https://registry.npmmirror.com）"
  node node_modules/electron/install.js || warn "Electron 二进制下载失败，可以 export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 后重试"
  DESKMATE_SERVER_URL="${SERVER_URL:-${DESKMATE_SERVER_URL:-${HEALTH_URL%/health}}}"
  export DESKMATE_SERVER_URL
  npm run build || fail "客户端构建失败"
  ok "客户端已构建到 client/out（默认服务器 $DESKMATE_SERVER_URL）"
  if [[ $START_CLIENT -eq 1 ]] || { [[ $YES -eq 0 ]] && confirm "现在启动桌宠吗？"; }; then
    nohup npm start >/dev/null 2>&1 &
    ok "桌宠启动中：右键「设置」→ 官方服务器，填上面的令牌，点「测试连接」"
  fi
fi

step "完成"
echo "    后端：  server/（配置 server/.env，令牌：python -m deskmate_server.tokens list）"
echo "    语音：  doc/gpt-sovits.md   给朋友用：README「花生壳内网穿透」"
echo "    文档：  doc/产品设计文档.md  doc/架构文档.md"
