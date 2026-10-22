# 元枢：注册服务形态（Windows 服务 YuanShuService，需管理员）
# 2026-10-22（方案 B）：比计划任务更正规——无窗口、注销后仍在跑、可在服务管理器里看到。
# 用法（管理员 PowerShell）：
#   .\install-service.ps1 -Install            # 安装并启动（默认 LocalSystem，配合目录联接读取用户 agent 目录）
#   .\install-service.ps1 -Uninstall          # 停止并删除服务
#   .\install-service.ps1 -Status             # 只看状态
# 说明：LocalSystem 看不到用户目录，所以安装时会为 <systemprofile>\.pi 建目录联接，
#       并把 YUANSHU_CWD / YUANSHU_AGENT_DIR 写进机器级环境变量。卸载不会删数据。
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
$svcName = 'YuanShuService'
$host_ = Join-Path $Root 'launcher\YuanshuServiceHost.exe'
$agent = Join-Path $env:USERPROFILE '.pi'
$profileDir = 'C:\Windows\System32\config\systemprofile'

function IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (IsAdmin)) { Write-Output 'NEED_ADMIN'; exit 2 }

if ($Status -or -not ($Install -or $Uninstall)) {
  $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
  if ($s) { Write-Output ("SERVICE {0} {1}" -f $s.Name, $s.Status) } else { Write-Output 'SERVICE absent' }
  exit 0
}

if ($Uninstall) {
  if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
    & sc.exe stop $svcName | Out-Null
    Start-Sleep -Seconds 3
    & sc.exe delete $svcName | Out-Null
    Write-Output 'SERVICE_REMOVED'
  } else {
    Write-Output 'SERVICE_ABSENT'
  }
  exit 0
}

if (-not (Test-Path $host_)) { Write-Output 'HOST_MISSING'; exit 3 }

# 目录联接：让 SYSTEM 身份也能读到用户 agent 目录（auth.json / sessions）
$link = Join-Path $profileDir '.pi'
if (-not (Test-Path $link)) {
  & cmd /c mklink /J "`"$link`"" "`"$agent`"" | Out-Null
  Write-Output 'JUNCTION_OK'
}
[Environment]::SetEnvironmentVariable('YUANSHU_CWD', $env:YUANSHU_CWD, 'Machine')
[Environment]::SetEnvironmentVariable('YUANSHU_AGENT_DIR', (Join-Path $agent 'agent'), 'Machine')

if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
  & sc.exe stop $svcName | Out-Null
  Start-Sleep -Seconds 3
  & sc.exe delete $svcName | Out-Null
  Start-Sleep -Seconds 1
}

& sc.exe create $svcName binPath= "`"$host_`"" start= auto DisplayName= "元枢服务" | Out-Null
& sc.exe description $svcName "元枢本地工作台的后台服务（看护 server.mjs）" | Out-Null
& sc.exe failure $svcName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
# 允许交互用户启动/停止，这样桌面端「重启服务」不必每次 UAC
$sddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;RPWPDT;;;IU)S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)'
& sc.exe sdset $svcName $sddl | Out-Null
& sc.exe start $svcName | Out-Null
Start-Sleep -Seconds 2
$s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
Write-Output ("SERVICE_INSTALLED {0}" -f ($(if ($s) { $s.Status } else { 'unknown' })))
