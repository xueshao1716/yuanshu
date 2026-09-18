param([switch]$ResumePackaging)
$ErrorActionPreference = 'Stop'
# 环境重名清理（2026-09-18 真机排查）：Windows 里 HTTP_PROXY 和 http_proxy 是同一个键，
# 但环境块里可能两份都在（本机都是 http://127.0.0.1:7890）→ PowerShell 5.1 的 Start-Process
# 复制环境时抛 "Item has already been added. Key: 'HTTP_PROXY' / Key being added: 'http_proxy'"，
# 表现就是"双击跑了、但一两秒就退出，什么都没发生"。统一只留大写一份再往下走。
foreach ($pair in @(@('http_proxy', 'HTTP_PROXY'), @('https_proxy', 'HTTPS_PROXY'), @('no_proxy', 'NO_PROXY'))) {
  $lowerVal = [Environment]::GetEnvironmentVariable($pair[0], 'Process')
  $upperVal = [Environment]::GetEnvironmentVariable($pair[1], 'Process')
  try { Remove-Item -LiteralPath "Env:$($pair[0])" -ErrorAction SilentlyContinue } catch {}
  if (-not $upperVal -and $lowerVal) { [Environment]::SetEnvironmentVariable($pair[1], $lowerVal, 'Process') }
}
$dir = $PSScriptRoot
$workspaceRoot = if ($env:PI_WORKSPACE) { $env:PI_WORKSPACE } else { 'D:\pi-workspace' }
$cacheRoot = Join-Path $workspaceRoot '.build-cache'
$rustBin = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo\bin'
$env:Path = $rustBin + ';' + $env:Path
$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'C:\Android\Sdk' }
$env:NDK_HOME = if ($env:NDK_HOME) { $env:NDK_HOME } else { Join-Path $env:ANDROID_HOME 'ndk\27.0.12077973' }
$env:CARGO_HOME = Join-Path $cacheRoot 'cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $cacheRoot 'cargo'
$env:GRADLE_USER_HOME = Join-Path $cacheRoot 'gradle'
$env:npm_config_cache = Join-Path $cacheRoot 'npm'
$env:TEMP = Join-Path $cacheRoot 'tmp'
$env:TMP = $env:TEMP
$env:CARGO_TERM_COLOR = 'never'
$log = Join-Path $dir 'android-build-024.log'
$errorLog = Join-Path $dir 'android-build-024-stderr.log'
$exitFile = Join-Path $dir 'android-build.exit'
$code = 1
try {
  New-Item -ItemType Directory -Force -Path $env:CARGO_HOME, $env:CARGO_TARGET_DIR, $env:GRADLE_USER_HOME, $env:TEMP | Out-Null
  if (-not $ResumePackaging) {
    $build = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', '"".\node_modules\.bin\tauri.cmd" android build --target aarch64 --apk --ci"') -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errorLog
    $null = $build.Handle
    $build.WaitForExit()
    $code = $build.ExitCode
  }
  $buildMessages = Get-Content -LiteralPath $errorLog -Raw
  $buildMessages = [regex]::Replace($buildMessages, ([char]27 + '\[[0-9;]*m'), '')
  if ($code -ne 0 -and $buildMessages.Contains('Creation symbolic link is not allowed') -and $buildMessages.Contains('Finished `release` profile')) {
    # Rust compilation succeeded. Windows without symlink privilege can package a verified copy instead.
    $nativeLib = Join-Path $env:CARGO_TARGET_DIR 'aarch64-linux-android\release\libyuanshu_lib.so'
    $androidDir = Join-Path $dir 'src-tauri\gen\android'
    $jniDir = Join-Path $androidDir 'app\src\main\jniLibs\arm64-v8a'
    $jniLib = Join-Path $jniDir 'libyuanshu_lib.so'
    if (-not (Test-Path -LiteralPath $nativeLib) -or (Get-Item -LiteralPath $nativeLib).Length -eq 0) { throw 'Compiled Android library is missing.' }
    if ((Test-Path -LiteralPath $jniLib) -and ((Get-Item -LiteralPath $jniLib).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected existing JNI symlink; inspect before replacing.' }
    New-Item -ItemType Directory -Force -Path $jniDir | Out-Null
    Copy-Item -LiteralPath $nativeLib -Destination $jniLib -Force
    $gradleLog = Join-Path $dir 'android-gradle-024.log'
    $gradleErrorLog = Join-Path $dir 'android-gradle-024-stderr.log'
    $gradle = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', '"".\gradlew.bat" --no-daemon assembleArm64Release testArm64ReleaseUnitTest -x rustBuildArm64Release"') -WorkingDirectory $androidDir -NoNewWindow -PassThru -RedirectStandardOutput $gradleLog -RedirectStandardError $gradleErrorLog
    $null = $gradle.Handle
    $gradle.WaitForExit()
    $code = $gradle.ExitCode
  }
} catch {
  $_ | Out-File -LiteralPath $log -Append -Encoding utf8
} finally {
  [IO.File]::WriteAllText($exitFile, $code.ToString())
}
exit $code
