<#
.SYNOPSIS
  DeepSeek DeskMate 一键部署（Windows）：检查环境 → 拉模型 → 装后端 → 生成令牌 → 可选配置 GPT-SoVITS → 构建客户端 → 启动。

.EXAMPLE
  # 交互式（推荐第一次用）
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1

.EXAMPLE
  # 全自动：Edge 语音、不问问题
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Yes

.EXAMPLE
  # 全自动 + 本机 GPT-SoVITS + 用 Docker 跑后端
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Yes -Docker -Tts gpt_sovits `
    -GsvRefAudio 'D:\GPT-SoVITS\refs\voice.wav' -GsvPromptText '参考音频里说的那句话'
#>
[CmdletBinding()]
param(
    # 不提问，全部用默认值 / 命令行参数
    [switch]$Yes,
    # 语音合成方式：edge 或 gpt_sovits；不填时交互式询问（-Yes 时为 edge）
    [ValidateSet('', 'edge', 'gpt_sovits')]
    [string]$Tts = '',
    # 用 docker compose 运行后端，而不是本机 Python venv
    [switch]$Docker,
    # Ollama 模型；不填时用 server/.env 里的 OLLAMA_MODEL（默认 deepseek-r1:8b）
    [string]$Model = '',
    [string]$GsvUrl = 'http://127.0.0.1:9880',
    [string]$GsvRefAudio = '',
    [string]$GsvPromptText = '',
    [string]$GsvPromptLang = 'zh',
    # 跳过 Ollama 检查和拉模型（比如 Ollama 在别的机器上）
    [switch]$SkipOllama,
    # 不构建客户端（只部署后端）
    [switch]$NoClient,
    # 部署完不启动后端
    [switch]$NoStart,
    # 部署完顺便启动客户端
    [switch]$StartClient,
    # 构建进客户端的「官方服务器」默认地址；不填时用本机后端 http://127.0.0.1:<端口>
    [string]$ServerUrl = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root 'server'
$Client = Join-Path $Root 'client'
$EnvFile = Join-Path $Server '.env'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "`n[x] $msg" -ForegroundColor Red; exit 1 }
function Has([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Ask([string]$question, [string]$default = '') {
    if ($Yes) { return $default }
    $hint = if ($default) { " [$default]" } else { '' }
    $answer = Read-Host "    $question$hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
}

function Confirm([string]$question, [bool]$default = $true) {
    if ($Yes) { return $default }
    $hint = if ($default) { 'Y/n' } else { 'y/N' }
    $answer = Read-Host "    $question ($hint)"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim().ToLower().StartsWith('y')
}

function Get-EnvValue([string]$key) {
    if (-not (Test-Path $EnvFile)) { return '' }
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile, $Utf8NoBom)) {
        if ($line -match "^\s*$key\s*=(.*)$") { return $Matches[1].Trim() }
    }
    return ''
}

# 改 / 追加 server/.env 里的一项（UTF-8 无 BOM，pydantic-settings 读得了）
function Set-EnvValue([string]$key, [string]$value) {
    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path $EnvFile) { $lines.AddRange([System.IO.File]::ReadAllLines($EnvFile, $Utf8NoBom)) }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$key\s*=") { $lines[$i] = "$key=$value"; $found = $true }
    }
    if (-not $found) { $lines.Add("$key=$value") }
    [System.IO.File]::WriteAllLines($EnvFile, $lines, $Utf8NoBom)
}

function Find-Python {
    foreach ($candidate in @(@('py', '-3'), @('python'), @('python3'))) {
        if (-not (Has $candidate[0])) { continue }
        $exe = $candidate[0]
        $pre = @($candidate | Select-Object -Skip 1)
        $ok = & $exe @pre -c 'import sys; print(int(sys.version_info >= (3, 10)))' 2>$null
        if ($LASTEXITCODE -eq 0 -and "$ok".Trim() -eq '1') { return , $candidate }
    }
    return $null
}

function Test-Url([string]$url, [int]$timeoutSec = 3) {
    # 任何 HTTP 响应（包括 GPT-SoVITS /control 的 400）都算活着，连不上才算没起
    try {
        Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec | Out-Null
        return $true
    } catch [System.Net.WebException] {
        return $null -ne $_.Exception.Response
    } catch {
        return $null -ne $_.Exception.Response
    }
}

function Wait-Health([string]$url, [int]$seconds = 60) {
    for ($i = 0; $i -lt $seconds; $i++) {
        try {
            return Invoke-RestMethod -Uri $url -TimeoutSec 3
        } catch { Start-Sleep -Seconds 1 }
    }
    return $null
}

Write-Host 'DeepSeek DeskMate 一键部署' -ForegroundColor Magenta
Write-Host "仓库：$Root"

# ---------------------------------------------------------------- 1. 环境检查
Step '检查环境'
$python = $null
if (-not $Docker) {
    $python = Find-Python
    if (-not $python) { Fail '需要 Python 3.10 或以上：https://www.python.org/downloads/ （安装时勾选 Add to PATH），或加 -Docker 用容器运行后端' }
    Ok ("Python：" + (& $python[0] @(@($python | Select-Object -Skip 1)) --version))
} else {
    if (-not (Has 'docker')) { Fail '用了 -Docker，但没找到 docker：请先安装 Docker Desktop' }
    docker compose version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'docker compose 不可用，请升级 Docker Desktop' }
    Ok 'Docker 和 docker compose'
}

$buildClient = -not $NoClient
if ($buildClient) {
    if (-not (Has 'node')) {
        Warn '没找到 Node.js（需要 20 以上，推荐 24）：https://nodejs.org/ —— 先跳过客户端'
        $buildClient = $false
    } else {
        $nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
        if ($nodeMajor -lt 20) { Warn "Node.js 版本太旧（$(node --version)），需要 20 以上 —— 先跳过客户端"; $buildClient = $false }
        else { Ok "Node.js $(node --version)" }
    }
}

# ---------------------------------------------------------------- 2. server/.env
Step '准备 server/.env'
$newEnv = $false
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $Server '.env.example') $EnvFile
    # 示例里的 change-me-123 不能留；令牌改用令牌库（下面生成）
    Set-EnvValue 'ACCESS_TOKENS' ''
    $newEnv = $true
    Ok '已从 .env.example 创建 server/.env'
} else {
    Ok 'server/.env 已存在，保留原有配置'
    if ((Get-EnvValue 'ACCESS_TOKENS') -match 'change-me') { Warn 'ACCESS_TOKENS 还是示例值 change-me-123，建议清空并用令牌库' }
}
if ($Model) { Set-EnvValue 'OLLAMA_MODEL' $Model }
$Model = Get-EnvValue 'OLLAMA_MODEL'
if (-not $Model) { $Model = 'deepseek-r1:8b' }

# ---------------------------------------------------------------- 3. Ollama
if (-not $SkipOllama) {
    Step "Ollama 与模型 $Model"
    if (-not (Has 'ollama')) {
        Warn '没找到 Ollama：请从 https://ollama.com/download 安装后重新运行（或加 -SkipOllama 跳过）'
    } else {
        if (-not (Test-Url 'http://127.0.0.1:11434/api/tags')) {
            Warn 'Ollama 没在运行，尝试后台启动 ollama serve'
            Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
            Start-Sleep -Seconds 3
        }
        $models = (ollama list 2>$null) -join "`n"
        if ($models -match [regex]::Escape($Model)) { Ok "模型 $Model 已存在" }
        else {
            Write-Host "    拉取 $Model（几个 GB，第一次会比较久）..."
            ollama pull $Model
            if ($LASTEXITCODE -ne 0) { Warn "ollama pull $Model 失败，稍后可以手动重试" } else { Ok "已拉取 $Model" }
        }
    }
}

# ---------------------------------------------------------------- 4. 语音合成
Step '语音合成'
if (-not $Tts) {
    $current = Get-EnvValue 'TTS_PROVIDER'
    if ($Yes -or ($current -and -not $newEnv)) { $Tts = if ($current) { $current } else { 'edge' } }
    else {
        Write-Host '    edge       = 微软 Edge 在线语音（默认，不占显卡）'
        Write-Host '    gpt_sovits = 本机 GPT-SoVITS 自定义音色（需要先装好并启动，见 doc/gpt-sovits.md）'
        $Tts = Ask '选择语音合成方式 edge / gpt_sovits' 'edge'
    }
}
if ($Tts -eq 'gpt_sovits') {
    $GsvUrl = Ask 'GPT-SoVITS 地址' $GsvUrl
    if (-not $GsvRefAudio) { $GsvRefAudio = Ask '参考音频路径（GPT-SoVITS 那台机器上的 3~10 秒 wav；已有 server/data/voices.json 可留空）' (Get-EnvValue 'GSV_REF_AUDIO') }
    if ($GsvRefAudio -and -not $GsvPromptText) { $GsvPromptText = Ask '参考音频里说的那句话（强烈建议填）' (Get-EnvValue 'GSV_PROMPT_TEXT') }
    if ($GsvRefAudio) { $GsvPromptLang = Ask '参考音频语言 zh/en/ja/ko/yue' $GsvPromptLang }
    Set-EnvValue 'TTS_PROVIDER' 'gpt_sovits'
    Set-EnvValue 'TTS_FALLBACK' 'edge'
    Set-EnvValue 'GSV_URL' $GsvUrl
    if ($GsvRefAudio) {
        Set-EnvValue 'GSV_REF_AUDIO' $GsvRefAudio
        Set-EnvValue 'GSV_PROMPT_TEXT' $GsvPromptText
        Set-EnvValue 'GSV_PROMPT_LANG' $GsvPromptLang
    }
    $voicesFile = Join-Path $Server 'data\voices.json'
    if (-not $GsvRefAudio -and -not (Test-Path $voicesFile)) {
        Warn '既没填参考音频，也没有 server/data/voices.json：GPT-SoVITS 没有可用音色，会一直用 Edge 兜底'
        Warn '照 server/voices.example.json 写一份 server/data/voices.json 后重启后端即可'
    }
    if (Test-Url "$GsvUrl/control") { Ok "GPT-SoVITS 在线：$GsvUrl" }
    else { Warn "连不上 $GsvUrl（还没启动？）。后端照样能用，GPT-SoVITS 起来之前用 Edge 语音兜底" }
    if ($Docker -and $GsvUrl -match '127\.0\.0\.1|localhost') {
        Ok '容器里会自动改用 http://host.docker.internal:9880 访问宿主机上的 GPT-SoVITS'
    } elseif ($Docker) {
        $env:DESKMATE_GSV_URL = $GsvUrl
    }
} else {
    Set-EnvValue 'TTS_PROVIDER' 'edge'
    Ok '使用 Edge 语音'
}

# ---------------------------------------------------------------- 5. 后端
if (-not $Docker) {
    Step '安装后端依赖（server/.venv）'
    $venvPy = Join-Path $Server '.venv\Scripts\python.exe'
    if (-not (Test-Path $venvPy)) {
        & $python[0] @(@($python | Select-Object -Skip 1)) -m venv (Join-Path $Server '.venv')
        if ($LASTEXITCODE -ne 0) { Fail '创建虚拟环境失败' }
    }
    & $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $Server 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { Fail 'pip install 失败（国内网络可以先设置 $env:PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple" 再重试）' }
    Ok '依赖已安装（锁定版本）'

    if ($newEnv) {
        Step '生成访问令牌'
        Push-Location $Server
        try { & $venvPy -m deskmate_server.tokens add 主人 } finally { Pop-Location }
        Warn '上面的令牌只显示这一次：桌宠右键「设置」→ 官方服务器 →「访问令牌」里填它。给朋友再发：tokens add <名字>'
    }
}

$healthUrl = "http://127.0.0.1:$(if (Get-EnvValue 'PORT') { Get-EnvValue 'PORT' } else { '8000' })/health"
if ($Docker) {
    $healthUrl = "http://127.0.0.1:$(if ($env:DESKMATE_PORT) { $env:DESKMATE_PORT } else { '8000' })/health"
    Step '构建并启动后端容器（docker compose）'
    Push-Location $Root
    try {
        docker compose up -d --build
        if ($LASTEXITCODE -ne 0) { Fail 'docker compose up 失败' }
        if ($newEnv) {
            if (Wait-Health $healthUrl 60) {
                Step '生成访问令牌'
                docker compose exec server python -m deskmate_server.tokens add 主人
                Warn '上面的令牌只显示这一次：桌宠右键「设置」→ 官方服务器 →「访问令牌」里填它'
            } else { Warn '后端还没就绪，稍后手动运行：docker compose exec server python -m deskmate_server.tokens add 主人' }
        }
    } finally { Pop-Location }
} elseif (-not $NoStart) {
    Step '启动后端'
    $running = Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
        Where-Object { $_.CommandLine -match 'app\.py|deskmate_server' -and $_.CommandLine -notmatch 'deskmate_server\.tokens' }
    if ($running) {
        Warn '后端已经在运行，先停掉旧进程再用新配置启动'
        $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    Start-Process -FilePath (Join-Path $Server '.venv\Scripts\python.exe') -ArgumentList 'app.py' -WorkingDirectory $Server -WindowStyle Minimized
}
if ($Docker -or -not $NoStart) {
    $health = Wait-Health $healthUrl 30
    if ($health) {
        Ok "后端已启动：$healthUrl（ollama=$($health.ollama)，语音=$($health.tts_provider)）"
    } else { Warn "后端 30 秒内没响应，看看后端窗口里的报错（或 docker compose logs server）" }
}

# ---------------------------------------------------------------- 6. 客户端
if ($buildClient) {
    Step '构建客户端（client/）'
    Push-Location $Client
    try {
        $core = Join-Path $Client 'vendor\live2dcubismcore.min.js'
        if (-not (Test-Path $core)) {
            New-Item -ItemType Directory -Force (Join-Path $Client 'vendor') | Out-Null
            Write-Host '    下载 Live2D Cubism Core（Live2D Inc. 专有运行时，不随仓库分发）'
            Invoke-WebRequest 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js' -OutFile $core -UseBasicParsing
        }
        Ok 'Cubism Core 就绪'
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Fail 'npm install 失败（国内网络可以先 npm config set registry https://registry.npmmirror.com）' }
        node node_modules/electron/install.js
        if ($LASTEXITCODE -ne 0) { Warn 'Electron 二进制下载失败，可以设置 $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" 后重试' }
        if (-not $ServerUrl) { $ServerUrl = if ($env:DESKMATE_SERVER_URL) { $env:DESKMATE_SERVER_URL } else { $healthUrl -replace '/health$', '' } }
        $env:DESKMATE_SERVER_URL = $ServerUrl
        npm run build
        if ($LASTEXITCODE -ne 0) { Fail '客户端构建失败' }
        Ok "客户端已构建到 client/out（默认服务器 $ServerUrl）"
    } finally { Pop-Location }

    if ($StartClient -or (-not $Yes -and (Confirm '现在启动桌宠吗？' $true))) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WorkingDirectory $Client -WindowStyle Minimized
        Ok '桌宠启动中：右键「设置」→ 官方服务器，填上面的令牌，点「测试连接」'
    }
}

Step '完成'
Write-Host '    后端：  server/（配置 server/.env，令牌：python -m deskmate_server.tokens list）'
Write-Host '    语音：  doc/gpt-sovits.md   给朋友用：README「花生壳内网穿透」'
Write-Host '    文档：  doc/产品设计文档.md  doc/架构文档.md'
