# DeepSeek DeskMate — Live2D AI 桌宠


<img width="607" height="400" alt="d12ce4bbb9bf125e9bfeba143f529405" src="https://github.com/user-attachments/assets/703f8443-7d1d-43a6-800d-f2bc9af6dbb8" />


[![CI](https://github.com/Mkerry12/DeepSeek-BoardMate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Mkerry12/DeepSeek-BoardMate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![Model: CC BY-NC-SA 4.0](https://img.shields.io/badge/Live2D%20model-CC%20BY--NC--SA%204.0-lightgrey.svg)](client/assets/live2d/ds-whale-girl/LICENSE)


```
朋友的 exe ──HTTPS──> 花生壳域名 ──> server (FastAPI :8000) ──> Ollama 127.0.0.1:11434
```

- `client/`：Electron + pixi.js + Live2D，透明置顶窗口，动作、表情、口型、对话气泡
- `server/`：令牌鉴权、限流、人设、过滤 `<think>`、解析情绪标签，SSE 流式返回

## 1. 启动后端（在你自己的电脑上）

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env      # 修改 ACCESS_TOKENS、OLLAMA_MODEL
.\.venv\Scripts\python app.py   # 或 .\.venv\Scripts\python -m deskmate_server，两者等价
```

浏览器打开 http://127.0.0.1:8000/health 应看到 `"ollama": true`。

- 代码在 `server/deskmate_server/` 包里，`app.py` 只是兼容入口，原来的启动方式不变。
- `.env` 启动时会校验（数字项填错、端口越界等会直接报出是哪一项）。
- 控制台每个请求一行日志：`request_id`、路径、状态码、耗时（ms）、令牌**标签**（如 `token-1`，从不打印令牌本身）；
  `.env` 里 `LOG_FORMAT=json` 可改成 JSON 行。响应头带 `X-Request-ID`，排查问题时让朋友报这个 id 即可。
- 拉新代码后先 `.\.venv\Scripts\pip install -r requirements.txt` 再重启（依赖版本已锁定，见 CONTRIBUTING）。

### 管理朋友的令牌

令牌存在 `server/data/deskmate.db`（SQLite，已被 git 忽略），**只存哈希，不存明文**；每个令牌有标签（朋友的名字），
记录最后使用时间、每天的请求数。限流按令牌分别计算。以下命令都在 `server/` 目录下运行，**不用重启后端，立即生效**：

```powershell
cd server
.\.venv\Scripts\python -m deskmate_server.tokens add 小明      # 给小明发一个新令牌（只显示这一次，复制给他）
.\.venv\Scripts\python -m deskmate_server.tokens list          # 看所有令牌：创建时间、最后使用、今日 / 累计请求、是否撤销
.\.venv\Scripts\python -m deskmate_server.tokens revoke 小明   # 撤销（也可以用 list 里的 id）
.\.venv\Scripts\python -m deskmate_server.tokens rename 3 小红 # 改标签
```

朋友在桌宠右键「设置」→ 官方服务器 →「访问令牌」里填入令牌即可。

**从 `.env` 的 `ACCESS_TOKENS` 迁移**（旧令牌一直有效，已经发出去的不用换）：

1. 运行 `.\.venv\Scripts\python -m deskmate_server.tokens import-env`，把 `ACCESS_TOKENS` 里的令牌按顺序导入为 `token-1`、`token-2`……
   （已导入的会跳过，可重复运行；不会打印令牌内容）
2. 用 `rename token-1 小明` 改成朋友的名字，之后 `list` 里就能看到每个人的用量。
3. 确认都导入后，可以把 `.env` 里的 `ACCESS_TOKENS` 清空（不清也行：先查令牌库，再查 `.env`；
   **在令牌库里撤销的令牌，即使还写在 `.env` 里也会被拒绝**）。

可选的管理接口：在 `.env` 设置 `ADMIN_TOKEN=<很长的随机串>` 后启用 `GET /admin/tokens`、`POST /admin/tokens {"label": "小明"}`、
`POST /admin/tokens/<标签或id>/revoke`（`Authorization: Bearer <ADMIN_TOKEN>`）。不设置时这些接口不存在（404）。
因为后端经内网穿透暴露在公网，**不需要的话就别开**，命令行就够用了。

### 用 Docker 运行后端（可选）

不想在本机装 Python 时可以用 Docker（需要 Docker Desktop）。在**仓库根目录**运行，配置仍然读 `server/.env`：

```powershell
copy server\.env.example server\.env   # 已有 .env 就跳过
docker compose up -d --build           # 构建并后台启动，监听 127.0.0.1:8000
docker compose logs -f server          # 看日志
docker compose exec server python -m deskmate_server.tokens list   # 令牌命令照常用，在容器里执行
docker compose down                    # 停止（令牌库在数据卷 deskmate-data 里，不会丢）
```

- 默认连接**宿主机**上的 Ollama（`http://host.docker.internal:11434`）。Linux 上 Ollama 默认只听 `127.0.0.1`，
  需要设置环境变量 `OLLAMA_HOST=0.0.0.0` 后重启 Ollama，容器才能连上。
- 想把 Ollama 也放进容器：`$env:DESKMATE_OLLAMA_URL="http://ollama:11434"; docker compose --profile ollama up -d`，
  再 `docker compose exec ollama ollama pull deepseek-r1:8b` 拉模型（有 NVIDIA 显卡时取消 compose.yaml 里 GPU 那段注释）。
- 换端口：`$env:DESKMATE_PORT="18000"`。端口只绑定本机回环地址，对外仍然通过内网穿透转发。
- 镜像以非 root 用户运行，带健康检查；`docker compose ps` 能看到 healthy。

## 2. 花生壳内网穿透

1. 安装花生壳客户端并登录，添加映射：
   - 映射类型：HTTPS（或 HTTP）
   - 内网主机：`127.0.0.1`，内网端口：`8000`
2. 得到外网地址，例如 `https://xxxx.vicp.fun`，发给朋友，再用上面的 `tokens add` 给每人发一个令牌。

注意：只映射 8000 端口，**不要映射 Ollama 的 11434**（它没有任何鉴权）。

## 3. 运行 / 打包客户端

```powershell
cd client
npm install
node node_modules/electron/install.js   # 如果 electron 二进制没下载下来
npm run dev        # 开发运行（Vite 热更新）
npm run build; npm start   # 构建到 client/out 并运行构建产物
npm run dist       # 构建 + 打包成 exe，输出在 client/dist（便携版 + 安装包）
```

- 角色是 Live2D「DS鲸鱼娘」（`client/assets/live2d/ds-whale-girl/`）
  - 来源：[A8Chann/dsh-pet-live2d](https://github.com/A8Chann/dsh-pet-live2d)，协议 **CC BY-NC-SA 4.0**（署名、非商用、相同方式共享）
  - 版权：上善无形（角色原作「溟月」）、ZipZipPipe（DeepSeek 女仆二设）、氵六青（Live2D 模型）
  - 需要 Live2D 官方运行时：把 `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` 下载到 `client/vendor/`
- 操作：左键拖动、单击互动、双击聊天、右键菜单、Esc 关闭输入框/菜单；托盘图标可显示/隐藏、开机自启、退出
- 首次使用：右键 → 设置，选择连接方式，点「测试连接」

### 连接方式

- **官方服务器**（默认）：连主人电脑上的 server（Ollama），只需填令牌；「高级」里可改服务器地址。
  默认地址写在 `client/src/main/settings.ts` 的 `OFFICIAL_SERVER_URL`，**打包发给朋友前改成花生壳域名**。
  可在设置里选服务器上的模型（`GET /models`，自动排除 bge-m3 等嵌入模型）和自定义人设。
- **自己的 API Key**：客户端直连 OpenAI 兼容接口，不经过服务器。预设 DeepSeek 官方
  （`deepseek-chat` / `deepseek-reasoner`），或选「自定义」填接口地址 + 模型名（OpenAI、硅基流动、通义等）。
  Key 用系统 DPAPI 加密保存在 `%APPDATA%\deepseek-deskmate\settings.json`。

### 小功能

- **桌上道具**：纸上的三个图标可以点 —— 撤回（删掉上一轮对话）、画笔（打开输入框）、橡皮（连点两下清空对话）。
  思考时画笔亮、回复完橡皮亮、按停止时撤回亮。
- **记忆**：聊天记录存到 `%APPDATA%\deepseek-deskmate\history.json`（最多 200 条），每次只把最近 20 条发给模型；右键「清空记忆」只擦聊天记录。
- **长期记忆（她记得的事）**：每新聊 40 条，后台让模型把「关于你的事」（称呼、喜好、在忙的事、约定）整理成 ≤500 字的笔记，
  存在 `memory.json`，之后每次聊天都附在系统提示词后面（官方模式发 `memory` 字段给服务器，API Key 模式在客户端拼）。
  右键「她记得的事」→ 查看 / 现在整理一下 / 忘掉这些。和「清空记忆」互不影响。
- **摸摸她**：单击头 = 摸头（爱心眼 + 心跳），按住在头上小范围来回蹭也是摸头（拖出约 36px 才变成拖窗口）；
  戳脸会脸红；点头顶（或桌上）的小鲸鱼会喷水；3 秒内连戳 5 下先晕晕再抡锤子；拖着窗口左右猛晃她会晕。其他部位单击是随机反应，双击聊天。
- **边聊边记**：回答时她拿笔在小本本上写；回复超过 150 字会把小鲸鱼放到桌上，说完放回头顶；回答失败或没话说会吐魂。
- **今日运势**：右键「今日运势」，掏出手机翻开看一眼，同一天结果固定。
- **语音朗读**（默认关）：右键「语音朗读」或设置里「朗读回复」开关，可选音色。用微软 Edge 神经网络语音：
  官方模式走服务器 `POST /tts`，API Key 模式（或服务器不可用时）由客户端主进程直连；都失败才退回 Windows 自带语音。
  边输出边一句句地读，口型跟着音量动；按停止 / Esc / 发新消息 / 关掉开关会立刻停。「提示音」开关控制完成、失败、提醒的小音效（来自 `pet.json` 的 sounds）。
  设置里的「音量」滑块（默认 80%）同时管朗读和提示音，拖动时正在读的语音立刻跟着变，松手会响一声试听；调小声口型照样动。
- **按时段打招呼**：早上 8–10 点、午饭 11:45–13 点、晚饭 17:45–19:30、深夜 23:30–5 点各打一次招呼（每天每个时段一次），聊天时会等一等。
- **闲置小动作**：一段时间不理她会自拍、吹泡泡、挤番茄酱、吃巴菲，5 分钟没动静会打瞌睡，碰一下就醒。
- **小助手**：喝水 / 久坐提醒（设置里开关和间隔）、右键「番茄钟」25 + 5 分钟、「看看剪贴板」让她解释复制的文字。
- **换装**：右键「换装」选眼镜、贴纸、发饰、手势、魔爪、桌布等，同一槽位互斥，重启后保留。

## 情绪与动作

后端提示词要求模型在回复开头输出 `[happy]` 等标签，客户端据此叠加 Live2D 表情、播放动作
（映射在角色目录 `client/assets/live2d/ds-whale-girl/deskmate.json` 的 `live2d.emotions`）。可用标签（唯一来源 `shared/emotion-tags.json`）：
`happy sad angry surprised relaxed thinking wave neutral`，以及
`shy`（爱心眼 + 冒爱心 + 心跳 + 脸红）、`love`、`cry`（大哭）、`confused`（呆呆眼 + 问号）、`dizzy`（晕晕）、
`speechless`（阴暗 + 吐魂）、`proud`、`sleepy`（闭眼口水）。
默认人设在 `server/deskmate_server/persona.py` 的 `DEFAULT_PERSONA`（API Key 模式用 `client/src/renderer/lib/persona.ts` 里的同一份，测试会检查两边一致），
情绪标签规则在 `REPLY_RULES`；用户在设置里填的人设只替换人设部分。改标签只需改 `shared/emotion-tags.json`，客户端和服务器都直接读取它。

服务器的朗读接口需要能访问外网（微软语音服务），相关配置见 `server/.env.example` 里的 `TTS_*`；
已有的 `server/.venv` 每次拉取新代码后记得重新 `pip install -r requirements.txt`（依赖版本已锁定）。

## 参与开发

欢迎一起开发！环境搭建、分支与提交规范、PR 流程、如何跑 lint / 测试、项目结构和「新增情绪 / 功能改哪里」都在 [CONTRIBUTING.md](CONTRIBUTING.md)。

```powershell
cd client; npm run typecheck; npm run lint; npm run format:check; npm test   # 客户端
cd server; .\.venv\Scripts\ruff check .; .\.venv\Scripts\python -m pytest   # 后端（先装 requirements-dev.txt）
```

每个 PR 会自动跑 CI（类型检查、lint、格式、单元测试、构建、gitleaks 密钥扫描），合并前需要 CI 通过并有 1 人 review。

## 许可

- 代码：[MIT](LICENSE)。
- Live2D 模型「DS鲸鱼娘」（`client/assets/live2d/ds-whale-girl/`）**不适用 MIT**，仍为 **CC BY-NC-SA 4.0**（署名、非商用、相同方式共享），版权归 上善无形 / ZipZipPipe / 氵六青，详见该目录下的 LICENSE 与 README。
  因此包含该模型的打包程序（exe）整体不能用于商业用途。
- Live2D Cubism Core 为 Live2D Inc. 专有软件，不随本仓库分发，请按上文自行下载到 `client/vendor/`。
