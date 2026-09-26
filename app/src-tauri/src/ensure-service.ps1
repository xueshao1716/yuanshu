$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Test-YuanshuHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2 -MaximumRedirection 0
    $ok = ($response.Content | ConvertFrom-Json).ok
    return ($response.StatusCode -eq 200 -and $ok -is [bool] -and $ok)
  } catch { return $false }
}
function Ensure-YuanshuService {
  if (Test-YuanshuHealth) { return 'READY' }
  try { $task = Get-ScheduledTask -TaskName 'yuanshu-watchdog' -ErrorAction Stop }
  catch { return 'TASK_UNAVAILABLE' }
  if ($task.State -eq 'Disabled') { return 'TASK_DISABLED' }
  try { Start-ScheduledTask -TaskName 'yuanshu-watchdog' -ErrorAction Stop }
  catch { return 'TASK_START_DENIED' }
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-YuanshuHealth) { return 'READY' }
    Start-Sleep -Milliseconds 750
  }
  return 'HEALTH_TIMEOUT'
}
Ensure-YuanshuService
