$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$workspaceRoot = if ($env:PI_WORKSPACE) { $env:PI_WORKSPACE } else { 'D:\pi-workspace' }
$cacheRoot = Join-Path $workspaceRoot '.build-cache'
# Running this file directly (without run-nsis-build.ps1) leaves CARGO_TARGET_DIR empty,
# so tauri writes the bundle into src-tauri\target while the check below only looks in
# .build-cache -> a successful build is reported as "installer was not generated"
# (hit on 2026-09-18). Default it here so both entry points behave the same.
# NOTE: keep this file ASCII-only; wscript/powershell reads .ps1 as ANSI, and Chinese
# without a BOM breaks parsing (same trap as run-android-build.ps1).
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $cacheRoot 'cargo' }
if (-not $env:CARGO_HOME) { $env:CARGO_HOME = Join-Path $cacheRoot 'cargo-home' }
$log = Join-Path $dir 'tauri-build.log'
$errorLog = Join-Path $dir 'tauri-build-stderr.log'
$exitFile = Join-Path $dir 'tauri-build.exit'
$bundleDir = Join-Path $cacheRoot 'cargo\release\bundle\nsis'
$deliveryRootName = -join ([char]0x4EA4, [char]0x4ED8)
$deliveryName = -join ([char]0x5143, [char]0x67A2, [char]0x684C, [char]0x9762, [char]0x5BA2, [char]0x6237, [char]0x7AEF)
$deliverDir = Join-Path (Join-Path $workspaceRoot $deliveryRootName) $deliveryName

$code = 1
function Get-BuildHash([string]$file) {
  $stream = [IO.File]::OpenRead($file)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)) }
  finally { $stream.Dispose(); $sha.Dispose() }
}
try {
  # Native compiler progress uses stderr; redirect at process level so PS5 does not turn it into a terminating error.
  $build = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', '"".\node_modules\.bin\tauri.cmd" build --bundles nsis --ci"') -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errorLog
  # PS5 -Wait waits for an entire process job and can hang after NSIS has already exited.
  $null = $build.Handle
  $build.WaitForExit()
  $code = $build.ExitCode
  if ($code -eq 0) {
    $conf = Get-Content -LiteralPath (Join-Path $dir 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = $conf.productName + '_' + $conf.version + '_x64-setup.exe'
    $bundle = Join-Path $bundleDir $expected
    if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { throw 'Current-version installer was not generated.' }
    if ((Get-Item -LiteralPath $bundle).Length -eq 0) { throw 'Current-version installer is empty.' }
    New-Item -ItemType Directory -Force -Path $deliverDir | Out-Null
    Copy-Item -LiteralPath $bundle -Destination $deliverDir -Force
    $copy = Join-Path $deliverDir $expected
    if ((Get-BuildHash $bundle) -ne (Get-BuildHash $copy)) { throw 'Installer delivery checksum mismatch.' }
  }
} catch {
  $code = 1
  $_ | Out-File -FilePath $log -Append -Encoding utf8
} finally {
  [IO.File]::WriteAllText($exitFile, $code.ToString())
}
exit $code
