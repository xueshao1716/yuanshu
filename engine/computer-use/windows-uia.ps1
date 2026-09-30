# Data arrives on stdin; never evaluate model-provided code, keys or coordinates.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $allowed = @('notepad', 'calculatorapp', 'calculator', 'mspaint', 'wordpad')
  function DescribeWindow($element) {
    $current = $element.Current
    $process = Get-Process -Id $current.ProcessId -ErrorAction Stop
    $name = $process.ProcessName.ToLowerInvariant()
    if ($allowed -notcontains $name) { throw 'Unsupported application' }
    # Do not trust a process name alone. Only Windows-installed, signed applications.
    $location = [IO.Path]::GetFullPath($process.Path)
    $roots = @([IO.Path]::GetFullPath($env:SystemRoot) + '\', [IO.Path]::GetFullPath($env:ProgramFiles) + '\WindowsApps\', [IO.Path]::GetFullPath($env:ProgramFiles) + '\Windows NT\')
    if (-not ($roots | Where-Object { $location.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) { throw 'Unsupported application location' }
    $signature = Get-AuthenticodeSignature -LiteralPath $location
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Unverified application signature' }
    return @{ handle = [string]$current.NativeWindowHandle; pid = $current.ProcessId; started = $process.StartTime.ToUniversalTime().ToString('o'); title = $current.Name; process = $name }
  }
  function ResolveWindow($expected) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([long]$expected.handle))
    $actual = DescribeWindow $root
    foreach ($key in @('handle','pid','started','title','process')) {
      if ([string]$actual[$key] -cne [string]$expected.$key) { throw 'Window identity changed; observe again' }
    }
    return $root
  }
  function DescribeElement($element) {
    $c = $element.Current
    if ($c.IsPassword -or -not $c.IsEnabled -or $c.IsOffscreen) { return $null }
    $actions = @(); $value = ''; $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $actions += 'click' }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $value = [string]$pattern.Current.Value
      if (-not $pattern.Current.IsReadOnly) { $actions += 'type' }
    }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -and $pattern.Current.VerticallyScrollable) { $actions += 'scroll' }
    # Avoid partial text replacement: an oversized field is read-only in this adapter.
    if ($value.Length -gt 4000) { $value = $value.Substring(0,4000); $actions = @($actions | Where-Object { $_ -ne 'type' }) }
    $name = [string]$c.Name
    if ($name.Length -gt 500) { $name = $name.Substring(0,500) }
    return @{ id = (($element.GetRuntimeId()) -join '.'); name = $name; type = $c.ControlType.ProgrammaticName; value = $value; actions = @($actions) }
  }
  function CollectElements($root) {
    $result = [System.Collections.Generic.List[object]]::new()
    $queue = [System.Collections.Generic.Queue[object]]::new(); $queue.Enqueue($root)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $count = 0
    while ($queue.Count -gt 0 -and $count -lt 160) {
      $element = $queue.Dequeue(); $count++
      # Never cross into an embedded process or a password subtree.
      if ($element.Current.ProcessId -ne $root.Current.ProcessId -or $element.Current.IsPassword) { continue }
      $description = DescribeElement $element
      if ($null -ne $description) { $result.Add(@{ element = $element; description = $description }) }
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child -and $queue.Count -lt 160) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    }
    return $result.ToArray()
  }
  if ($request.mode -eq 'windows') {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $items = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $windows = @()
    foreach ($item in $items) { try { if (-not $item.Current.IsOffscreen) { $windows += DescribeWindow $item } } catch { } }
    @{ windows = @($windows) } | ConvertTo-Json -Depth 8 -Compress
  } elseif ($request.mode -eq 'observe' -or $request.mode -eq 'act') {
    $root = ResolveWindow $request.window
    $elements = @(CollectElements $root)
    if ($request.mode -eq 'observe') {
      @{ window = $request.window; elements = @($elements | ForEach-Object { $_.description }) } | ConvertTo-Json -Depth 8 -Compress
    } else {
      $match = @($elements | Where-Object { $_.description.id -ceq $request.target.id })
      if ($match.Count -ne 1) { throw 'Control disappeared; observe again' }
      $target = $match[0]; $description = $target.description
      foreach ($key in @('id','name','type','value')) { if ([string]$description[$key] -cne [string]$request.target.$key) { throw 'Control changed; observe again' } }
      if ($description.actions -notcontains $request.action) { throw 'Unsupported control action' }
      $null = ResolveWindow $request.window
      switch ($request.action) {
        'click' { $target.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
        'type' {
          if ($null -eq $request.text -or $request.text.Length -gt 2000) { throw 'Invalid input text' }
          $target.element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$request.text)
        }
        'scroll' {
          if ($request.direction -notin @('up','down')) { throw 'Invalid scroll direction' }
          $amount = if ($request.direction -eq 'up') { [System.Windows.Automation.ScrollAmount]::SmallDecrement } else { [System.Windows.Automation.ScrollAmount]::SmallIncrement }
          $target.element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Scroll([System.Windows.Automation.ScrollAmount]::NoAmount,$amount)
        }
        default { throw 'Unsupported action' }
      }
      @{ ok = $true; message = 'Action dispatched. Observe again to verify the result; do not blindly repeat.' } | ConvertTo-Json -Compress
    }
  } else { throw 'Unsupported request' }
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
