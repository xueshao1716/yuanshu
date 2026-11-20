$ErrorActionPreference = 'Stop'

# 不写死盘符（2026-09-16，外部机器安装检查的第 3 个 bug）：本脚本在 scripts/ 下，
# 它的上一级就是仓库根。$PSScriptRoot 在以 `powershell -File` 运行时可用，否则退回当前目录。
$root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$port = 8787
$healthUrl = "http://127.0.0.1:$port/api/health"
$server = Join-Path $root 'server.mjs'

# 8787 通常由开机任务以管理员权限托管；双击或普通终端调用时自动提权一次。
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = if ($identity) { New-Object Security.Principal.WindowsPrincipal($identity) } else { $null }
if ($principal -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  # 不调用 WaitForExit：Windows PowerShell 在子进程继承句柄时可能把后台后代
  # 也算进等待时间。轮询启动器自己的 HasExited，只等待提权脚本并保留退出码。
  $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $args -PassThru
  while (-not $elevated.HasExited) { Start-Sleep -Milliseconds 100 }
  $elevated.Refresh()
  exit $elevated.ExitCode
}

function Get-ListenerPids {
  $lines = netstat -ano | Select-String -Pattern (":$port\s+.*LISTENING\s+(\d+)$")
  @($lines | ForEach-Object {
    $match = [regex]::Match($_.Line, "LISTENING\s+(\d+)$")
    if ($match.Success) { [int]$match.Groups[1].Value }
  } | Sort-Object -Unique)
}

# 2026-11-20：只看 200 会把「别人占着端口」当成自己就绪（安装版服务抢了 8787，手机连的一直是旧版）。
# 现在比对 /api/health 里的实例指纹（代码目录小写的 sha256 前 12 位，与 server.mjs 同算法）。
$sha = [Security.Cryptography.SHA256]::Create()
$expectedId = (-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLower())) | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
$expectedVersion = (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'version.json') | ConvertFrom-Json).version
$script:impostor = $null

function Test-Health {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
    if ($response.StatusCode -ne 200) { return $false }
    $body = $response.Content | ConvertFrom-Json
    if ($body.instance -eq $expectedId) { $script:impostor = $null; return $true }
    $script:impostor = if ($body.version) { "v$($body.version)" } else { '旧版本（健康接口不带指纹）' }
    return $false
  } catch { return $false }
}

function Get-RivalService {
  # 安装版的 Windows 服务会守护它自己的 server.mjs，开发仓库重启时它会抢先占端口
  Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Running' -and $_.PathName -match 'Yuanshu' -and $_.PathName -notmatch [regex]::Escape($root) } |
    Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $server)) {
  throw "找不到服务入口：$server"
}

$oldPids = @(Get-ListenerPids)
if ($oldPids.Count -gt 0) {
  Write-Host "停止 8787 现有监听进程：$($oldPids -join ', ')"
  foreach ($listenerPid in $oldPids) {
    Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
  }
}

$releaseDeadline = (Get-Date).AddSeconds(20)
do {
  $remaining = @(Get-ListenerPids)
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $releaseDeadline)

$remaining = @(Get-ListenerPids)
if ($remaining.Count -gt 0) {
  throw "8787 端口未释放，仍被进程占用：$($remaining -join ', ')"
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
Write-Host '启动元枢服务…'
# 手机客户端走局域网访问，必须监听 0.0.0.0（与 watchdog 一致）；漏了会让手机端资产/图片全部打不开。
$env:YUANSHU_LAN = '1'
Start-Process -FilePath $node -ArgumentList @('server.mjs') -WorkingDirectory $root -WindowStyle Hidden | Out-Null

$readyDeadline = (Get-Date).AddSeconds(30)
do {
  if (Test-Health) {
    Write-Host "元枢已就绪：8787 由 $root 提供（v$expectedVersion）" -ForegroundColor Green
    exit 0
  }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $readyDeadline)

if ($script:impostor) {
  $rival = Get-RivalService
  $hint = if ($rival) { "多半是安装版服务 $($rival.Name) 抢的：它守护的是安装目录里的副本。处理：sc stop $($rival.Name) 并改为手动启动，或给它设 YUANSHU_DEV_APP=$root 让它守护本仓库。" } else { '先停掉占用者再重启。' }
  throw "8787 正在响应的是另一份元枢（$script:impostor），不是 $root（v$expectedVersion）——本仓库启动时端口被它抢了，所有改动都没生效。$hint"
}
throw '元枢启动后 30 秒内健康检查未通过，请查看 watchdog.log 和控制台输出。'
