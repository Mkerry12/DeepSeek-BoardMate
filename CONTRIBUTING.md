# 参与开发

欢迎一起来养小鲸！这份文档说明怎么搭开发环境、怎么提交代码，以及项目的大致结构。

## 1. 开发环境

需要：

- Windows 10/11（客户端是 Windows 桌宠；lint / 测试在 macOS、Linux 上也能跑）
- [Node.js](https://nodejs.org/) 24（与 CI 一致，22 以上一般也行）
- Python 3.10
- Git，以及可选的 [Ollama](https://ollama.com/)（只在本机跑后端联调时需要）

### 客户端（`client/`）

```powershell
cd client
npm install
node node_modules/electron/install.js   # 如果 electron 二进制没下载下来
```

Live2D 官方运行时（Cubism Core）是专有软件，不在仓库里，需要自己下载：

```powershell
New-Item -ItemType Directory -Force vendor | Out-Null
Invoke-WebRequest https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js -OutFile vendor/live2dcubismcore.min.js
```

然后 `npm start` 就能看到小鲸。

### 后端（`server/`）

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt
copy .env.example .env      # 按需修改 ACCESS_TOKENS、OLLAMA_MODEL 等
.\.venv\Scripts\python app.py
```

> `.env` 里是令牌等机密，已被 `.gitignore` 忽略，**永远不要提交**。新增配置项时请同步更新 `.env.example`。

## 2. 检查与测试

提交前请在本地跑一遍（CI 会跑同样的命令）：

```powershell
# 客户端
cd client
npm run lint          # ESLint
npm run format:check  # Prettier 检查（npm run format 自动格式化）
npm test              # Vitest 单元测试

# 后端
cd server
.\.venv\Scripts\ruff check .
.\.venv\Scripts\ruff format --check .   # 去掉 --check 自动格式化
.\.venv\Scripts\python -m pytest
```

- 客户端测试在 `client/test/`，覆盖纯逻辑模块（流式过滤、人设拼接、SSE 解析、记忆、触摸、运势、问候时段）。
  涉及 DOM / Electron 的模块尽量把纯逻辑拆成导出的函数再测。
- 后端测试在 `server/tests/`，用 FastAPI `TestClient` + `respx` 模拟 Ollama、用假的 `edge_tts` 代替联网，**不依赖本机 `.env`**。
- 代码风格：JS 单引号、分号、2 空格、行宽 120（`.prettierrc`）；Python 行宽 110（`server/pyproject.toml`）。编辑器请启用 EditorConfig。

### 可选：pre-commit 钩子

```powershell
pip install pre-commit
pre-commit install
```

之后每次 `git commit` 会自动对改动的文件跑 ruff、prettier 和 gitleaks（密钥扫描）。不装也没关系，CI 会兜底。

## 3. 分支与提交

- 不要直接推 `main`，从最新的 `main` 拉分支：
  - `feat/xxx` 新功能，`fix/xxx` 修 bug，`chore/xxx` 工程/依赖/杂项，`docs/xxx` 文档
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

  ```
  feat(client): 新增摸尾巴互动
  fix(server): /tts 音色校验漏掉了地区变体
  chore(deps): 升级 pixi.js
  ```

  常用类型：`feat` `fix` `docs` `style` `refactor` `test` `chore` `ci`；范围用 `client` / `server`。

## 4. Pull Request 流程

1. 推送分支后开 PR 到 `main`，按模板填写改了什么、怎么测的；界面改动附截图或 GIF。
2. **CI 必须全绿**：client（lint + format + test）、server（ruff + pytest）、gitleaks 密钥扫描。
   需要验证 Windows 打包时给 PR 加 `build` 标签，会额外跑 `build (windows portable)` 并上传 exe。
3. **至少 1 人 review 通过**后再合并，推荐 Squash merge。
4. 不要改无关文件；大改动先开 issue 讨论。

## 5. 项目结构

```
client/                     Electron 客户端
  src/main/main.js          主进程：透明置顶窗口、托盘、设置/历史/记忆读写、DPAPI 加密、Edge 语音
  src/main/preload.js       暴露给渲染进程的 window.desk API
  src/renderer/
    app.js                  入口：组装各模块、鼠标交互、对话气泡、设置面板逻辑
    live2d.js               Live2D 角色：表情、动作、口型、换装、点击区域（DEFAULT_PROFILE）
    chat.js                 连接服务器 / OpenAI 兼容接口，SSE 解析
    stream-filter.js        去掉 <think>、解析 [emotion] 标签（与 server/stream_filter.py 对应）
    persona.js              默认人设与系统提示词（与 server/app.py 对应）
    memory.js               长期记忆   voice.js 语音朗读   touch.js 触摸互动
    greetings.js            按时段问候 idle.js 闲置动作    fortune.js 今日运势
    assistant.js            喝水/久坐提醒、番茄钟          menu.js 右键菜单
    index.html / style.css  页面结构（含设置面板）与样式
  test/                     Vitest 单元测试
  assets/live2d/            Live2D 模型（CC BY-NC-SA 4.0）
server/
  app.py                    FastAPI：鉴权、限流、/chat /memory /models /tts /health
  stream_filter.py          流式过滤
  tests/                    pytest
```

## 6. 常见改动指南

- **新增情绪标签**：要同时改
  1. `server/stream_filter.py` 和 `client/src/renderer/stream-filter.js` 的 `EMOTIONS`
  2. `server/app.py` 和 `client/src/renderer/persona.js` 的 `REPLY_RULES`（两份提示词保持一致）
  3. `client/src/renderer/live2d.js` 的 `DEFAULT_PROFILE`，把标签映射到表情 / 动作
  4. 两边的测试里补一个用例
- **新增触摸 / 闲置 / 问候等小互动**：在对应模块（`touch.js`、`idle.js`、`greetings.js`）里加，
  通过 `pet.react / pet.motion / pet.setLayer / say` 驱动角色，再在 `app.js` 里接线。可测试的判断逻辑请导出并写测试。
- **新增后端接口**：在 `server/app.py` 里用 `Depends(require_token)` 加鉴权和限流，Pydantic 模型限制输入长度，并在 `server/tests/` 加测试。
- **新增配置项**：后端加到 `.env.example`；客户端设置项的默认值在 `main.js` 的 `defaultSettings`，设置面板在 `index.html` + `app.js`。

## 7. 许可

- 代码：[MIT](LICENSE)。
- Live2D 模型「DS鲸鱼娘」（`client/assets/live2d/ds-whale-girl/`）**不适用 MIT**，仍是 **CC BY-NC-SA 4.0**（署名、非商用、相同方式共享），
  版权归 上善无形 / ZipZipPipe / 氵六青。
- Live2D Cubism Core 是 Live2D Inc. 的专有软件，不包含在仓库中，请按上文自行下载。

提交代码即表示你同意以 MIT 协议授权你的贡献。
