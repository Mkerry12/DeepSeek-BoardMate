# syntax=docker/dockerfile:1
# 后端镜像。构建上下文是仓库根目录（要用到 shared/emotion-tags.json）：
#   docker build -f server/Dockerfile -t deskmate-server .
# 一般直接用仓库根目录的 compose.yaml：docker compose up -d --build

ARG PYTHON_VERSION=3.12

# --- 安装依赖（锁定版本）到独立的 venv ---
FROM python:${PYTHON_VERSION}-slim AS build
WORKDIR /src
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN --mount=type=bind,source=server/requirements.txt,target=requirements.txt \
    --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# --- 运行 ---
FROM python:${PYTHON_VERSION}-slim AS runtime
WORKDIR /app

RUN addgroup --system --gid 1001 deskmate && \
    adduser --system --uid 1001 --ingroup deskmate --no-create-home deskmate && \
    mkdir -p /app/data && chown 1001:1001 /app/data

COPY --link --from=build /opt/venv /opt/venv
COPY --link shared/emotion-tags.json /app/shared/emotion-tags.json
COPY --link server/app.py /app/app.py
COPY --link server/deskmate_server /app/deskmate_server

# 容器里监听所有网卡；令牌库放在 /app/data（compose 里挂成数据卷）
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    DB_PATH=/app/data/deskmate.db

USER 1001:1001
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)" || exit 1

LABEL org.opencontainers.image.source="https://github.com/Mkerry12/DeepSeek-BoardMate" \
      org.opencontainers.image.title="DeepSeek DeskMate server" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["python", "-m", "deskmate_server"]
