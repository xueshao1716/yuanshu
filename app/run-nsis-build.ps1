$ErrorActionPreference = 'Stop'

# Proxy env vars may exist twice (NO_PROXY/no_proxy); PS5.1 Start-Process throws on that. Dedupe first.
. (Join-Path $PSScriptRoot 'ps-env-dedupe.ps1')
$dir = $PSScriptRoot
$workspaceRoot = if ($env:PI_WORKSPACE) { $env:PI_WORKSPACE } else { 'D:\pi-workspace' }
$cacheRoot = Join-Path $workspaceRoot '.build-cache'
New-Item -ItemType Directory -Force -Path (Join-Path $cacheRoot 'cargo'), (Join-Path $cacheRoot 'cargo-home'), (Join-Path $cacheRoot 'gradle'), (Join-Path $cacheRoot 'npm'), (Join-Path $cacheRoot 'tmp') | Out-Null
$env:CARGO_TARGET_DIR = Join-Path $cacheRoot 'cargo'
$env:CARGO_HOME = Join-Path $cacheRoot 'cargo-home'
$env:GRADLE_USER_HOME = Join-Path $cacheRoot 'gradle'
$env:npm_config_cache = Join-Path $cacheRoot 'npm'
$env:TEMP = Join-Path $cacheRoot 'tmp'
$env:TMP = Join-Path $cacheRoot 'tmp'
$log = Join-Path $dir 'tauri-build.log'
$exitFile = Join-Path $dir 'tauri-build.exit'
Remove-Item -LiteralPath $exitFile -Force -ErrorAction SilentlyContinue
$child = Join-Path $dir 'nsis-build-child.ps1'
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $child + '"')) -WindowStyle Hidden -PassThru
Write-Output ("STARTED PID=" + $p.Id)
