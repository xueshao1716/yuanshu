# 图片文字识别（2026-11-21）：用 Windows 自带的 OCR（简体中文），输出 {width,height,lines:[{text,bounds}]} 的 JSON。
# 手机屏幕操作的兜底：微信/小程序/游戏读不到控件树时，靠截图识字拿到文字和位置。
param([string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null
$eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
$res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
$lines = foreach ($l in $res.Lines) {
  $x1 = ($l.Words | % { $_.BoundingRect.X } | Measure -Min).Minimum; $y1 = ($l.Words | % { $_.BoundingRect.Y } | Measure -Min).Minimum
  $x2 = ($l.Words | % { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure -Max).Maximum; $y2 = ($l.Words | % { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure -Max).Maximum
  [pscustomobject]@{ text = ($l.Words | % Text) -join ''; bounds = @([int]$x1, [int]$y1, [int]$x2, [int]$y2) }
}
@{ width = $dec.PixelWidth; height = $dec.PixelHeight; lines = @($lines) } | ConvertTo-Json -Depth 4 -Compress
