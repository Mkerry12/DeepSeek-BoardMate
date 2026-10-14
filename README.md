# DeepSeek DeskMate — Live2D AI 桌宠

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
.\.venv\Scripts\python app.py
```

浏览器打开 http://127.0.0.1:8000/health 应看到 `"ollama": true`。

## 2. 花生壳内网穿透

1. 安装花生壳客户端并登录，添加映射：
   - 映射类型：HTTPS（或 HTTP）
   - 内网主机：`127.0.0.1`，内网端口：`8000`
2. 得到外网地址，例如 `https://xxxx.vicp.fun`，发给朋友，再给每人一个 `ACCESS_TOKENS` 里的令牌。

注意：只映射 8000 端口，**不要映射 Ollama 的 11434**（它没有任何鉴权）。

## 3. 运行 / 打包客户端

```powershell
cd client
npm install
node node_modules/electron/install.js   # 如果 electron 二进制没下载下来
npm start          # 开发运行
npm run dist       # 打包成 exe，输出在 client/dist（便携版 + 安装包）
```

- 角色是 Live2D「DS鲸鱼娘」（`client/assets/live2d/ds-whale-girl/`）
  - 来源：[A8Chann/dsh-pet-live2d](https://github.com/A8Chann/dsh-pet-live2d)，协议 **CC BY-NC-SA 4.0**（署名、非商用、相同方式共享）
  - 版权：上善无形（角色原作「溟月」）、ZipZipPipe（DeepSeek 女仆二设）、氵六青（Live2D 模型）
  - 需要 Live2D 官方运行时：把 `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` 下载到 `client/vendor/`
- 操作：左键拖动、单击互动、双击聊天、右键菜单、Esc 关闭输入框/菜单；托盘图标可显示/隐藏、开机自启、退出
- 首次使用：右键 → 设置，选择连接方式，点「测试连接」

### 连接方式

- **官方服务器**（默认）：连主人电脑上的 server（Ollama），只需填令牌；「高级」里可改服务器地址。
  默认地址写在 `client/src/main/main.js` 的 `OFFICIAL_SERVER_URL`，**打包发给朋友前改成花生壳域名**。
  可在设置里选服务器上的模型（`GET /models`，自动排除 bge-m3 等嵌入模型）和自定义人设。
- **自己的 API Key**：客户端直连 OpenAI 兼容接口，不经过服务器。预设 DeepSeek 官方
  （`deepseek-chat` / `deepseek-reasoner`），或选「自定义」填接口地址 + 模型名（OpenAI、硅基流动、通义等）。
  Key 用系统 DPAPI 加密保存在 `%APPDATA%\deepseek-deskmate\settings.json`。

### 小功能

- **桌上道具**：纸上的三个图标可以点 —— 撤回（删掉上一轮对话）、画笔（打开输入框）、橡皮（连点两下清空对话）。
  思考时画笔亮、回复完橡皮亮、按停止时撤回亮。
- **记忆**：聊天记录存到 `%APPDATA%\deepseek-deskmate\history.json`（最多 200 条），每次只把最近 20 条发给模型；右键「清空记忆」。
- **闲置小动作**：一段时间不理她会自拍、吹泡泡、挤番茄酱、吃巴菲，5 分钟没动静会打瞌睡，碰一下就醒。
- **小助手**：喝水 / 久坐提醒（设置里开关和间隔）、右键「番茄钟」25 + 5 分钟、「看看剪贴板」让她解释复制的文字。
- **换装**：右键「换装」选眼镜、贴纸、发饰、手势、魔爪、桌布等，同一槽位互斥，重启后保留。

## 情绪与动作

后端提示词要求模型在回复开头输出 `[happy]` 等标签，客户端据此叠加 Live2D 表情、播放动作
（映射在 `client/src/renderer/live2d.js` 的 `DEFAULT_PROFILE`）。可用标签：
`happy sad angry surprised relaxed thinking wave neutral`。
默认人设在 `server/app.py` 的 `DEFAULT_PERSONA`（API Key 模式用 `client/src/renderer/persona.js` 里的同一份），
情绪标签规则在 `REPLY_RULES`；用户在设置里填的人设只替换人设部分。

## 许可

- 代码：暂未指定开源协议（保留所有权利）。
- Live2D 模型「DS鲸鱼娘」（`client/assets/live2d/ds-whale-girl/`）：**CC BY-NC-SA 4.0**，版权归 上善无形 / ZipZipPipe / 氵六青，详见该目录下的 LICENSE 与 README。
- Live2D Cubism Core 为 Live2D Inc. 专有软件，不随本仓库分发，请按上文自行下载到 `client/vendor/`。
