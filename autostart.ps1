# 元枢 开机自启配置
#
# 2026-09-14 修：这个脚本此前与实际注册的任务**完全对不上**——
#   脚本写的是 piweb-server（直接 node.exe watchdog.cjs），
#   机器上真实注册的却是 pi-web-watchdog（powershell -NoProfile -Command "& node ..."）。
#   谁重跑这个脚本，就会多出一个 watchdog 去抢 8787，变成双实例。
# 现在按真实配置重写，并统一改名为 yuanshu-*。
#
# 改名顺序很重要：**先注册新任务、确认成功，再删旧名字**。
# 反过来会留下一段时间没有任何自启任务，重启就再也起不来。
#
# 本文件必须存成 UTF-8 with BOM：中文无 BOM 的 .ps1 用 `powershell -File` 执行时，
# 会把脚本原文当输出打出来并且静默失败（2026-09-14 在 restart-pi-web.ps1 上踩过）。
$ErrorActionPreference = 'Stop'

# 不写死盘符（2026-09-16，外部机器安装检查的第 2 个 bug）：本脚本所在目录就是仓库根。
# $PSScriptRoot 在以 `powershell -File` 方式运行时可用；粘贴执行时可能为空，退回当前目录。
$root     = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$user     = "$env:USERDOMAIN\$env:USERNAME"
$nodeArgs = '-WindowStyle Hidden -NoProfile -Command "& node ' + (Join-Path $root 'watchdog.cjs') + '"'

# 老名字：注册完新任务后统一清理。留着 = 两个 watchdog 抢同一个端口。
# 注意 piweb-cloudflared / piweb-shi-openclaw / piweb-si-hermes 并不是元枢的组件，
# 它们只是沿用了同一套机器前缀；这里一并改成 yuanshu-* 保持前缀一致，
# 但别误以为它们属于元枢。
$legacyNames = @('pi-web-watchdog', 'piweb-server', 'piweb-cloudflared', 'piweb-shi-openclaw', 'piweb-si-hermes')

Write-Host ''
Write-Host '元枢开机自启配置' -ForegroundColor Cyan

function New-AutostartTask {
  param([string]$TaskName, [string]$Execute, [string]$Arguments, [string]$WorkingDirectory)
  # 不用反引号续行：尾随空白或换行符会让续行静默失效，报错信息还完全指不到真因。
  $action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments -WorkingDirectory $WorkingDirectory
  # Boot 触发 + 每 5 分钟补一次（机器睡眠/异常后仍能被拉起来）
  $repeating = New-ScheduledTaskTrigger -Once -At ([datetime]'2026-08-26T00:00:00') -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 1)
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), $repeating)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $spec = @{
    TaskName  = $TaskName
    Action    = $action
    Trigger   = $triggers
    Settings  = $settings
    Principal = $principal
    Force     = $true
  }
  Register-ScheduledTask @spec | Out-Null
}

Write-Host '[1/1] 注册 yuanshu-watchdog（元枢主服务守护）…'
New-AutostartTask -TaskName 'yuanshu-watchdog' -Execute 'powershell.exe' -Arguments $nodeArgs -WorkingDirectory $root

# 注册成功才删旧名
$registered = Get-ScheduledTask -TaskName 'yuanshu-watchdog' -ErrorAction SilentlyContinue
if (-not $registered) { throw 'yuanshu-watchdog 注册失败，已中止（旧任务保持不动，不影响自启）' }
Write-Host '      yuanshu-watchdog OK' -ForegroundColor Green

foreach ($name in $legacyNames) {
  $old = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($old) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "      已清理旧任务 $name" -ForegroundColor DarkGray
  }
}

Write-Host ''
Write-Host '完成。当前元枢自启任务：' -ForegroundColor Green
Get-ScheduledTask -TaskName 'yuanshu-watchdog' | Select-Object TaskName, State | Format-Table -AutoSize
