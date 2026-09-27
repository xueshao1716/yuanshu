$ErrorActionPreference = 'Stop'
$root = 'D:/pi-web'
$out = Join-Path $root 'output/imagegen/portrait-poses-diagnostic-20260927'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$token = (Get-Content -Raw (Join-Path $root '.token')).Trim()
$ref = Join-Path $root 'output/imagegen/yuanshu-cutout-green.png'
$refB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($ref))
$refData = "data:image/png;base64,$refB64"
$poseDir = Join-Path $root 'docs/superpowers/specs/portrait-poses'
$names = @('working','reading','resting','daydreaming','listening','responding')
$rows = @()
foreach ($name in $names) {
  $prompt = (Get-Content -Raw (Join-Path $poseDir "$name.txt")).Trim()
  $body = @{ provider='aieyra'; modelId='gpt-image-2.5-sunburst'; prompt=$prompt; size='1024x1536'; image=$refData } | ConvertTo-Json -Depth 4
  $started = Get-Date
  try {
    $resp = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/image' -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $body -TimeoutSec 240
    $data = [string]$resp.image
    if ($data.StartsWith('data:image/')) {
      $b64 = $data.Substring($data.IndexOf(',') + 1)
      $bytes = [Convert]::FromBase64String($b64)
    } elseif ($data -match '^https?://') {
      $download = Invoke-WebRequest -UseBasicParsing -Uri $data -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 60
      $bytes = $download.Content
      if ($bytes -is [string]) { $bytes = [Text.Encoding]::UTF8.GetBytes($bytes) }
    } else {
      throw "响应没有可下载的图片链接"
    }
    $path = Join-Path $out "$name.png"
    [IO.File]::WriteAllBytes($path, $bytes)
    $rows += [pscustomobject]@{ pose=$name; status='succeeded'; model='aieyra/gpt-image-2.5-sunburst'; bytes=$bytes.Length; seconds=[math]::Round(((Get-Date)-$started).TotalSeconds,1); file=$path }
    Write-Output "[$name] succeeded $($bytes.Length) bytes"
  } catch {
    $rows += [pscustomobject]@{ pose=$name; status='failed'; model='aieyra/gpt-image-2.5-sunburst'; bytes=0; seconds=[math]::Round(((Get-Date)-$started).TotalSeconds,1); error=$_.Exception.Message }
    Write-Output "[$name] FAILED $($_.Exception.Message)"
  }
}
$rows | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $out 'manifest.json')
Write-Output "MANIFEST $out/manifest.json"
