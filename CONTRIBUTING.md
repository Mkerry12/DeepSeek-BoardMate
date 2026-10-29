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

然后：

```powershell
npm run dev       # 开发：Vite 开发服务器 + 热更新（改渲染进程代码即时生效，改主进程会自动重启）
npm run build     # 构建到 out/（main / preload / renderer 各自由 Vite 打包）
npm start         # 运行 out/ 里的构建产物（接近打包后的行为）
npm run dist      # build + electron-builder，输出 dist/ 下的便携版和安装包
```

`vendor/` 是渲染进程的 public 目录：开发时 Cubism Core 由 Vite 提供，构建时复制到 `out/renderer/`。

### 后端（`server/`）

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt
copy .env.example .env      # 按需修改 ACCESS_TOKENS、OLLAMA_MODEL 等
.\.venv\Scripts\python app.py      # 等价于 python -m deskmate_server
```

> `.env` 里是令牌等机密，已被 `.gitignore` 忽略，**永远不要提交**。新增配置项时请同步更新 `.env.example`
> 和 `deskmate_server/config.py` 的 `Settings`（启动时会校验类型和范围，填错会直接报出是哪一项）。

#### 依赖锁定

`requirements.in` / `requirements-dev.in` 写直接依赖（宽松版本），`requirements.txt` / `requirements-dev.txt`
是由 [uv](https://docs.astral.sh/uv/) 生成的**锁定版本**（`--universal`，同一份文件 Windows 和 Linux/Docker 通用）。
平时只用 pip 安装锁定文件即可，不需要装 uv；只有增删 / 升级依赖时才重新生成：

```powershell
# 安装 uv：pip install uv（或 winget install astral-sh.uv）
uv pip compile requirements.in --universal --python-version 3.10 -o requirements.txt
uv pip compile requirements-dev.in --universal --python-version 3.10 -o requirements-dev.txt
.\.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt
```

国内网络连 PyPI 不稳定时，可临时加镜像：`pip install ... -i https://pypi.tuna.tsinghua.edu.cn/simple`，
uv 用环境变量 `$env:UV_INDEX_URL='https://pypi.tuna.tsinghua.edu.cn/simple'`（不会写进锁定文件）。

## 2. 检查与测试

提交前请在本地跑一遍（CI 会跑同样的命令）：

```powershell
# 客户端
cd client
npm run typecheck     # TypeScript（strict）：main/preload、renderer、测试三份 tsconfig
npm run lint          # ESLint + typescript-eslint
npm run format:check  # Prettier 检查（npm run format 自动格式化）
npm test              # Vitest 单元测试
npm run build         # 确认能构建

# 后端
cd server
.\.venv\Scripts\ruff check .
.\.venv\Scripts\ruff format --check .   # 去掉 --check 自动格式化
.\.venv\Scripts\python -m pytest
```

- 客户端测试在 `client/test/`，覆盖纯逻辑模块（流式过滤、人设拼接、SSE 解析、记忆、触摸、运势、问候时段）、
  事件总线、设置迁移、角色配置校验、IPC 契约，以及情绪标签与服务器的一致性。
  涉及 DOM / Electron 的模块尽量把纯逻辑拆成导出的函数再测。
- 后端测试在 `server/tests/`，用 FastAPI `TestClient` + `respx` 模拟 Ollama、用假的 `edge_tts` 代替联网，**不依赖本机 `.env`**。
- 代码风格：TS 单引号、分号、2 空格、行宽 120（`.prettierrc`）；Python 行宽 110（`server/pyproject.toml`）。编辑器请启用 EditorConfig。
- TypeScript 开 `strict`；`any` 只用在第三方库边界（Live2D 引擎的模型对象等），并用 `eslint-disable` 注明。

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
2. **CI 必须全绿**：client（typecheck + lint + format + test + build）、server（ruff + pytest）、gitleaks 密钥扫描。
   需要验证 Windows 打包时给 PR 加 `build` 标签，会额外跑 `build (windows portable)` 并上传 exe。
3. **至少 1 人 review 通过**后再合并，推荐 Squash merge。
4. 不要改无关文件；大改动先开 issue 讨论。

## 5. 项目结构

```
shared/emotion-tags.json      情绪标签唯一来源（客户端直接导入，服务器启动时读取）
client/                       Electron 客户端（TypeScript + electron-vite）
  electron.vite.config.ts     main / preload / renderer 三份 Vite 构建
  src/shared/                 主进程和渲染进程共用
    ipc.ts                    IPC 契约：所有通道、参数和返回值的类型 + preload/主进程的注册辅助
    types.ts  emotions.ts     设置、聊天消息等共享类型；情绪标签
  src/main/                   主进程
    index.ts                  入口：单实例、组装各模块
    window.ts  tray.ts        透明置顶窗口、托盘
    settings.ts               设置默认值、旧版迁移、OFFICIAL_SERVER_URL、API Key 的 DPAPI 加密
    history.ts                聊天记录 / 长期记忆读写
    ipc.ts                    按契约实现所有 IPC 处理函数（漏实现一个通道会编译失败）
    drag.ts  system.ts        拖动窗口；剪贴板、系统通知
    autostart.ts  tts.ts      开机自启；Edge 语音合成
    paths.ts                  开发 / 打包两种情况下的资源路径
  src/preload/index.ts        按契约生成 window.desk
  src/renderer/
    main.ts                   入口：创建服务、按顺序安装各功能模块
    core/                     事件总线（bus）、状态登记（status）、设置/历史（store）、DOM 引用、AppContext
    services/                 气泡、语音、记忆、右键菜单（按 MENU_ORDER 注册菜单项）
    features/                 功能模块，每个都是 (ctx) => void：聊天、触摸、闲置、提醒、问候、设置面板、运势、换装……
    pet/                      Live2D 角色（live2d.ts）和加载流程（先加载 Cubism Core，再动态导入引擎）
    character/                deskmate.json 的类型与校验
    lib/                      纯逻辑：服务器/OpenAI 接口与 SSE、流式过滤、人设提示词
    index.html / style.css    页面结构（含设置面板）与样式
  test/                       Vitest 单元测试
  assets/live2d/<角色>/        Live2D 模型（CC BY-NC-SA 4.0）+ deskmate.json 角色数据
server/
  app.py                      兼容入口（python app.py），实际代码在 deskmate_server/
  requirements.in / .txt      直接依赖 / uv 生成的锁定版本（-dev 同理）
  deskmate_server/
    main.py                   应用工厂 create_app(settings) + run()；__main__.py 支持 python -m deskmate_server
    config.py                 Settings（pydantic-settings）：读环境变量 / server/.env，启动时校验
    auth.py                   Bearer 令牌鉴权（先查令牌库再查 ACCESS_TOKENS）+ 按令牌 id 限流的依赖（ChatAuth / TTSAuth）
    token_store.py            令牌库（SQLite，只存 sha256）：标签、创建 / 撤销 / 最后使用时间、每日请求数
    tokens.py                 令牌命令行：python -m deskmate_server.tokens add|list|revoke|rename|import-env
    ratelimit.py              60 秒滑动窗口限流器
    ollama.py                 Ollama 客户端：探活、模型列表（排除嵌入模型，缓存 30 秒）、聊天
    persona.py                默认人设、REPLY_RULES（情绪标签读 shared/emotion-tags.json）、记忆提示词
    stream_filter.py          流式过滤：去 <think>、解析情绪标签
    logging_setup.py          访问日志中间件：request id、路径、状态码、耗时、令牌标签（从不记录令牌本身）
    schemas.py                请求体模型与长度限制
    routes/                   health（/health /auth-check）、models、chat（SSE）、memory、tts、admin（设了 ADMIN_TOKEN 才启用）
  tests/                      pytest（conftest 用 make_settings() 构造配置，不读本机 .env）
```

### 渲染进程怎么组织

- 功能模块之间不直接互相调用，而是通过 **事件总线** 通信（`core/bus.ts` 的 `AppEvents` 列出所有事件和载荷类型），
  例如聊天开始时发 `chat:start`，语音、闲置、触摸各自监听；需要查询别人的状态时用 `ctx.status.get('replying')` 之类。
- 跨进程只走 `window.desk`，它的类型完全来自 `src/shared/ipc.ts`。

## 6. 常见改动指南

- **新增情绪标签**：
  1. 加到 `shared/emotion-tags.json`（客户端、服务器的流式过滤和提示词都自动跟着变）
  2. 如有需要，在 `server/deskmate_server/persona.py` 的 `REPLY_RULES` 第 3 条补充这个标签的使用场景
  3. 在每个角色的 `deskmate.json` 的 `live2d.emotions` 里映射到表情 / 动作（配置校验要求每个标签都有映射）
- **新增功能模块**：在 `src/renderer/features/` 新建一个 `(ctx: AppContext) => void`，在 `main.ts` 的 `FEATURES` 里加上。
  需要右键菜单就 `ctx.menu.register(MENU_ORDER.xxx, () => [...])`；和别的模块交互用 `ctx.bus` 的事件（新事件先加到 `AppEvents`）。
  可测试的判断逻辑请导出成纯函数并写测试。
- **新增 IPC 通道**：只改 `src/shared/ipc.ts`（契约 + `DESK_API`），然后 TypeScript 会提示 `src/main/ipc.ts` 缺哪个处理函数。
- **新增 / 修改角色**：在 `client/assets/live2d/<角色>/` 放模型和 `deskmate.json`（台词、触摸区域、闲置活动、换装、运势、问候、提醒），
  字段和校验见 `src/renderer/character/config.ts`；`npm test` 会校验所有角色目录下的配置。
- **新增后端接口**：在 `server/deskmate_server/routes/` 新建一个 `APIRouter` 模块并加进 `routes/__init__.py` 的 `ROUTERS`；
  参数里写 `_: ChatAuth` 就带上鉴权和限流，请求体放 `schemas.py` 用 Pydantic 限制长度，配置从 `request.app.state.settings` 取；在 `server/tests/` 加测试。
- **新增配置项**：后端加到 `.env.example`；客户端设置的类型在 `src/shared/types.ts`，默认值和迁移在 `src/main/settings.ts`，
  设置面板在 `index.html` + `features/settings-panel.ts`。

## 7. 许可

- 代码：[MIT](LICENSE)。
- Live2D 模型「DS鲸鱼娘」（`client/assets/live2d/ds-whale-girl/`）**不适用 MIT**，仍是 **CC BY-NC-SA 4.0**（署名、非商用、相同方式共享），
  版权归 上善无形 / ZipZipPipe / 氵六青。
- Live2D Cubism Core 是 Live2D Inc. 的专有软件，不包含在仓库中，请按上文自行下载。

提交代码即表示你同意以 MIT 协议授权你的贡献。
