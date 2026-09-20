# 环境变量重名清理（2026-09-20，抽成共享文件）
#
# 背景：Windows 里 HTTP_PROXY 和 http_proxy 是同一个键，但进程环境块里可能两份都在。
# PowerShell 5.1 的 Start-Process 复制环境块时会抛：
#   "已添加项。字典中的关键字:"NO_PROXY"所添加的关键字:"no_proxy""
# 表现是脚本一两秒就退出、什么都没发生，错误信息也不指向真正的构建。
#
# 这个坑撞过两次：
#   2026-09-18 安卓构建（run-android-build.ps1，那里还留着一份内联实现）
#   2026-09-20 桌面 NSIS 构建（nsis-build-child.ps1）
# 所以抽到这里，谁要 Start-Process 就先点源一次：. (Join-Path $PSScriptRoot 'ps-env-dedupe.ps1')
#
# 处理方式：三个代理变量统一只留大写一份，然后把小写那份删掉。
# 本文件含中文，必须保持 UTF-8 **with BOM**，否则 PowerShell 5.1 按 ANSI 解码会解析报错
# （tests/unit/powershell-encoding.test.mjs 守着这条）。

foreach ($pair in @(@('http_proxy', 'HTTP_PROXY'), @('https_proxy', 'HTTPS_PROXY'), @('no_proxy', 'NO_PROXY'))) {
  $lowerVal = [Environment]::GetEnvironmentVariable($pair[0], 'Process')
  $upperVal = [Environment]::GetEnvironmentVariable($pair[1], 'Process')
  try { Remove-Item -LiteralPath "Env:$($pair[0])" -ErrorAction SilentlyContinue } catch {}
  if (-not $upperVal -and $lowerVal) { [Environment]::SetEnvironmentVariable($pair[1], $lowerVal, 'Process') }
}
