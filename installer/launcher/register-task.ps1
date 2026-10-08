# 元枢安装版：注册登录自启任务 yuanshu-watchdog（免管理员，当前用户、普通权限）。
# 失败时退回「启动」文件夹快捷方式，保证重启后服务还能起来。
# 本文件需保存为 UTF-8 with BOM（PS5.1 读无 BOM 中文脚本会乱码）。
param([string]$Root = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$node = Join-Path $Root 'runtime\node\node.exe'
$svc  = Join-Path $Root 'launcher\service.cjs'
$vbs  = Join-Path $Root 'launcher\run-hidden.vbs'
$user = "$env:USERDOMAIN\$env:USERNAME"
try {
  # 2026-10-08 用 wscript.exe 无窗口启动 node，避免托盘出现黑色控制台窗口
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('/B "' + $vbs + '"') -WorkingDirectory $Root
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $user), $repeat)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'yuanshu-watchdog' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
  Write-Output 'TASK_OK'
} catch {
  $startup = [Environment]::GetFolderPath('Startup')
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path $startup '元枢服务.lnk'))
  $lnk.TargetPath = Join-Path $Root 'launcher\yuanshu.exe'
  $lnk.Arguments = '--service-only'
  $lnk.WorkingDirectory = $Root
  $lnk.Save()
  # 2026-10-08 fallback 也改用 wscript 无窗口启动
  $startup = [Environment]::GetFolderPath('Startup')
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path $startup '元枢服务.lnk'))
  $lnk.TargetPath = 'wscript.exe'
  $lnk.Arguments = '/B "' + $vbs + '"'
  $lnk.WorkingDirectory = $Root
  $lnk.Save()
  Write-Output ('STARTUP_FALLBACK ' + $_.Exception.Message)
}
