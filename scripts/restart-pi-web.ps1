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

function Test-Health {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch { return $false }
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
Start-Process -FilePath $node -ArgumentList @('server.mjs') -WorkingDirectory $root -WindowStyle Hidden | Out-Null

$readyDeadline = (Get-Date).AddSeconds(30)
do {
  if (Test-Health) {
    Write-Host '元枢已就绪：8787 /api/health = 200' -ForegroundColor Green
    exit 0
  }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $readyDeadline)

throw '元枢启动后 30 秒内健康检查未通过，请查看 watchdog.log 和控制台输出。'
