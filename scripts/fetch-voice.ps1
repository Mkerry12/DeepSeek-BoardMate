<#
.SYNOPSIS
  下载作者共享的满穗 GPT-SoVITS 音色（私有仓库 Release，需协作者权限）：
  校验 sha256 → 权重放进 GPT-SoVITS → 参考音频放进 server/data/voices/ → 写 server/data/voices.json →
  GPT-SoVITS 正在运行就直接切换权重。

.EXAMPLE
  gh auth login
  powershell -ExecutionPolicy Bypass -File scripts\fetch-voice.ps1 -GsvDir 'D:\GPT-SoVITS'

.EXAMPLE
  # 不提问；GPT-SoVITS 目录也可以用环境变量 GSV_DIR 给
  $env:GSV_DIR = 'D:\GPT-SoVITS'; powershell -ExecutionPolicy Bypass -File scripts\fetch-voice.ps1 -Yes
#>
[CmdletBinding()]
param(
    # GPT-SoVITS 根目录（里面有 api_v2.py、GPT_weights_v2、SoVITS_weights_v2）；不填时读环境变量 GSV_DIR，再没有就问
    [string]$GsvDir = '',
    # 存放音色的私有仓库和 Release 标签
    [string]$Repo = 'Mkerry12/DeepSeek-BoardMate-voice',
    [string]$Tag = 'manhui-v1',
    # 正在运行的 GPT-SoVITS 地址（在线就直接切换权重）
    [string]$GsvUrl = 'http://127.0.0.1:9880',
    # DeskMate 后端数据目录（voices.json 和参考音频放这里）；默认 server/data
    [string]$DataDir = '',
    # 不提问，全部用默认值
    [switch]$Yes,
    # 顺便把 GPT-SoVITS 的 tts_infer.yaml（custom 段）改成默认加载这套权重（会先备份）
    [switch]$PatchConfig
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $DataDir) { $DataDir = Join-Path $Root 'server\data' }
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "`n[x] $msg" -ForegroundColor Red; exit 1 }

function Ask([string]$question, [string]$default = '') {
    if ($Yes) { return $default }
    $hint = if ($default) { " [$default]" } else { '' }
    $answer = Read-Host "    $question$hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim().Trim('"')
}

function Confirm([string]$question, [bool]$default = $true) {
    if ($Yes) { return $default }
    $hint = if ($default) { 'Y/n' } else { 'y/N' }
    $answer = Read-Host "    $question ($hint)"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim().ToLower().StartsWith('y')
}

function Get-Sha256([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
}

function Test-Url([string]$url) {
    # 任何 HTTP 响应（包括 GPT-SoVITS /control 的 400）都算活着，连不上才算没起
    try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true }
    catch { return $null -ne $_.Exception.Response }
}

# gh 的输出（含 stderr）收成一个字符串；不让 stderr 触发 $ErrorActionPreference=Stop
function Invoke-Gh([string[]]$ghArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = (& gh @ghArgs 2>&1 | ForEach-Object { "$_" }) -join "`n" }
    finally { $ErrorActionPreference = $prev }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}

$NoAccess = '你还没有音色仓库的访问权限，请联系仓库作者邀请你成为协作者'

Write-Host '下载满穗音色（GPT-SoVITS）' -ForegroundColor Magenta

# ---------------------------------------------------------------- 1. gh 与访问权限
Step "检查 gh 登录和 $Repo 的访问权限"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Fail '没找到 GitHub CLI（gh）：https://cli.github.com/ 安装后运行 gh auth login，再重新运行本脚本'
}
$r = Invoke-Gh @('auth', 'status')
if ($r.Code -ne 0) { Fail "gh 还没登录：先运行 gh auth login（用被邀请的那个 GitHub 账号），再重新运行本脚本`n$($r.Out)" }
Ok 'gh 已登录'

$r = Invoke-Gh @('api', "repos/$Repo", '--jq', '.full_name')
if ($r.Code -ne 0) {
    if ($r.Out -match '404|Not Found|Could not resolve') { Fail "$NoAccess（$Repo）`n    已接受邀请？确认 gh 登录的是被邀请的账号：gh auth status" }
    Fail "访问 GitHub 失败（网络问题？稍后重试）：`n$($r.Out)"
}
$r = Invoke-Gh @('release', 'view', $Tag, '-R', $Repo, '--json', 'tagName')
if ($r.Code -ne 0) {
    if ($r.Out -match '404|Not Found|release not found') { Fail "$Repo 里没有 Release $Tag（标签写错了？）" }
    Fail "读取 Release $Tag 失败：`n$($r.Out)"
}
Ok "可以访问 $Repo（Release $Tag）"

# ---------------------------------------------------------------- 2. GPT-SoVITS 目录
Step 'GPT-SoVITS 目录'
if (-not $GsvDir) { $GsvDir = "$env:GSV_DIR" }
if (-not $GsvDir) {
    if ($Yes) { Fail '没给 GPT-SoVITS 目录：加 -GsvDir <路径> 或设置环境变量 GSV_DIR' }
    $GsvDir = Ask 'GPT-SoVITS 根目录（里面有 api_v2.py 和 GPT_SoVITS 文件夹）'
}
if (-not $GsvDir -or -not (Test-Path -LiteralPath $GsvDir -PathType Container)) { Fail "GPT-SoVITS 目录不存在：$GsvDir" }
$GsvDir = (Resolve-Path -LiteralPath $GsvDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $GsvDir 'GPT_SoVITS'))) {
    Warn "$GsvDir 里没有 GPT_SoVITS 文件夹，看起来不像 GPT-SoVITS 根目录"
    if (-not (Confirm '仍然放到这里吗？' $false)) { Fail '已取消' }
}
$gptDir = Join-Path $GsvDir 'GPT_weights_v2'
$sovitsDir = Join-Path $GsvDir 'SoVITS_weights_v2'
$voiceDir = Join-Path $DataDir 'voices'
foreach ($d in @($gptDir, $sovitsDir, $voiceDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Ok $GsvDir

# ---------------------------------------------------------------- 3. 下载并校验
Step "下载 $Tag 并校验 sha256"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('deskmate-voice-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-Asset([string]$name) {
    for ($i = 1; $i -le 3; $i++) {
        $r = Invoke-Gh @('release', 'download', $Tag, '-R', $Repo, '-p', $name, '-D', $tmp, '--clobber')
        if ($r.Code -eq 0 -and (Test-Path -LiteralPath (Join-Path $tmp $name))) { return (Join-Path $tmp $name) }
        if ($r.Out -match '404|Not Found') { Fail "$NoAccess（下载 $name 时 404）" }
        if ($i -lt 3) { Warn "下载 $name 失败，20 秒后重试（$i/3）"; Start-Sleep -Seconds 20 }
    }
    Fail "下载 $name 失败：`n$($r.Out)"
}

try {
    $manifestPath = Get-Asset 'voice-manifest.json'
    $m = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Ok "清单：$($m.name)（GPT-SoVITS $($m.gsv_version)）"

    # 清单里的文件名只取文件名部分，不许带 .. 之类跳出目标目录
    foreach ($a in @($m.gpt_weights, $m.sovits_weights, $m.ref_audio)) {
        $raw = "$($a.file)"
        $base = [IO.Path]::GetFileName($raw.Replace('/', '\'))
        if (-not $base -or $base -eq '.' -or $base -eq '..' -or $raw.Contains('..')) { Fail "清单里的文件名不合法：$raw" }
        $a.file = $base
    }
    $items = @(
        @{ Asset = $m.gpt_weights; Dest = (Join-Path $gptDir $m.gpt_weights.file) },
        @{ Asset = $m.sovits_weights; Dest = (Join-Path $sovitsDir $m.sovits_weights.file) },
        @{ Asset = $m.ref_audio; Dest = (Join-Path $voiceDir $m.ref_audio.file) }
    )
    foreach ($it in $items) {
        $a = $it.Asset
        if ((Get-Sha256 $it.Dest) -eq $a.sha256) { Ok "$($a.file) 已存在且一致，跳过"; continue }
        Write-Host "    下载 $($a.file)（$([math]::Round($a.size / 1MB, 1)) MB）..."
        $file = Get-Asset $a.file
        $hash = Get-Sha256 $file
        if ($hash -ne $a.sha256) { Fail "$($a.file) 校验失败：期望 $($a.sha256)，实际 $hash（下载不完整？重新运行试试）" }
        Copy-Item -LiteralPath $file -Destination $it.Dest -Force
        Ok "$($a.file) → $($it.Dest)"
    }
} finally {
    Get-ChildItem -LiteralPath $tmp -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
$gptPath = $items[0].Dest
$sovitsPath = $items[1].Dest
$refPath = (Resolve-Path -LiteralPath $items[2].Dest).Path

# ---------------------------------------------------------------- 4. voices.json
Step 'DeskMate 音色预设（voices.json）'
$voicesFile = Join-Path $DataDir 'voices.json'
$default = $null
$others = @()
if (Test-Path -LiteralPath $voicesFile) {
    try {
        $raw = [IO.File]::ReadAllText($voicesFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $old = ConvertFrom-Json $raw
        if ($old -is [array]) { $list = $old } else { $list = @($old.voices); $default = $old.default }
        $others = @($list | Where-Object { $_ -and $_.name -ne $m.name })
        Copy-Item -LiteralPath $voicesFile -Destination "$voicesFile.bak" -Force
        Ok "已有 $($others.Count) 个其他音色，保留（旧文件备份为 voices.json.bak）"
    } catch { Fail "$voicesFile 不是合法 JSON，先修好或挪走再运行：$_" }
}
$preset = [ordered]@{
    name              = $m.name
    label             = $(if ($m.label) { $m.label } else { $m.name })
    ref_audio_path    = $refPath
    prompt_text       = $m.prompt_text
    prompt_lang       = $m.prompt_lang
    text_lang         = $m.text_lang
    speed             = [double]$m.speed_factor
    text_split_method = $m.text_split_method
}
if (-not $default -or $default -eq $m.name -or (Confirm "把「$($m.name)」设为默认音色吗？（当前默认：$default）" $true)) { $default = $m.name }
$doc = [ordered]@{ default = $default; voices = @($others + [pscustomobject]$preset) }
[IO.File]::WriteAllText($voicesFile, ($doc | ConvertTo-Json -Depth 5) + "`n", $Utf8NoBom)
Ok "$voicesFile（默认音色：$default）"

# ---------------------------------------------------------------- 5. 切换 GPT-SoVITS 权重
Step 'GPT-SoVITS 权重'
if (Test-Url "$GsvUrl/control") {
    $switched = $true
    foreach ($pair in @(@('set_gpt_weights', $gptPath), @('set_sovits_weights', $sovitsPath))) {
        $url = "$GsvUrl/$($pair[0])?weights_path=" + [uri]::EscapeDataString($pair[1])
        try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 180 | Out-Null; Ok "$($pair[0]) 成功" }
        catch { $switched = $false; Warn "$($pair[0]) 失败：$($_.Exception.Message)（需要 api_v2.py；老的 api.py 不支持这个接口）" }
    }
    if ($switched) { Ok "GPT-SoVITS（$GsvUrl）已切到满穗权重；它重启后会回到配置文件里的默认权重" }
} else {
    Warn "连不上 $GsvUrl（GPT-SoVITS 没启动），没法在线切换权重"
}

$cfg = Join-Path $GsvDir 'GPT_SoVITS\configs\tts_infer.yaml'
Write-Host '    想让 GPT-SoVITS 启动就加载这套权重：把 GPT_SoVITS/configs/tts_infer.yaml 里 custom 段改成'
Write-Host "      t2s_weights_path: GPT_weights_v2/$($m.gpt_weights.file)"
Write-Host "      vits_weights_path: SoVITS_weights_v2/$($m.sovits_weights.file)"
Write-Host "      version: $($m.gsv_version)"
Write-Host '    （或者启动后照上面在线切换：/set_gpt_weights 和 /set_sovits_weights 的 weights_path 参数）'
if (Test-Path -LiteralPath $cfg) {
    $doPatch = if ($PatchConfig) { $true } else { Confirm '现在帮你改 tts_infer.yaml 吗？（会先备份）' $false }
    if ($doPatch) {
        $lines = [IO.File]::ReadAllLines($cfg, [Text.Encoding]::UTF8)
        $inCustom = $false
        $hit = 0
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^\S') { $inCustom = $lines[$i] -match '^custom:\s*$'; continue }
            if (-not $inCustom) { continue }
            if ($lines[$i] -match '^(\s+)t2s_weights_path:') { $lines[$i] = "$($Matches[1])t2s_weights_path: GPT_weights_v2/$($m.gpt_weights.file)"; $hit++ }
            elseif ($lines[$i] -match '^(\s+)vits_weights_path:') { $lines[$i] = "$($Matches[1])vits_weights_path: SoVITS_weights_v2/$($m.sovits_weights.file)"; $hit++ }
            elseif ($lines[$i] -match '^(\s+)version:') { $lines[$i] = "$($Matches[1])version: $($m.gsv_version)" }
        }
        if ($hit -lt 2) { Warn 'tts_infer.yaml 的 custom 段里没找到 t2s_weights_path / vits_weights_path，没改，请手动改' }
        else {
            $bak = "$cfg.bak-$(Get-Date -Format yyyyMMddHHmmss)"
            Copy-Item -LiteralPath $cfg -Destination $bak
            [IO.File]::WriteAllLines($cfg, $lines, $Utf8NoBom)
            Ok "已改 tts_infer.yaml（备份：$bak）；用 api_v2.py -c 指定了别的配置文件的话要改那个文件"
        }
    }
}

# ---------------------------------------------------------------- 6. 收尾
Step '完成'
Write-Host '    DeskMate 后端只在启动时读 voices.json：重启后端才会用上新音色'
Write-Host '      （本机：关掉后端窗口再 cd server; .\.venv\Scripts\python.exe app.py，或重新运行 scripts\deploy.ps1；Docker：docker compose cp server/data/voices.json server:/app/data/voices.json; docker compose restart server，或重新运行 deploy.ps1 -Docker）'
Write-Host '    音色仅限受邀协作者个人使用，禁止二次分发；对外发布合成内容请标注 AI 合成'
exit 0
