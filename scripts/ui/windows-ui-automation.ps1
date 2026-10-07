param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath
)

$ErrorActionPreference = 'Stop'

function Write-Result {
  param([hashtable]$Value, [int]$ExitCode = 0)
  [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 12))
  exit $ExitCode
}

function Fail {
  param([string]$Code, [string]$Message)
  Write-Result -Value @{ ok = $false; code = $Code; error = $Message } -ExitCode 1
}

function Require-String {
  param($Value, [string]$Label, [int]$MaxLength = 1024)
  if ($null -eq $Value -or -not ($Value -is [string])) { throw "$Label must be a string." }
  $text = ([string]$Value).Trim()
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt $MaxLength) { throw "$Label is empty or too long." }
  return $text
}

function Bounded-Text {
  param($Value, [int]$MaxLength = 512)
  if ($null -eq $Value) { return '' }
  $text = [string]$Value
  if ($text.Length -gt $MaxLength) { return $text.Substring(0, $MaxLength) }
  return $text
}

function Test-IsElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Normalize-Path {
  param([string]$Value)
  return [IO.Path]::GetFullPath($Value).TrimEnd('\')
}

function Get-ControlType {
  param([string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
  switch ($Name.Trim().ToLowerInvariant()) {
    'button' { return [System.Windows.Automation.ControlType]::Button }
    'calendar' { return [System.Windows.Automation.ControlType]::Calendar }
    'checkbox' { return [System.Windows.Automation.ControlType]::CheckBox }
    'combobox' { return [System.Windows.Automation.ControlType]::ComboBox }
    'custom' { return [System.Windows.Automation.ControlType]::Custom }
    'dataitem' { return [System.Windows.Automation.ControlType]::DataItem }
    'document' { return [System.Windows.Automation.ControlType]::Document }
    'edit' { return [System.Windows.Automation.ControlType]::Edit }
    'group' { return [System.Windows.Automation.ControlType]::Group }
    'header' { return [System.Windows.Automation.ControlType]::Header }
    'headeritem' { return [System.Windows.Automation.ControlType]::HeaderItem }
    'hyperlink' { return [System.Windows.Automation.ControlType]::Hyperlink }
    'image' { return [System.Windows.Automation.ControlType]::Image }
    'list' { return [System.Windows.Automation.ControlType]::List }
    'listitem' { return [System.Windows.Automation.ControlType]::ListItem }
    'menu' { return [System.Windows.Automation.ControlType]::Menu }
    'menubar' { return [System.Windows.Automation.ControlType]::MenuBar }
    'menuitem' { return [System.Windows.Automation.ControlType]::MenuItem }
    'pane' { return [System.Windows.Automation.ControlType]::Pane }
    'progressbar' { return [System.Windows.Automation.ControlType]::ProgressBar }
    'radiobutton' { return [System.Windows.Automation.ControlType]::RadioButton }
    'scrollbar' { return [System.Windows.Automation.ControlType]::ScrollBar }
    'separator' { return [System.Windows.Automation.ControlType]::Separator }
    'slider' { return [System.Windows.Automation.ControlType]::Slider }
    'spinner' { return [System.Windows.Automation.ControlType]::Spinner }
    'splitbutton' { return [System.Windows.Automation.ControlType]::SplitButton }
    'statusbar' { return [System.Windows.Automation.ControlType]::StatusBar }
    'tab' { return [System.Windows.Automation.ControlType]::Tab }
    'tabitem' { return [System.Windows.Automation.ControlType]::TabItem }
    'table' { return [System.Windows.Automation.ControlType]::Table }
    'text' { return [System.Windows.Automation.ControlType]::Text }
    'thumb' { return [System.Windows.Automation.ControlType]::Thumb }
    'titlebar' { return [System.Windows.Automation.ControlType]::TitleBar }
    'toolbar' { return [System.Windows.Automation.ControlType]::ToolBar }
    'tree' { return [System.Windows.Automation.ControlType]::Tree }
    'treeitem' { return [System.Windows.Automation.ControlType]::TreeItem }
    'window' { return [System.Windows.Automation.ControlType]::Window }
    default { throw "Unsupported UI Automation controlType '$Name'." }
  }
}

function Element-Summary {
  param([System.Windows.Automation.AutomationElement]$Element, [int]$Depth = 0)
  $patterns = @()
  try {
    $patterns = @($Element.GetSupportedPatterns() | ForEach-Object {
      $name = $_.ProgrammaticName
      if ($name -match '^(.+?)Identifiers\.Pattern$') { $Matches[1] } else { $name }
    } | Select-Object -First 24)
  } catch {}
  $type = ''
  $processId = 0
  $name = ''
  $automationId = ''
  $className = ''
  $enabled = $false
  $offscreen = $true
  $keyboardFocusable = $false
  try { $type = ($Element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch {}
  try { $processId = [int]$Element.Current.ProcessId } catch {}
  try { $name = Bounded-Text $Element.Current.Name 512 } catch {}
  try { $automationId = Bounded-Text $Element.Current.AutomationId 256 } catch {}
  try { $className = Bounded-Text $Element.Current.ClassName 256 } catch {}
  try { $enabled = [bool]$Element.Current.IsEnabled } catch {}
  try { $offscreen = [bool]$Element.Current.IsOffscreen } catch {}
  try { $keyboardFocusable = [bool]$Element.Current.IsKeyboardFocusable } catch {}
  return @{
    depth = $Depth
    processId = $processId
    name = $name
    automationId = $automationId
    className = $className
    controlType = Bounded-Text $type 64
    enabled = $enabled
    offscreen = $offscreen
    keyboardFocusable = $keyboardFocusable
    patterns = $patterns
  }
}

function Resolve-TargetProcess {
  param([int]$ProcessId, [string]$ExpectedExecutablePath)
  if ($ProcessId -le 0) { throw 'processId must be a positive integer.' }
  $expected = Normalize-Path (Require-String $ExpectedExecutablePath 'expectedExecutablePath' 4096)
  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  if ($process.SessionId -ne (Get-Process -Id $PID).SessionId) { throw 'Target process is not in the current interactive Windows session.' }
  $actual = $process.Path
  if ([string]::IsNullOrWhiteSpace($actual)) { throw 'Target executable path is unavailable.' }
  if (-not [string]::Equals((Normalize-Path $actual), $expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Target process executable does not match expectedExecutablePath.'
  }
  return $process
}

function Get-TopWindowsForProcess {
  param([int]$ProcessId)
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId
  )
  return @([System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $condition
  ))
}

function Get-ProcessIdsForExecutable {
  param([string]$ExpectedExecutablePath)
  $expected = Normalize-Path (Require-String $ExpectedExecutablePath 'expectedExecutablePath' 4096)
  $session = (Get-Process -Id $PID).SessionId
  $ids = @()
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($ids.Count -ge 64) { break }
    try {
      if ($process.SessionId -ne $session) { continue }
      if ([string]::IsNullOrWhiteSpace($process.Path)) { continue }
      if ([string]::Equals((Normalize-Path $process.Path), $expected, [StringComparison]::OrdinalIgnoreCase)) {
        $ids += [int]$process.Id
      }
    } catch {}
  }
  return $ids
}

function Validate-Locator {
  param($Locator)
  if ($null -eq $Locator) { throw 'locator is required.' }
  $automationId = ''
  if ($null -ne $Locator.automationId) { $automationId = Require-String $Locator.automationId 'locator.automationId' 256 }
  $names = @()
  if ($null -ne $Locator.names) {
    foreach ($name in @($Locator.names)) {
      if ($names.Count -ge 8) { throw 'locator.names is limited to 8 exact aliases.' }
      $names += Require-String $name 'locator.names[]' 256
    }
  }
  if ([string]::IsNullOrWhiteSpace($automationId) -and $names.Count -eq 0) {
    throw 'locator requires automationId or at least one exact name alias.'
  }
  $controlType = $null
  if ($null -ne $Locator.controlType -and -not [string]::IsNullOrWhiteSpace([string]$Locator.controlType)) {
    $controlType = Get-ControlType ([string]$Locator.controlType)
  }
  $className = ''
  if ($null -ne $Locator.className -and -not [string]::IsNullOrWhiteSpace([string]$Locator.className)) {
    $className = Require-String $Locator.className 'locator.className' 256
  }
  return @{ automationId = $automationId; names = $names; controlType = $controlType; className = $className }
}

function Get-LocatorCondition {
  param($Locator)
  $parts = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
  if (-not [string]::IsNullOrWhiteSpace($Locator.automationId)) {
    $parts.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Locator.automationId
    )))
  } elseif ($Locator.names.Count -eq 1) {
    $parts.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $Locator.names[0]
    )))
  } elseif ($Locator.names.Count -gt 1) {
    $nameConditions = @($Locator.names | ForEach-Object {
      New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $_
      )
    })
    $parts.Add((New-Object System.Windows.Automation.OrCondition($nameConditions)))
  }
  if ($null -ne $Locator.controlType) {
    $parts.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $Locator.controlType
    )))
  }
  if (-not [string]::IsNullOrWhiteSpace($Locator.className)) {
    $parts.Add((New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, $Locator.className
    )))
  }
  if ($parts.Count -eq 1) { return $parts[0] }
  return New-Object System.Windows.Automation.AndCondition($parts.ToArray())
}

function Find-Matches {
  param([System.Windows.Automation.AutomationElement[]]$Roots, $Locator, [int]$MaxMatches = 32)
  $validated = Validate-Locator $Locator
  $condition = Get-LocatorCondition $validated
  $matches = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
  foreach ($root in $Roots) {
    if ($matches.Count -ge $MaxMatches) { break }
    try {
      foreach ($element in @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))) {
        if ($matches.Count -ge $MaxMatches) { break }
        if ($validated.names.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($validated.automationId)) {
          $name = ''
          try { $name = [string]$element.Current.Name } catch {}
          if ($validated.names -notcontains $name) { continue }
        }
        $matches.Add($element)
      }
    } catch {}
  }
  return @($matches)
}

function Find-Unique {
  param([System.Windows.Automation.AutomationElement[]]$Roots, $Locator)
  $matches = @(Find-Matches -Roots $Roots -Locator $Locator -MaxMatches 3)
  if ($matches.Count -eq 0) { throw 'UIA_ELEMENT_NOT_FOUND: semantic locator matched no element.' }
  if ($matches.Count -gt 1) { throw 'UIA_ELEMENT_AMBIGUOUS: semantic locator matched multiple elements.' }
  return $matches[0]
}

function Wait-Unique {
  param([System.Windows.Automation.AutomationElement[]]$Roots, $Locator, [int]$TimeoutMs)
  if ($TimeoutMs -lt 100 -or $TimeoutMs -gt 15000) { throw 'timeoutMs must be 100..15000.' }
  $deadline = [Environment]::TickCount64 + $TimeoutMs
  do {
    $matches = @(Find-Matches -Roots $Roots -Locator $Locator -MaxMatches 3)
    if ($matches.Count -eq 1) { return $matches[0] }
    if ($matches.Count -gt 1) { throw 'UIA_ELEMENT_AMBIGUOUS: semantic locator matched multiple elements.' }
    Start-Sleep -Milliseconds 100
  } while ([Environment]::TickCount64 -lt $deadline)
  throw 'UIA_ELEMENT_TIMEOUT: semantic locator did not become available.'
}

function Snapshot-Roots {
  param([System.Windows.Automation.AutomationElement[]]$Roots, [int]$MaxDepth, [int]$MaxNodes)
  if ($MaxDepth -lt 0 -or $MaxDepth -gt 12) { throw 'maxDepth must be 0..12.' }
  if ($MaxNodes -lt 1 -or $MaxNodes -gt 1024) { throw 'maxNodes must be 1..1024.' }
  $result = New-Object System.Collections.Generic.List[hashtable]
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  foreach ($root in $Roots) { if ($queue.Count -lt 32) { $queue.Enqueue(@($root, 0)) } }
  while ($queue.Count -gt 0 -and $result.Count -lt $MaxNodes) {
    $entry = $queue.Dequeue()
    $element = [System.Windows.Automation.AutomationElement]$entry[0]
    $depth = [int]$entry[1]
    try { $result.Add((Element-Summary -Element $element -Depth $depth)) } catch { continue }
    if ($depth -ge $MaxDepth) { continue }
    try {
      $child = $walker.GetFirstChild($element)
      $childCount = 0
      while ($null -ne $child -and $result.Count + $queue.Count -lt $MaxNodes -and $childCount -lt 256) {
        $queue.Enqueue(@($child, $depth + 1))
        $childCount += 1
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }
  return @($result)
}

try {
  if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) { throw 'Input request file was not found.' }
  $raw = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8
  if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 262144) { throw 'UI Automation request exceeds 256 KiB.' }
  $request = $raw | ConvertFrom-Json
  $action = Require-String $request.action 'action' 64

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $elevated = Test-IsElevated
  if ($action -eq 'status') {
    Write-Result -Value @{
      ok = $true; supported = $true; provider = 'windows-uia'; helperElevated = $elevated
      uiAccessEnabledByRwmcp = $false
      rootAvailable = ($null -ne [System.Windows.Automation.AutomationElement]::RootElement)
      allowedActions = @('status','windows','inspect','wait','invoke','set-value','select','toggle','expand','collapse','focus')
    }
  }

  if ($action -notin @('windows','inspect','wait','invoke','set-value','select','toggle','expand','collapse','focus')) {
    throw "Unsupported UI Automation action '$action'."
  }
  if ($elevated -and $action -notin @('windows','inspect','wait')) {
    throw 'UIA_ELEVATED_HELPER_REFUSED: semantic UI mutation is disabled when the helper is elevated.'
  }

  $expectedExecutablePath = Require-String $request.expectedExecutablePath 'expectedExecutablePath' 4096
  $processId = 0
  if ($null -ne $request.processId) { $processId = [int]$request.processId }
  $roots = @()
  if ($processId -gt 0) {
    [void](Resolve-TargetProcess -ProcessId $processId -ExpectedExecutablePath $expectedExecutablePath)
    $roots = @(Get-TopWindowsForProcess -ProcessId $processId)
  } else {
    foreach ($candidateId in @(Get-ProcessIdsForExecutable -ExpectedExecutablePath $expectedExecutablePath)) {
      foreach ($window in @(Get-TopWindowsForProcess -ProcessId $candidateId)) {
        if ($roots.Count -ge 32) { break }
        $roots += $window
      }
      if ($roots.Count -ge 32) { break }
    }
  }

  if ($action -eq 'windows') {
    Write-Result -Value @{ ok = $true; provider = 'windows-uia'; windowCount = $roots.Count; windows = @($roots | ForEach-Object { Element-Summary -Element $_ -Depth 0 }) }
  }
  if ($roots.Count -eq 0) { throw 'UIA_WINDOW_NOT_FOUND: no top-level window matched the expected executable.' }

  if ($action -eq 'inspect') {
    $maxDepth = if ($null -ne $request.maxDepth) { [int]$request.maxDepth } else { 6 }
    $maxNodes = if ($null -ne $request.maxNodes) { [int]$request.maxNodes } else { 512 }
    $nodes = @(Snapshot-Roots -Roots $roots -MaxDepth $maxDepth -MaxNodes $maxNodes)
    Write-Result -Value @{ ok = $true; provider = 'windows-uia'; windowCount = $roots.Count; nodeCount = $nodes.Count; truncated = ($nodes.Count -ge $maxNodes); nodes = $nodes }
  }

  $timeoutMs = if ($null -ne $request.timeoutMs) { [int]$request.timeoutMs } else { 5000 }
  $element = if ($action -eq 'wait') { Wait-Unique -Roots $roots -Locator $request.locator -TimeoutMs $timeoutMs } else { Find-Unique -Roots $roots -Locator $request.locator }

  if ($action -eq 'wait') {
    Write-Result -Value @{ ok = $true; provider = 'windows-uia'; element = Element-Summary -Element $element -Depth 0 }
  }
  if ($action -eq 'focus') {
    $element.SetFocus()
    Write-Result -Value @{ ok = $true; provider = 'windows-uia'; action = $action; element = Element-Summary -Element $element -Depth 0 }
  }

  $patternObject = $null
  switch ($action) {
    'invoke' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$patternObject)) { throw 'UIA_PATTERN_UNAVAILABLE: InvokePattern is not supported by the target element.' }
      ([System.Windows.Automation.InvokePattern]$patternObject).Invoke()
    }
    'set-value' {
      $value = if ($null -eq $request.value) { '' } else { [string]$request.value }
      if ($value.Length -gt 4096) { throw 'value is limited to 4096 UTF-16 code units.' }
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObject)) { throw 'UIA_PATTERN_UNAVAILABLE: ValuePattern is not supported by the target element.' }
      $valuePattern = [System.Windows.Automation.ValuePattern]$patternObject
      if ($valuePattern.Current.IsReadOnly) { throw 'UIA_VALUE_READ_ONLY: target element is read-only.' }
      $valuePattern.SetValue($value)
    }
    'select' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$patternObject)) { throw 'UIA_PATTERN_UNAVAILABLE: SelectionItemPattern is not supported by the target element.' }
      ([System.Windows.Automation.SelectionItemPattern]$patternObject).Select()
    }
    'toggle' {
      $desired = Require-String $request.toggleState 'toggleState' 32
      if ($desired -notin @('on','off','indeterminate')) { throw 'toggleState must be on, off or indeterminate.' }
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$patternObject)) { throw 'UIA_PATTERN_UNAVAILABLE: TogglePattern is not supported by the target element.' }
      $toggle = [System.Windows.Automation.TogglePattern]$patternObject
      $targetState = switch ($desired) { 'on' { [System.Windows.Automation.ToggleState]::On }; 'off' { [System.Windows.Automation.ToggleState]::Off }; default { [System.Windows.Automation.ToggleState]::Indeterminate } }
      for ($i = 0; $i -lt 3 -and $toggle.Current.ToggleState -ne $targetState; $i++) { $toggle.Toggle() }
      if ($toggle.Current.ToggleState -ne $targetState) { throw 'UIA_TOGGLE_REJECTED: target did not reach requested state.' }
    }
    'expand' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$patternObject)) { throw 'UIA_PATTERN_UNAVAILABLE: ExpandCollapsePattern is not supported by the target element.' }
      ([System.Windows.Automation.ExpandCollapsePattern]$patternObject).Expand()
    }
    'collapse' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$patternObject)) { throw 'UIA_PATTERN_UNAVAILABLE: ExpandCollapsePattern is not supported by the target element.' }
      ([System.Windows.Automation.ExpandCollapsePattern]$patternObject).Collapse()
    }
  }

  Write-Result -Value @{ ok = $true; provider = 'windows-uia'; action = $action; element = Element-Summary -Element $element -Depth 0 }
}
catch {
  Fail -Code 'WINDOWS_UIA_FAILED' -Message (Bounded-Text $_.Exception.Message 1024)
}
